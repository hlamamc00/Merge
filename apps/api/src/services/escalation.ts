/**
 * Decision 6 / DSP-01: a shift still open close to its start is escalated. Hosts choose AUTO (the platform
 * raises the rate within the host's ceiling and opens every tier) or MANUAL (the host is prompted and can
 * escalate with one click).
 */
import { and, eq, gt, lte } from 'drizzle-orm';
import { NotificationType, ShiftStatus } from '@merge/shared';
import type { Db } from '../db/client.js';
import { auditLog, organisations, shiftAccess, shifts, type PlatformSettingsRow, type Shift } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { conflict } from '../lib/errors.js';
import type { Notifier } from '../lib/notify.js';
import { notifyDueAccess } from './dispatch.js';

/** Hours before the start at which a step is due. */
export const ESCALATION_STEP_HOURS = [48, 24, 12] as const;
/** Automatic rate rise per step, as a percentage of the original rate. */
export const ESCALATION_STEP_PCT = 7;

export function stepDue(startsAt: Date, now: Date): number {
  const hoursToStart = (startsAt.getTime() - now.getTime()) / 3_600_000;
  return ESCALATION_STEP_HOURS.filter((h) => hoursToStart <= h).length;
}

const to5p = (n: number) => Math.round(n * 20) / 20;

/** Bring every organisation's access forward to now and clear notifications so the shift is re-announced. */
export function openAllTiers(db: Db, notifier: Notifier, shiftId: string, now: Date): number {
  const rows = db.select().from(shiftAccess).where(eq(shiftAccess.shiftId, shiftId)).all();
  for (const r of rows) {
    db.update(shiftAccess).set({ opensAt: r.opensAt.getTime() > now.getTime() ? now : r.opensAt, notifiedAt: null }).where(eq(shiftAccess.id, r.id)).run();
  }
  notifyDueAccess(db, notifier, now);
  return rows.length;
}

export interface EscalationResult {
  shift: Shift;
  previousRate: number;
  newRate: number;
  opened: boolean;
  step: number;
}

/**
 * Apply an escalation to one shift. `raiseRatePct` is relative to the current rate for manual escalations
 * and ignored for AUTO, which uses the fixed step against the original rate and the host's ceiling.
 */
export function escalateShift(
  db: Db,
  notifier: Notifier,
  shift: Shift,
  opts: { mode: 'AUTO' | 'MANUAL'; raiseRatePct?: number; openToAll?: boolean; ceilingPct?: number; actor?: { userId?: string | null; orgId?: string | null } },
  now: Date,
): EscalationResult {
  if (shift.status !== ShiftStatus.OPEN) throw conflict(`Shift is ${shift.status.toLowerCase().replace('_', ' ')}`);
  const original = shift.originalChargeRate ?? shift.chargeRate;
  const step = Math.max(shift.escalationStep + 1, stepDue(shift.startsAt, now));
  let newRate = shift.chargeRate;
  if (opts.mode === 'AUTO') {
    const ceiling = to5p(original * (1 + (opts.ceilingPct ?? 20) / 100));
    newRate = Math.min(ceiling, to5p(original * (1 + (ESCALATION_STEP_PCT * step) / 100)));
    newRate = Math.max(newRate, shift.chargeRate);
  } else if (opts.raiseRatePct && opts.raiseRatePct > 0) {
    newRate = to5p(shift.chargeRate * (1 + opts.raiseRatePct / 100));
  }
  const opened = opts.mode === 'AUTO' || !!opts.openToAll;
  db.update(shifts)
    .set({ chargeRate: newRate, originalChargeRate: original, escalationStep: step, lastEscalatedAt: now, updatedAt: now })
    .where(eq(shifts.id, shift.id))
    .run();
  if (opened) openAllTiers(db, notifier, shift.id, now);
  else if (newRate > shift.chargeRate) {
    db.update(shiftAccess).set({ notifiedAt: null }).where(and(eq(shiftAccess.shiftId, shift.id), lte(shiftAccess.opensAt, now))).run();
    notifyDueAccess(db, notifier, now);
  }
  audit(db, opts.actor ?? { orgId: shift.hostOrgId }, { action: 'UPDATE', entityType: 'shift', entityId: shift.id, data: { escalation: { mode: opts.mode, step, previousRate: shift.chargeRate, newRate, opened } } }, now);
  return { shift: db.select().from(shifts).where(eq(shifts.id, shift.id)).get()!, previousRate: shift.chargeRate, newRate, opened, step };
}

