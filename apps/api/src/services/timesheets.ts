import { and, eq } from 'drizzle-orm';
import { NotificationType, TimesheetStatus, computeShiftFinancials, shiftPaidHours } from '@merge/shared';
import type { Db } from '../db/client.js';
import { shiftAssignments, timesheets, type PlatformSettingsRow, type Shift, type ShiftAssignment, type Timesheet } from '../db/schema.js';
import { conflict, unprocessable } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { Notifier } from '../lib/notify.js';

export function createDraftTimesheet(db: Db, settings: PlatformSettingsRow, shift: Shift, assignment: ShiftAssignment, now: Date): Timesheet {
  const id = newId('ts');
  db.insert(timesheets)
    .values({
      id,
      assignmentId: assignment.id,
      shiftId: shift.id,
      workerId: assignment.workerId,
      hostOrgId: shift.hostOrgId,
      supplierOrgId: assignment.supplierOrgId,
      breakMinutes: shift.breakMinutes,
      paidHours: 0,
      chargeRate: shift.chargeRate,
      platformFeePct: settings.platformFeePct,
      status: TimesheetStatus.DRAFT,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return db.select().from(timesheets).where(eq(timesheets.id, id)).get()!;
}

/**
 * When a booking ends abnormally (cancelled, no-show, shift cancelled) its timesheet must not be payable:
 * drafts are deleted, submitted/disputed ones are rejected. Approved timesheets are left alone; money
 * already owed is corrected on the statement, not by rewriting history.
 */
export function closeTimesheetForEndedBooking(db: Db, assignmentId: string, reason: string, now: Date): void {
  const ts = db.select().from(timesheets).where(eq(timesheets.assignmentId, assignmentId)).get();
  if (!ts) return;
  if (ts.status === TimesheetStatus.DRAFT) {
    db.delete(timesheets).where(eq(timesheets.id, ts.id)).run();
  } else if (ts.status === TimesheetStatus.SUBMITTED || ts.status === TimesheetStatus.DISPUTED) {
    db.update(timesheets).set({ status: TimesheetStatus.REJECTED, disputedAt: now, disputeReason: reason, updatedAt: now }).where(eq(timesheets.id, ts.id)).run();
  }
}

/** Times can only be recorded, submitted or approved while the booking is still a confirmed one. */
function assertBookingLive(db: Db, ts: Timesheet): void {
  const assignment = db.select({ status: shiftAssignments.status }).from(shiftAssignments).where(eq(shiftAssignments.id, ts.assignmentId)).get();
  if (!assignment || assignment.status !== 'CONFIRMED') throw conflict(`The booking is ${assignment ? assignment.status.toLowerCase().replace('_', ' ') : 'missing'}; its timesheet cannot be processed`);
}

function recompute(ts: Timesheet, clockInAt: Date, clockOutAt: Date, breakMinutes: number) {
  const paidHours = shiftPaidHours(clockInAt, clockOutAt, breakMinutes);
  const money = computeShiftFinancials({ chargeRate: ts.chargeRate, hours: paidHours, platformFeePct: ts.platformFeePct });
  return { paidHours, hostCost: money.hostCost, platformFee: money.platformFee, supplierAmount: money.supplierReceives };
}

export function clockIn(db: Db, ts: Timesheet, at: Date, geo: { lat?: number | null; lng?: number | null }, now: Date): Timesheet {
  if (ts.status !== TimesheetStatus.DRAFT) throw conflict('Timesheet is no longer editable');
  if (ts.clockInAt) throw conflict('Already clocked in');
  assertBookingLive(db, ts);
  db.update(timesheets).set({ clockInAt: at, clockInLat: geo.lat ?? null, clockInLng: geo.lng ?? null, updatedAt: now }).where(eq(timesheets.id, ts.id)).run();
  return get(db, ts.id);
}

export function clockOut(db: Db, notifier: Notifier, ts: Timesheet, at: Date, breakMinutes: number | undefined, now: Date): Timesheet {
  if (ts.status !== TimesheetStatus.DRAFT) throw conflict('Timesheet is no longer editable');
  if (!ts.clockInAt) throw unprocessable('Clock in before clocking out');
  assertBookingLive(db, ts);
  if (at.getTime() <= ts.clockInAt.getTime()) throw unprocessable('Clock-out must be after clock-in');
  const breaks = breakMinutes ?? ts.breakMinutes;
  db.update(timesheets)
    .set({ clockOutAt: at, breakMinutes: breaks, ...recompute(ts, ts.clockInAt, at, breaks), status: TimesheetStatus.SUBMITTED, submittedAt: now, updatedAt: now })
    .where(eq(timesheets.id, ts.id))
    .run();
  notifySubmitted(db, notifier, get(db, ts.id));
  return get(db, ts.id);
}

/** Manual entry/correction by the supplier (or worker) before approval, or after a dispute. */
export function submitTimes(db: Db, notifier: Notifier, ts: Timesheet, input: { clockInAt: Date; clockOutAt: Date; breakMinutes: number; notes?: string | null }, now: Date): Timesheet {
  if (ts.status !== TimesheetStatus.DRAFT && ts.status !== TimesheetStatus.DISPUTED && ts.status !== TimesheetStatus.SUBMITTED) throw conflict('Timesheet is no longer editable');
  if (input.clockOutAt.getTime() <= input.clockInAt.getTime()) throw unprocessable('Clock-out must be after clock-in');
  assertBookingLive(db, ts);
  db.update(timesheets)
    .set({
      clockInAt: input.clockInAt,
      clockOutAt: input.clockOutAt,
      breakMinutes: input.breakMinutes,
      notes: input.notes ?? ts.notes,
      ...recompute(ts, input.clockInAt, input.clockOutAt, input.breakMinutes),
      status: TimesheetStatus.SUBMITTED,
      submittedAt: now,
      disputedAt: null,
      disputeReason: null,
      updatedAt: now,
    })
    .where(eq(timesheets.id, ts.id))
    .run();
  notifySubmitted(db, notifier, get(db, ts.id));
  return get(db, ts.id);
}

export function approve(db: Db, notifier: Notifier, ts: Timesheet, userId: string, now: Date): Timesheet {
  if (ts.status !== TimesheetStatus.SUBMITTED && ts.status !== TimesheetStatus.DISPUTED) throw conflict('Only submitted timesheets can be approved');
  assertBookingLive(db, ts);
  db.update(timesheets).set({ status: TimesheetStatus.APPROVED, approvedAt: now, approvedByUserId: userId, updatedAt: now }).where(eq(timesheets.id, ts.id)).run();
  db.update(shiftAssignments).set({ status: 'COMPLETED', updatedAt: now }).where(eq(shiftAssignments.id, ts.assignmentId)).run();
  const updated = get(db, ts.id);
  notifier.send({
    orgId: ts.supplierOrgId,
    type: NotificationType.TIMESHEET_APPROVED,
    title: 'Timesheet approved',
    body: `${updated.paidHours}h approved · you will receive £${updated.supplierAmount.toFixed(2)} on the next statement.`,
    data: { timesheetId: ts.id, shiftId: ts.shiftId },
  });
  return updated;
}

export function dispute(db: Db, notifier: Notifier, ts: Timesheet, reason: string, now: Date): Timesheet {
  if (ts.status !== TimesheetStatus.SUBMITTED) throw conflict('Only submitted timesheets can be disputed');
  assertBookingLive(db, ts);
  db.update(timesheets).set({ status: TimesheetStatus.DISPUTED, disputedAt: now, disputeReason: reason, updatedAt: now }).where(eq(timesheets.id, ts.id)).run();
  notifier.send({ orgId: ts.supplierOrgId, type: NotificationType.TIMESHEET_DISPUTED, title: 'Timesheet disputed', body: reason, data: { timesheetId: ts.id, shiftId: ts.shiftId } });
  return get(db, ts.id);
}

export function reject(db: Db, notifier: Notifier, ts: Timesheet, reason: string, now: Date): Timesheet {
  if (ts.status === TimesheetStatus.APPROVED) throw conflict('Approved timesheets cannot be rejected; raise a credit on the statement instead');
  db.update(timesheets).set({ status: TimesheetStatus.REJECTED, disputedAt: now, disputeReason: reason, updatedAt: now }).where(eq(timesheets.id, ts.id)).run();
  notifier.send({ orgId: ts.supplierOrgId, type: NotificationType.TIMESHEET_DISPUTED, title: 'Timesheet rejected', body: reason, data: { timesheetId: ts.id, shiftId: ts.shiftId } });
  return get(db, ts.id);
}

function notifySubmitted(db: Db, notifier: Notifier, ts: Timesheet): void {
  notifier.send({
    orgId: ts.hostOrgId,
    type: NotificationType.TIMESHEET_SUBMITTED,
    title: 'Timesheet awaiting approval',
    body: `${ts.paidHours}h submitted · £${ts.hostCost.toFixed(2)}`,
    data: { timesheetId: ts.id, shiftId: ts.shiftId },
  });
}

export function get(db: Db, id: string): Timesheet {
  return db.select().from(timesheets).where(eq(timesheets.id, id)).get()!;
}

// ---------- Exceptions, bulk approval and auto-approval (finance build) ----------

export type TimesheetException = 'OVER_LENGTH' | 'MISSING_CLOCK_OUT' | 'LATE_CLOCK_IN' | 'SUBMITTED_LATE';

const OVER_LENGTH_TOLERANCE_HOURS = 0.5;
const LATE_CLOCK_IN_MINUTES = 15;
const SUBMITTED_LATE_DAYS = 7;

/** Things an approver should look at before signing off: computed from the timesheet against its shift. */
export function timesheetExceptions(ts: Pick<Timesheet, 'paidHours' | 'clockInAt' | 'clockOutAt' | 'submittedAt' | 'status'>, shift: Pick<Shift, 'startsAt' | 'endsAt' | 'breakMinutes'>, now: Date): TimesheetException[] {
  const out: TimesheetException[] = [];
  const scheduled = shiftPaidHours(shift.startsAt, shift.endsAt, shift.breakMinutes);
  if (ts.paidHours > scheduled + OVER_LENGTH_TOLERANCE_HOURS) out.push('OVER_LENGTH');
  if (ts.status === TimesheetStatus.DRAFT && ts.clockInAt && !ts.clockOutAt && shift.endsAt.getTime() < now.getTime()) out.push('MISSING_CLOCK_OUT');
  if (ts.clockInAt && ts.clockInAt.getTime() > shift.startsAt.getTime() + LATE_CLOCK_IN_MINUTES * 60_000) out.push('LATE_CLOCK_IN');
  if (ts.submittedAt && ts.submittedAt.getTime() > shift.endsAt.getTime() + SUBMITTED_LATE_DAYS * 86_400_000) out.push('SUBMITTED_LATE');
  return out;
}

export interface BulkApproveResult {
  id: string;
  ok: boolean;
  status?: Timesheet['status'];
  error?: string;
}

/** Approve many at once; one failure (wrong status, ended booking, not yours) never blocks the rest. */
export function bulkApprove(db: Db, notifier: Notifier, ids: string[], canApprove: (ts: Timesheet) => boolean, userId: string, now: Date): BulkApproveResult[] {
  return ids.map((id) => {
    const ts = db.select().from(timesheets).where(eq(timesheets.id, id)).get();
    if (!ts) return { id, ok: false, error: 'Timesheet not found' };
    if (!canApprove(ts)) return { id, ok: false, error: 'Not yours to approve' };
    try {
      const updated = approve(db, notifier, ts, userId, now);
      return { id, ok: true, status: updated.status };
    } catch (err) {
      return { id, ok: false, status: ts.status, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/**
 * Timesheets left in SUBMITTED for `days` are approved automatically so suppliers are not kept waiting on a
 * host that never looks (decision 3: hosts choose manual approval but the default cannot be "never").
 * Both sides are told. Timesheets whose booking is no longer confirmed are left for a person.
 */
export function autoApproveStaleTimesheets(db: Db, notifier: Notifier, now: Date, days = 14): Timesheet[] {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const stale = db.select().from(timesheets).where(eq(timesheets.status, TimesheetStatus.SUBMITTED)).all().filter((t) => t.submittedAt && t.submittedAt.getTime() <= cutoff.getTime());
  const done: Timesheet[] = [];
  for (const ts of stale) {
    const assignment = db.select({ status: shiftAssignments.status }).from(shiftAssignments).where(eq(shiftAssignments.id, ts.assignmentId)).get();
    if (!assignment || assignment.status !== 'CONFIRMED') continue;
    const note = `Auto-approved ${now.toISOString().slice(0, 10)}: no host decision within ${days} days of submission.`;
    db.update(timesheets)
      .set({ status: TimesheetStatus.APPROVED, approvedAt: now, approvedByUserId: null, notes: ts.notes ? `${ts.notes}\n${note}` : note, updatedAt: now })
      .where(eq(timesheets.id, ts.id))
      .run();
    db.update(shiftAssignments).set({ status: 'COMPLETED', updatedAt: now }).where(eq(shiftAssignments.id, ts.assignmentId)).run();
    const updated = get(db, ts.id);
    notifier.send({ orgId: ts.hostOrgId, type: NotificationType.TIMESHEET_APPROVED, title: 'Timesheet auto-approved', body: `${updated.paidHours}h (£${updated.hostCost.toFixed(2)}) was approved automatically after ${days} days without a decision. Query it on the statement if it is wrong.`, data: { timesheetId: ts.id, shiftId: ts.shiftId, auto: true } });
    notifier.send({ orgId: ts.supplierOrgId, type: NotificationType.TIMESHEET_APPROVED, title: 'Timesheet approved', body: `${updated.paidHours}h approved automatically · you will receive £${updated.supplierAmount.toFixed(2)} on the next remittance.`, data: { timesheetId: ts.id, shiftId: ts.shiftId, auto: true } });
    done.push(updated);
  }
  return done;
}
