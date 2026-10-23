import { and, eq, gt, inArray, isNull, lte, ne } from 'drizzle-orm';
import { JOB_ROLE_LABELS, NotificationType, ShiftStatus, floorChargeRate, minutesBetween, shiftPaidHours, type DocumentType, type JobRole, type ShiftVisibility, type Skill } from '@merge/shared';
import type { Db } from '../db/client.js';
import { hostRequirements, notifications, organisations, shiftAccess, shiftAssignments, shifts, sites, type PlatformSettingsRow, type Shift, type Site } from '../db/schema.js';
import { forbidden, notFound, unprocessable } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { Notifier } from '../lib/notify.js';
import { buildPlan, notifyDueAccess, persistPlan } from './dispatch.js';
import { releaseHoursFromFlag } from './capacity.js';
import { closeTimesheetForEndedBooking } from './timesheets.js';
import { declinePendingForShift } from './assignments.js';

/** Decision 3: platform-wide floor on the charge rate. */
export function floorRate(settings: PlatformSettingsRow): number {
  return floorChargeRate({ minimumWage: settings.nationalMinimumWage, employerOnCostPct: settings.employerOnCostPct, platformFeePct: settings.platformFeePct });
}

export function floorRateInfo(settings: PlatformSettingsRow) {
  return {
    floor: floorRate(settings),
    basis: {
      nationalMinimumWage: settings.nationalMinimumWage,
      employerOnCostPct: settings.employerOnCostPct,
      platformFeePct: settings.platformFeePct,
      formula: 'minimum wage × (1 + employer on-costs) ÷ (1 − platform fee), rounded up to 5p',
    },
  };
}

/** Nobody, platform admins included, may post below the floor: the worker's wage and the supplier's on-costs must be covered. */
export function assertRateAboveFloor(settings: PlatformSettingsRow, chargeRate: number): void {
  const info = floorRateInfo(settings);
  if (chargeRate + 1e-9 < info.floor) {
    throw unprocessable(`Charge rate £${chargeRate.toFixed(2)}/h is below the platform floor of £${info.floor.toFixed(2)}/h`, { floor: info.floor, basis: info.basis });
  }
}

/** Decisions 1 and 12: a host must be approved, not suspended and not on credit hold to publish. */
export function assertHostMayPublish(db: Db, hostOrgId: string, opts: { allowPending?: boolean } = {}): void {
  const host = db.select({ status: organisations.status, creditHold: organisations.creditHold, suspendedReason: organisations.suspendedReason }).from(organisations).where(eq(organisations.id, hostOrgId)).get();
  if (!host) throw notFound('Organisation');
  if (host.creditHold) throw forbidden('Posting is paused while platform invoices are overdue. Drafts are kept; publishing resumes once the account is settled');
  if (host.status === 'SUSPENDED') throw forbidden(`Your organisation is suspended from the network${host.suspendedReason ? `: ${host.suspendedReason}` : ''}`);
  if (host.status !== 'ACTIVE' && !opts.allowPending) throw forbidden('Your organisation is awaiting approval by the platform; you can save drafts but not publish');
}

export interface NewShiftData {
  siteId: string;
  jobRole: JobRole;
  title: string;
  description?: string | null;
  startsAt: Date;
  endsAt: Date;
  breakMinutes: number;
  headcount: number;
  requiredSkills: Skill[];
  extraRequiredDocuments: DocumentType[];
  chargeRate: number;
  visibility: ShiftVisibility;
  priorityWindowMinutesOverride?: number | null;
  autoConfirm: boolean;
  requiredHostRequirementIds?: string[];
}

/** Decision 11: a shift may only name requirements that belong to the host and are not archived. */
export function assertHostRequirementIds(db: Db, hostOrgId: string, ids: string[] | undefined): string[] {
  const wanted = Array.from(new Set(ids ?? []));
  if (wanted.length === 0) return [];
  const known = db
    .select({ id: hostRequirements.id })
    .from(hostRequirements)
    .where(and(eq(hostRequirements.hostOrgId, hostOrgId), inArray(hostRequirements.id, wanted), isNull(hostRequirements.archivedAt)))
    .all()
    .map((r) => r.id);
  const unknown = wanted.filter((id) => !known.includes(id));
  if (unknown.length) throw unprocessable('Unknown host requirement(s) on this shift', { requiredHostRequirementIds: unknown });
  return wanted;
}