export interface EscalationEvent {
  at: Date;
  mode: 'AUTO' | 'MANUAL';
  step: number;
  previousRate: number;
  newRate: number;
  opened: boolean;
}

/** What has been done to this shift so far, oldest first (from the audit log). */
export function escalationHistory(db: Db, shiftId: string): EscalationEvent[] {
  return db
    .select({ data: auditLog.data, at: auditLog.createdAt })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'shift'), eq(auditLog.entityId, shiftId)))
    .orderBy(auditLog.createdAt)
    .all()
    .flatMap((r) => {
      const e = (r.data as { escalation?: Omit<EscalationEvent, 'at'> } | null)?.escalation;
      return e ? [{ at: r.at, ...e }] : [];
    });
}

/** Scheduler pass: escalate AUTO hosts' shifts, prompt MANUAL hosts, one step at a time. */
export function runEscalations(db: Db, notifier: Notifier, settings: PlatformSettingsRow, now: Date): { auto: number; prompted: number } {
  const horizon = new Date(now.getTime() + ESCALATION_STEP_HOURS[0] * 3_600_000);
  const open = db
    .select({ shift: shifts, mode: organisations.escalationMode, ceiling: organisations.escalationCeilingPct, hostName: organisations.name })
    .from(shifts)
    .innerJoin(organisations, eq(organisations.id, shifts.hostOrgId))
    .where(and(eq(shifts.status, ShiftStatus.OPEN), gt(shifts.startsAt, now), lte(shifts.startsAt, horizon)))
    .all();
  let auto = 0;
  let prompted = 0;
  for (const { shift, mode, ceiling } of open) {
    if (shift.filledCount >= shift.headcount) continue;
    const due = stepDue(shift.startsAt, now);
    if (due <= shift.escalationStep) continue;
    const hoursLeft = Math.round((shift.startsAt.getTime() - now.getTime()) / 3_600_000);
    if (mode === 'AUTO') {
      const r = escalateShift(db, notifier, shift, { mode: 'AUTO', ceilingPct: ceiling }, now);
      auto++;
      notifier.send({
        orgId: shift.hostOrgId,
        type: NotificationType.SHIFT_UNFILLED,
        title: `Escalated: ${shift.title} (${hoursLeft}h to go)`,
        body: r.newRate > r.previousRate ? `Rate raised from £${r.previousRate.toFixed(2)} to £${r.newRate.toFixed(2)}/h and the shift opened to every organisation.` : `Rate already at your ceiling; the shift was opened to every organisation.`,
        data: { shiftId: shift.id, kind: 'escalation', step: r.step, previousRate: r.previousRate, newRate: r.newRate },
      });
    } else {
      db.update(shifts).set({ escalationStep: due, lastEscalatedAt: now, updatedAt: now }).where(eq(shifts.id, shift.id)).run();
      prompted++;
      notifier.send({
        orgId: shift.hostOrgId,
        type: NotificationType.SHIFT_UNFILLED,
        title: `${shift.headcount - shift.filledCount} place(s) still open: ${shift.title} (${hoursLeft}h to go)`,
        body: `Escalate now: raise the rate by ${ESCALATION_STEP_PCT}% and open the shift to every organisation, or switch this organisation to automatic escalation in Settings.`,
        data: { shiftId: shift.id, kind: 'escalation-prompt', step: due, suggestedRaisePct: ESCALATION_STEP_PCT },
      });
    }
  }
  return { auto, prompted };
}
