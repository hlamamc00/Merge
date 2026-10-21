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

export function deleteDraftTimesheet(db: Db, assignmentId: string): void {
  db.delete(timesheets).where(and(eq(timesheets.assignmentId, assignmentId), eq(timesheets.status, TimesheetStatus.DRAFT))).run();
}

function recompute(ts: Timesheet, clockInAt: Date, clockOutAt: Date, breakMinutes: number) {
  const paidHours = shiftPaidHours(clockInAt, clockOutAt, breakMinutes);
  const money = computeShiftFinancials({ chargeRate: ts.chargeRate, hours: paidHours, platformFeePct: ts.platformFeePct });
  return { paidHours, hostCost: money.hostCost, platformFee: money.platformFee, supplierAmount: money.supplierReceives };
}

export function clockIn(db: Db, ts: Timesheet, at: Date, geo: { lat?: number | null; lng?: number | null }, now: Date): Timesheet {
  if (ts.status !== TimesheetStatus.DRAFT) throw conflict('Timesheet is no longer editable');
  if (ts.clockInAt) throw conflict('Already clocked in');
  db.update(timesheets).set({ clockInAt: at, clockInLat: geo.lat ?? null, clockInLng: geo.lng ?? null, updatedAt: now }).where(eq(timesheets.id, ts.id)).run();
  return get(db, ts.id);
}

export function clockOut(db: Db, notifier: Notifier, ts: Timesheet, at: Date, breakMinutes: number | undefined, now: Date): Timesheet {
  if (ts.status !== TimesheetStatus.DRAFT) throw conflict('Timesheet is no longer editable');
  if (!ts.clockInAt) throw unprocessable('Clock in before clocking out');
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