/** Create a draft (and optionally publish it). Used by the shift route, series posting and copy. */
export function createShift(
  db: Db,
  notifier: Notifier,
  settings: PlatformSettingsRow,
  input: { hostOrgId: string; site: Site; data: NewShiftData; publish: boolean; createdByUserId: string | null; seriesId?: string | null; allowPending?: boolean },
  now: Date,
): Shift {
  const { data } = input;
  if (!(data.endsAt > data.startsAt)) throw unprocessable('endsAt must be after startsAt');
  if (data.startsAt.getTime() <= now.getTime()) throw unprocessable('Shift must start in the future');
  assertRateAboveFloor(settings, data.chargeRate);
  if (input.publish) assertHostMayPublish(db, input.hostOrgId, { allowPending: input.allowPending });
  const requiredHostRequirementIds = assertHostRequirementIds(db, input.hostOrgId, data.requiredHostRequirementIds);
  const id = newId('shf');
  db.insert(shifts)
    .values({
      id,
      hostOrgId: input.hostOrgId,
      siteId: input.site.id,
      jobRole: data.jobRole,
      title: data.title,
      description: data.description ?? null,
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      breakMinutes: data.breakMinutes,
      headcount: data.headcount,
      requiredSkills: data.requiredSkills,
      extraRequiredDocuments: data.extraRequiredDocuments,
      chargeRate: data.chargeRate,
      currency: settings.currency,
      visibility: data.visibility,
      priorityWindowMinutesOverride: data.priorityWindowMinutesOverride ?? null,
      autoConfirm: data.autoConfirm,
      requiredHostRequirementIds,
      seriesId: input.seriesId ?? null,
      status: ShiftStatus.DRAFT,
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const shift = db.select().from(shifts).where(eq(shifts.id, id)).get()!;
  return input.publish ? publishShift(db, notifier, settings, shift, input.site, now) : shift;
}

export function publishShift(db: Db, notifier: Notifier, settings: PlatformSettingsRow, shift: Shift, site: Site, now: Date): Shift {
  const plan = buildPlan(db, settings, shift, site, now, now);
  db.update(shifts)
    .set({ status: ShiftStatus.OPEN, publishedAt: now, urgent: plan.urgent, originalChargeRate: shift.originalChargeRate ?? shift.chargeRate, updatedAt: now })
    .where(eq(shifts.id, shift.id))
    .run();
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
      closeTimesheetForEndedBooking(db, a.id, reason ?? 'Shift cancelled by host', now);
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
  // The release plan is kept as the record of who was offered the shift and when.
  return db.select().from(shifts).where(eq(shifts.id, shift.id)).get()!;
}

/** Move shifts through time-based states. Called by the scheduler. */
export function progressShifts(db: Db, notifier: Notifier, now: Date): { started: number; completed: number; expired: number } {
  let started = 0;
  let completed = 0;
  let expired = 0;

  const dueToStart = db.select().from(shifts).where(and(inArray(shifts.status, [ShiftStatus.OPEN, ShiftStatus.FILLED]), lte(shifts.startsAt, now))).all();
  for (const s of dueToStart) {
    // Requests and offers that were never answered are closed so they stop counting as booked time for the worker.
    declinePendingForShift(db, notifier, s, 'Shift started without confirmation', now);
    if (s.filledCount > 0) {
      db.update(shifts).set({ status: ShiftStatus.IN_PROGRESS, updatedAt: now }).where(eq(shifts.id, s.id)).run();
      started++;
    } else {
      db.update(shifts).set({ status: ShiftStatus.EXPIRED, updatedAt: now }).where(eq(shifts.id, s.id)).run();
      notifier.send({ orgId: s.hostOrgId, type: NotificationType.SHIFT_UNFILLED, title: `Shift went unfilled: ${s.title}`, body: `No worker was confirmed before the shift started at ${s.startsAt.toISOString()}.`, data: { shiftId: s.id } });
      expired++;
    }
    // Access rows are kept: listings filter on shift status, and the plan is the audit trail of what was done.
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
