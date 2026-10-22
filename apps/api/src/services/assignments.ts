import { and, eq, inArray, lte } from 'drizzle-orm';
import { AssignmentStatus, JOB_ROLE_LABELS, NotificationType, ShiftStatus, hoursBetween, shiftPaidHours } from '@merge/shared';
import type { Db } from '../db/client.js';
import { organisations, shiftAccess, shiftAssignments, shifts, workers, type PlatformSettingsRow, type Shift, type ShiftAssignment, type Site, type Worker } from '../db/schema.js';
import { conflict, unprocessable } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { Notifier } from '../lib/notify.js';
import { applyHoursToFlag, releaseHoursFromFlag } from './capacity.js';
import { evaluateWorkerForShift } from './eligibility.js';
import { closeTimesheetForEndedBooking, createDraftTimesheet } from './timesheets.js';

interface Actor {
  userId: string;
  orgId: string;
}

function getAssignment(db: Db, id: string): ShiftAssignment {
  return db.select().from(shiftAssignments).where(eq(shiftAssignments.id, id)).get()!;
}

function getShift(db: Db, id: string): Shift {
  return db.select().from(shifts).where(eq(shifts.id, id)).get()!;
}

function orgName(db: Db, id: string): string {
  return db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, id)).get()?.name ?? 'An organisation';
}

function workerName(w: Worker): string {
  return `${w.firstName} ${w.lastName}`;
}

function assertShiftOpen(shift: Shift): void {
  if (shift.status !== ShiftStatus.OPEN) throw conflict(`Shift is ${shift.status.toLowerCase().replace('_', ' ')}`);
  if (shift.filledCount >= shift.headcount) throw conflict('Shift is already fully staffed');
}

function existingLive(db: Db, shiftId: string, workerId: string): ShiftAssignment | undefined {
  return db
    .select()
    .from(shiftAssignments)
    .where(and(eq(shiftAssignments.shiftId, shiftId), eq(shiftAssignments.workerId, workerId), inArray(shiftAssignments.status, ['REQUESTED', 'OFFERED', 'CONFIRMED'])))
    .get();
}

/**
 * A supplier (manager or the worker themself) asks to cover a shift with a worker.
 * Eligibility blockers are enforced here; if the host enabled auto-confirm the booking completes immediately.
 */
