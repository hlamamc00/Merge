import { and, eq, gt, inArray, lte, ne } from 'drizzle-orm';
import { JOB_ROLE_LABELS, NotificationType, ShiftStatus, minutesBetween } from '@merge/shared';
import type { Db } from '../db/client.js';
import { notifications, organisations, shiftAccess, shiftAssignments, shifts, sites, type PlatformSettingsRow, type Shift, type Site } from '../db/schema.js';
import type { Notifier } from '../lib/notify.js';
import { buildPlan, notifyDueAccess, persistPlan } from './dispatch.js';
import { releaseHoursFromFlag } from './capacity.js';
import { shiftPaidHours } from '@merge/shared';
import { deleteDraftTimesheet } from './timesheets.js';

export function publishShift(db: Db, notifier: Notifier, settings: PlatformSettingsRow, shift: Shift, site: Site, now: Date): Shift {
  const plan = buildPlan(db, settings, shift, site, now, now);
  db.update(shifts).set({ status: ShiftStatus.OPEN, publishedAt: now, urgent: plan.urgent, updatedAt: now }).where(eq(shifts.id, shift.id)).run();
  persistPlan(db, plan);
  notifyDueAccess(db, notifier, now);
  return db.select().from(shifts).where(eq(shifts.id, shift.id)).get()!;
}

export function cancelShift(db: Db, notifier: Notifier, shift: Shift, reason: string | null, now: Date): Shift {
  const live = db
    .select()
    .from(shiftAssignments)
    .where(and(eq(shiftAssignments.shiftId, shift.id), inArray(shiftAssignments.status, ['REQUESTED', 'OFFERED', 'CONFIRMED'])))
    .all();
  const host = db.select().from(organisations).where(eq(organisations.id, shift.hostOrgId)).get();
  const hours = shiftPaidHours(shift.startsAt, shift.endsAt, shift.breakMinutes);
  for (const a of live) {
    db.update(shiftAssignments)
      .set({ status: 'CANCELLED', cancelledAt: now, cancelledByOrgId: shift.hostOrgId, cancellationReason: reason ?? 'Shift cancelled by host', lateCancellation: false, updatedAt: now })
      .where(eq(shiftAssignments.id, a.id))
      .run();
    if (a.status === 'CONFIRMED') {
      releaseHoursFromFlag(db, a.matchedFlagId, hours, now);
      deleteDraftTimesheet(db, a.id);
    }
    notifier.send({
      orgId: a.supplierOrgId,
      type: NotificationType.SHIFT_CANCELLED,
      title: `Shift cancelled: ${shift.title}`,
      body: `${host?.name ?? 'The host'} cancelled the ${JOB_ROLE_LABELS[shift.jobRole]} shift on ${shift.startsAt.toISOString()}${reason ? `: ${reason}` : ''}.`,
      data: { shiftId: shift.id, assignmentId: a.id },
    });
  }
  db.update(shifts).set({ status: ShiftStatus.CANCELLED, cancelledAt: now, cancellationReason: reason, updatedAt: now }).where(eq(shifts.id, shift.id)).run();
  db.delete(shiftAccess).where(eq(shiftAccess.shiftId, shift.id)).run();
  return db.select().from(shifts).where(eq(shifts.id, shift.id)).get()!;
}

/** Move shifts through time-based states. Called by the scheduler. */
export function progressShifts(db: Db, notifier: Notifier, now: Date): { started: number; completed: number; expired: number } {
  let started = 0;
  let completed = 0;
  let expired = 0;

  const dueToStart = db.select().from(shifts).where(and(inArray(shifts.status, [ShiftStatus.OPEN, ShiftStatus.FILLED]), lte(shifts.startsAt, now))).all();
  for (const s of dueToStart) {
    if (s.filledCount > 0) {
      db.update(shifts).set({ status: ShiftStatus.IN_PROGRESS, updatedAt: now }).where(eq(shifts.id, s.id)).run();
      started++;
    } else {
      db.update(shifts).set({ status: ShiftStatus.EXPIRED, updatedAt: now }).where(eq(shifts.id, s.id)).run();
      // Pending requests that never got confirmed are closed off.
      db.update(shiftAssignments)
        .set({ status: 'DECLINED', respondedAt: now, note: 'Shift started without confirmation', updatedAt: now })
        .where(and(eq(shiftAssignments.shiftId, s.id), inArray(shiftAssignments.status, ['REQUESTED', 'OFFERED'])))
        .run();
      notifier.send({ orgId: s.hostOrgId, type: NotificationType.SHIFT_UNFILLED, title: `Shift went unfilled: ${s.title}`, body: `No worker was confirmed before the shift started at ${s.startsAt.toISOString()}.`, data: { shiftId: s.id } });
      expired++;
    }
    db.delete(shiftAccess).where(eq(shiftAccess.shiftId, s.id)).run();
  }

  const dueToEnd = db.select().from(shifts).where(and(eq(shifts.status, ShiftStatus.IN_PROGRESS), lte(shifts.endsAt, now))).all();
  for (const s of dueToEnd) {
    db.update(shifts).set({ status: ShiftStatus.COMPLETED, updatedAt: now }).where(eq(shifts.id, s.id)).run();
    completed++;
  }
  return { started, completed, expired };
}

/** Warn hosts about shifts starting soon that still have places open (once per shift). */
export function warnUnfilledSoon(db: Db, notifier: Notifier, now: Date, withinMinutes = 24 * 60): number {
  const soon = db
    .select()
    .from(shifts)
    .where(and(eq(shifts.status, ShiftStatus.OPEN), gt(shifts.startsAt, now), lte(shifts.startsAt, new Date(now.getTime() + withinMinutes * 60_000))))
    .all();
  let sent = 0;
  for (const s of soon) {
    if (s.filledCount >= s.headcount) continue;
    const alreadyWarned = db
      .select({ data: notifications.data })
      .from(notifications)
      .where(and(eq(notifications.orgId, s.hostOrgId), eq(notifications.type, NotificationType.SHIFT_UNFILLED)))
      .all()
      .some((n) => (n.data as { shiftId?: string; kind?: string } | null)?.shiftId === s.id && (n.data as { kind?: string } | null)?.kind === 'warning');
    if (alreadyWarned) continue;
    const mins = Math.round(minutesBetween(now, s.startsAt));
    notifier.send({
      orgId: s.hostOrgId,
      type: NotificationType.SHIFT_UNFILLED,
      title: `Still ${s.headcount - s.filledCount} place(s) open: ${s.title}`,
      body: `The shift starts in ${Math.floor(mins / 60)}h ${mins % 60}m. Consider raising the charge rate, widening visibility or contacting the agency bank.`,
      data: { shiftId: s.id, kind: 'warning' },
    });
    sent++;
  }
  return sent;
}

export function loadSiteForOrg(db: Db, siteId: string, orgId: string): Site | undefined {
  return db.select().from(sites).where(and(eq(sites.id, siteId), eq(sites.orgId, orgId))).get();
}

export function otherLiveAssignments(db: Db, shiftId: string, exceptId: string) {
  return db
    .select()
    .from(shiftAssignments)
    .where(and(eq(shiftAssignments.shiftId, shiftId), ne(shiftAssignments.id, exceptId), inArray(shiftAssignments.status, ['REQUESTED', 'OFFERED'])))
    .all();
}