export function requestShift(
  db: Db,
  notifier: Notifier,
  settings: PlatformSettingsRow,
  shift: Shift,
  site: Site,
  worker: Worker,
  actor: Actor,
  opts: { allowHoursOverride?: boolean; note?: string | null },
  now: Date,
): { assignment: ShiftAssignment; shift: Shift; warnings: { code: string; message: string }[] } {
  assertShiftOpen(shift);
  if (existingLive(db, shift.id, worker.id)) throw conflict('This worker already has a live request or booking for this shift');
  const { result, access } = evaluateWorkerForShift(db, settings, shift, site, worker, now, { allowHoursOverride: opts.allowHoursOverride });
  if (!result.eligible) throw unprocessable('Worker is not eligible for this shift', { blockers: result.blockers, warnings: result.warnings });

  const id = newId('asg');
  db.insert(shiftAssignments)
    .values({
      id,
      shiftId: shift.id,
      workerId: worker.id,
      supplierOrgId: worker.orgId,
      status: AssignmentStatus.REQUESTED,
      tierAtRequest: access.tier ?? null,
      matchedFlagId: access.matchedFlagId ?? null,
      requestedByUserId: actor.userId,
      requestedAt: now,
      hoursOverride: !!opts.allowHoursOverride,
      note: opts.note ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  let assignment = getAssignment(db, id);
  if (shift.autoConfirm) {
    assignment = confirmAssignment(db, notifier, settings, assignment, { userId: actor.userId, orgId: shift.hostOrgId }, now, true);
  } else {
    notifier.send({
      orgId: shift.hostOrgId,
      type: NotificationType.SHIFT_REQUEST,
      title: `Cover offered: ${shift.title}`,
      body: `${orgName(db, worker.orgId)} has put forward ${workerName(worker)} (${JOB_ROLE_LABELS[worker.jobRole]}) for your ${JOB_ROLE_LABELS[shift.jobRole]} shift on ${shift.startsAt.toISOString()}. Confirm or decline.`,
      data: { shiftId: shift.id, assignmentId: id },
    });
  }
  return { assignment, shift: getShift(db, shift.id), warnings: result.warnings };
}

/** The host offers the shift directly to a specific worker from an organisation that has access. */
export function offerShift(db: Db, notifier: Notifier, settings: PlatformSettingsRow, shift: Shift, site: Site, worker: Worker, actor: Actor, now: Date): ShiftAssignment {
  assertShiftOpen(shift);
  if (existingLive(db, shift.id, worker.id)) throw conflict('This worker already has a live request or booking for this shift');
  const { result, access } = evaluateWorkerForShift(db, settings, shift, site, worker, now);
  if (!result.eligible) throw unprocessable('Worker is not eligible for this shift', { blockers: result.blockers, warnings: result.warnings });
  const id = newId('asg');
  db.insert(shiftAssignments)
    .values({
      id,
      shiftId: shift.id,
      workerId: worker.id,
      supplierOrgId: worker.orgId,
      status: AssignmentStatus.OFFERED,
      tierAtRequest: access.tier ?? null,
      matchedFlagId: access.matchedFlagId ?? null,
      requestedByUserId: actor.userId,
      requestedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  notifier.send({
    orgId: worker.orgId,
    userId: worker.userId,
    type: NotificationType.SHIFT_OFFER,
    title: `Shift offered to ${workerName(worker)}: ${shift.title}`,
    body: `${orgName(db, shift.hostOrgId)} would like ${workerName(worker)} for their ${JOB_ROLE_LABELS[shift.jobRole]} shift on ${shift.startsAt.toISOString()} at £${shift.chargeRate.toFixed(2)}/h. Accept or decline.`,
    data: { shiftId: shift.id, assignmentId: id },
  });
  return getAssignment(db, id);
}

/** Host confirms a request, or supplier accepts an offer. Either way the booking becomes firm. */
export function confirmAssignment(
  db: Db,
  notifier: Notifier,
  settings: PlatformSettingsRow,
  assignment: ShiftAssignment,
  actor: Actor,
  now: Date,
  auto = false,
): ShiftAssignment {
  if (assignment.status !== AssignmentStatus.REQUESTED && assignment.status !== AssignmentStatus.OFFERED) throw conflict(`Assignment is ${assignment.status.toLowerCase()}`);
  const shift = getShift(db, assignment.shiftId);
  assertShiftOpen(shift);

  const worker = db.select().from(workers).where(eq(workers.id, assignment.workerId)).get()!;
  const filledCount = shift.filledCount + 1;
  const nowFull = filledCount >= shift.headcount;

  db.update(shiftAssignments)
    .set({ status: AssignmentStatus.CONFIRMED, respondedByUserId: actor.userId, respondedAt: now, updatedAt: now })
    .where(eq(shiftAssignments.id, assignment.id))
    .run();
  db.update(shifts).set({ filledCount, status: nowFull ? ShiftStatus.FILLED : ShiftStatus.OPEN, updatedAt: now }).where(eq(shifts.id, shift.id)).run();

  const hours = shiftPaidHours(shift.startsAt, shift.endsAt, shift.breakMinutes);
  const applied = applyHoursToFlag(db, notifier, assignment.matchedFlagId, hours, now);
  // Only bookings whose hours actually counted against a flag may give them back on cancellation.
  if (!applied && assignment.matchedFlagId) db.update(shiftAssignments).set({ matchedFlagId: null, updatedAt: now }).where(eq(shiftAssignments.id, assignment.id)).run();
  createDraftTimesheet(db, settings, shift, getAssignment(db, assignment.id), now);

  if (nowFull) declinePendingForShift(db, notifier, shift, 'Shift filled by another worker', now);

  const hostName = orgName(db, shift.hostOrgId);
  notifier.send({
    orgId: assignment.supplierOrgId,
    userId: worker.userId,
    type: NotificationType.SHIFT_CONFIRMED,
    title: `${auto ? 'Booked' : 'Confirmed'}: ${workerName(worker)} at ${hostName}`,
    body: `${shift.title} · ${shift.startsAt.toISOString()} – ${shift.endsAt.toISOString()}. Please share the site access notes with the worker.`,
    data: { shiftId: shift.id, assignmentId: assignment.id },
  });
  if (assignment.status === AssignmentStatus.OFFERED || auto) {
    notifier.send({
      orgId: shift.hostOrgId,
      type: NotificationType.SHIFT_CONFIRMED,
      title: `${workerName(worker)} booked for ${shift.title}`,
      body: `${orgName(db, assignment.supplierOrgId)} ${auto ? 'has been auto-confirmed' : 'accepted your offer'} for ${shift.startsAt.toISOString()}.`,
      data: { shiftId: shift.id, assignmentId: assignment.id },
    });
  }
  return getAssignment(db, assignment.id);
}

/** Close every REQUESTED/OFFERED row on a shift that can no longer take them, telling each supplier why. */
export function declinePendingForShift(db: Db, notifier: Notifier, shift: Shift, note: string, now: Date): number {
  const pending = db
    .select()
    .from(shiftAssignments)
    .where(and(eq(shiftAssignments.shiftId, shift.id), inArray(shiftAssignments.status, ['REQUESTED', 'OFFERED'])))
    .all();
  for (const p of pending) {
    db.update(shiftAssignments).set({ status: AssignmentStatus.DECLINED, respondedAt: now, note, updatedAt: now }).where(eq(shiftAssignments.id, p.id)).run();
    notifier.send({ orgId: p.supplierOrgId, type: NotificationType.SHIFT_DECLINED, title: `Not needed: ${shift.title}`, body: `${note}.`, data: { shiftId: shift.id, assignmentId: p.id } });
  }
  return pending.length;
}

export function declineAssignment(db: Db, notifier: Notifier, assignment: ShiftAssignment, actor: Actor, reason: string | null, now: Date): ShiftAssignment {
  if (assignment.status !== AssignmentStatus.REQUESTED && assignment.status !== AssignmentStatus.OFFERED) throw conflict(`Assignment is ${assignment.status.toLowerCase()}`);
  const shift = getShift(db, assignment.shiftId);
  db.update(shiftAssignments).set({ status: AssignmentStatus.DECLINED, respondedByUserId: actor.userId, respondedAt: now, note: reason, updatedAt: now }).where(eq(shiftAssignments.id, assignment.id)).run();
  const toOrg = actor.orgId === shift.hostOrgId ? assignment.supplierOrgId : shift.hostOrgId;
  notifier.send({ orgId: toOrg, type: NotificationType.SHIFT_DECLINED, title: `Declined: ${shift.title}`, body: reason ?? 'The request was declined.', data: { shiftId: shift.id, assignmentId: assignment.id } });
  return getAssignment(db, assignment.id);
}

export function withdrawRequest(db: Db, assignment: ShiftAssignment, actor: Actor, now: Date): ShiftAssignment {
  if (assignment.status !== AssignmentStatus.REQUESTED) throw conflict('Only pending requests can be withdrawn');
  db.update(shiftAssignments).set({ status: AssignmentStatus.WITHDRAWN, respondedByUserId: actor.userId, respondedAt: now, updatedAt: now }).where(eq(shiftAssignments.id, assignment.id)).run();
  return getAssignment(db, assignment.id);
}

/** Cancel a confirmed booking. Supplier cancellations close to the start are recorded as late. */
export function cancelAssignment(db: Db, notifier: Notifier, settings: PlatformSettingsRow, assignment: ShiftAssignment, actor: Actor, reason: string | null, now: Date): ShiftAssignment {
  if (assignment.status !== AssignmentStatus.CONFIRMED) throw conflict('Only confirmed bookings can be cancelled');
  const shift = getShift(db, assignment.shiftId);
  if (shift.startsAt.getTime() <= now.getTime()) throw conflict('The shift has already started; record a no-show or adjust the timesheet instead');
  const bySupplier = actor.orgId === assignment.supplierOrgId;
  const late = bySupplier && hoursBetween(now, shift.startsAt) < settings.lateCancellationHours;

  db.update(shiftAssignments)
    .set({ status: AssignmentStatus.CANCELLED, cancelledAt: now, cancelledByOrgId: actor.orgId, cancellationReason: reason, lateCancellation: late, updatedAt: now })
    .where(eq(shiftAssignments.id, assignment.id))
    .run();
  const filledCount = Math.max(0, shift.filledCount - 1);
  db.update(shifts).set({ filledCount, status: shift.status === ShiftStatus.FILLED ? ShiftStatus.OPEN : shift.status, updatedAt: now }).where(eq(shifts.id, shift.id)).run();
  if (shift.status === ShiftStatus.FILLED) {
    // The shift is open again: re-announce it to everyone whose stage has already opened (the scheduler sends the notices).
    db.update(shiftAccess).set({ notifiedAt: null }).where(and(eq(shiftAccess.shiftId, shift.id), lte(shiftAccess.opensAt, now))).run();
  }
  releaseHoursFromFlag(db, assignment.matchedFlagId, shiftPaidHours(shift.startsAt, shift.endsAt, shift.breakMinutes), now);
  closeTimesheetForEndedBooking(db, assignment.id, 'Booking cancelled', now);

  const worker = db.select().from(workers).where(eq(workers.id, assignment.workerId)).get()!;
  const toOrg = bySupplier ? shift.hostOrgId : assignment.supplierOrgId;
  notifier.send({
    orgId: toOrg,
    type: NotificationType.SHIFT_CANCELLED,
    title: `${late ? 'Late cancellation' : 'Booking cancelled'}: ${workerName(worker)} – ${shift.title}`,
    body: `${orgName(db, actor.orgId)} cancelled the booking for ${shift.startsAt.toISOString()}${reason ? `: ${reason}` : ''}.${bySupplier ? ' The shift has been reopened to the network.' : ''}`,
    data: { shiftId: shift.id, assignmentId: assignment.id, late },
  });
  return getAssignment(db, assignment.id);
}

export function recordNoShow(db: Db, notifier: Notifier, assignment: ShiftAssignment, actor: Actor, now: Date): ShiftAssignment {
  if (assignment.status !== AssignmentStatus.CONFIRMED) throw conflict('Only confirmed bookings can be marked as no-show');
  const shift = getShift(db, assignment.shiftId);
  if (shift.startsAt.getTime() > now.getTime()) throw conflict('The shift has not started yet');
  db.update(shiftAssignments).set({ status: AssignmentStatus.NO_SHOW, respondedByUserId: actor.userId, updatedAt: now }).where(eq(shiftAssignments.id, assignment.id)).run();
  closeTimesheetForEndedBooking(db, assignment.id, 'No-show recorded by the host', now);
  const worker = db.select().from(workers).where(eq(workers.id, assignment.workerId)).get()!;
  notifier.send({ orgId: assignment.supplierOrgId, type: NotificationType.SHIFT_CANCELLED, title: `No-show recorded: ${workerName(worker)}`, body: `${orgName(db, shift.hostOrgId)} reported that the worker did not attend ${shift.title} on ${shift.startsAt.toISOString()}.`, data: { shiftId: shift.id, assignmentId: assignment.id } });
  return getAssignment(db, assignment.id);
}
