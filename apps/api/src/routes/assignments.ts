import { Router } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { UserRole } from '@merge/shared';
import { organisations, ratings, shiftAssignments, shifts, sites, timesheets, workers } from '../db/schema.js';
import { auditFromReq } from '../lib/audit.js';
import { MANAGERS, isManager, isPlatformAdmin, requireAuth, requireRole } from '../lib/auth.js';
import { auth, deps } from '../lib/context.js';
import { conflict, forbidden, h, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { parseBody, parseQuery } from '../lib/validate.js';
import { cancelAssignment, confirmAssignment, declineAssignment, recordNoShow, withdrawRequest } from '../services/assignments.js';

export const assignmentsRouter = Router();
assignmentsRouter.use(requireAuth);

function load(req: Parameters<typeof deps>[0], id: string) {
  const { db } = deps(req);
  const row = db
    .select({ assignment: shiftAssignments, shift: shifts, worker: workers })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .innerJoin(workers, eq(workers.id, shiftAssignments.workerId))
    .where(eq(shiftAssignments.id, id))
    .get();
  if (!row) throw notFound('Assignment');
  const { org, user } = auth(req);
  const manager = isManager(req); // workers never inherit organisation-wide access
  const isHost = (manager && row.shift.hostOrgId === org.id) || isPlatformAdmin(req);
  const isSupplier = (manager && row.assignment.supplierOrgId === org.id) || isPlatformAdmin(req);
  const isWorker = user.role === UserRole.WORKER && user.workerId === row.assignment.workerId;
  if (!isHost && !isSupplier && !isWorker) throw forbidden();
  return { ...row, isHost, isSupplier, isWorker };
}

assignmentsRouter.get(
  '/',
  h((req, res) => {
    const { db } = deps(req);
    const { org, user } = auth(req);
    const q = parseQuery(req, z.object({ scope: z.enum(['incoming', 'outgoing']).default(user.role === UserRole.WORKER ? 'outgoing' : 'incoming'), status: z.string().optional() }));
    const statuses = q.status ? q.status.split(',') : undefined;
    const rows = db
      .select({ assignment: shiftAssignments, shift: shifts, site: sites, worker: workers, supplierName: organisations.name })
      .from(shiftAssignments)
      .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
      .innerJoin(sites, eq(sites.id, shifts.siteId))
      .innerJoin(workers, eq(workers.id, shiftAssignments.workerId))
      .innerJoin(organisations, eq(organisations.id, shiftAssignments.supplierOrgId))
      .where(
        and(
          q.scope === 'incoming' ? eq(shifts.hostOrgId, org.id) : eq(shiftAssignments.supplierOrgId, org.id),
          user.role === UserRole.WORKER ? eq(shiftAssignments.workerId, user.workerId ?? '') : undefined,
          statuses ? inArray(shiftAssignments.status, statuses as never) : undefined,
        ),
      )
      .orderBy(desc(shiftAssignments.createdAt))
      .all();
    res.json(
      rows.map(({ assignment, shift, site, worker, supplierName }) => ({
        ...assignment,
        supplierName,
        worker: { id: worker.id, firstName: worker.firstName, lastName: worker.lastName, jobRole: worker.jobRole },
        shift: { id: shift.id, title: shift.title, jobRole: shift.jobRole, startsAt: shift.startsAt, endsAt: shift.endsAt, chargeRate: shift.chargeRate, status: shift.status, hostOrgId: shift.hostOrgId, siteName: site.name },
      })),
    );
  }),
);

assignmentsRouter.get(
  '/:id',
  h((req, res) => {
    const { db } = deps(req);
    const { assignment, shift, worker } = load(req, req.params.id!);
    const timesheet = db.select().from(timesheets).where(eq(timesheets.assignmentId, assignment.id)).get() ?? null;
    res.json({ ...assignment, shift, worker: { id: worker.id, firstName: worker.firstName, lastName: worker.lastName, jobRole: worker.jobRole, skills: worker.skills }, timesheet });
  }),
);

assignmentsRouter.post(
  '/:id/confirm',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { user, settings } = auth(req);
    const { assignment, shift, isHost } = load(req, req.params.id!);
    if (!isHost) throw forbidden('Only the host organisation can confirm requests');
    if (assignment.status !== 'REQUESTED') throw conflict('Only pending requests can be confirmed');
    const at = now();
    const updated = confirmAssignment(db, notifier, settings, assignment, { userId: user.id, orgId: shift.hostOrgId }, at);
    auditFromReq(req, db, { action: 'CONFIRM', entityType: 'shift_assignment', entityId: assignment.id }, at);
    res.json(updated);
  }),
);

assignmentsRouter.post(
  '/:id/accept',
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { user, settings } = auth(req);
    const { assignment, isSupplier, isWorker } = load(req, req.params.id!);
    if (!isSupplier && !isWorker) throw forbidden('Only the worker or their employer can accept an offer');
    if (assignment.status !== 'OFFERED') throw conflict('Only offers can be accepted');
    const at = now();
    const updated = confirmAssignment(db, notifier, settings, assignment, { userId: user.id, orgId: assignment.supplierOrgId }, at);
    auditFromReq(req, db, { action: 'CONFIRM', entityType: 'shift_assignment', entityId: assignment.id, data: { accepted: true } }, at);
    res.json(updated);
  }),
);

assignmentsRouter.post(
  '/:id/decline',
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { user, org } = auth(req);
    const { assignment, shift, isHost, isSupplier, isWorker } = load(req, req.params.id!);
    const body = parseBody(req, z.object({ reason: z.string().max(500).nullable().optional() }));
    if (assignment.status === 'REQUESTED' && !isHost) throw forbidden('Only the host can decline a request');
    if (assignment.status === 'OFFERED' && !isSupplier && !isWorker) throw forbidden('Only the worker or their employer can decline an offer');
    const at = now();
    const actorOrg = isHost && assignment.status === 'REQUESTED' ? shift.hostOrgId : assignment.supplierOrgId;
    const updated = declineAssignment(db, notifier, assignment, { userId: user.id, orgId: isPlatformAdmin(req) ? actorOrg : org.id }, body.reason ?? null, at);
    auditFromReq(req, db, { action: 'DECLINE', entityType: 'shift_assignment', entityId: assignment.id, data: body }, at);
    res.json(updated);
  }),
);

assignmentsRouter.post(
  '/:id/withdraw',
  h((req, res) => {
    const { db, now } = deps(req);
    const { user } = auth(req);
    const { assignment, isSupplier, isWorker } = load(req, req.params.id!);
    if (!isSupplier && !isWorker) throw forbidden();
    const at = now();
    const updated = withdrawRequest(db, assignment, { userId: user.id, orgId: assignment.supplierOrgId }, at);
    auditFromReq(req, db, { action: 'WITHDRAW', entityType: 'shift_assignment', entityId: assignment.id }, at);
    res.json(updated);
  }),
);

assignmentsRouter.post(
  '/:id/cancel',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { user, org, settings } = auth(req);
    const { assignment, shift, isHost, isSupplier } = load(req, req.params.id!);
    if (!isHost && !isSupplier) throw forbidden();
    const body = parseBody(req, z.object({ reason: z.string().max(500).nullable().optional() }));
    const at = now();
    const actorOrgId = isPlatformAdmin(req) ? (req.body?.asSupplier ? assignment.supplierOrgId : shift.hostOrgId) : org.id;
    const updated = cancelAssignment(db, notifier, settings, assignment, { userId: user.id, orgId: actorOrgId }, body.reason ?? null, at);
    auditFromReq(req, db, { action: 'CANCEL', entityType: 'shift_assignment', entityId: assignment.id, data: { ...body, late: updated.lateCancellation } }, at);
    res.json(updated);
  }),
);

assignmentsRouter.post(
  '/:id/no-show',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { user } = auth(req);
    const { assignment, shift, isHost } = load(req, req.params.id!);
    if (!isHost) throw forbidden('Only the host can record a no-show');
    const at = now();
    const updated = recordNoShow(db, notifier, assignment, { userId: user.id, orgId: shift.hostOrgId }, at);
    auditFromReq(req, db, { action: 'UPDATE', entityType: 'shift_assignment', entityId: assignment.id, data: { noShow: true } }, at);
    res.json(updated);
  }),
);

/** Host rates the worker; supplier rates the host site. One rating per side per assignment. */
assignmentsRouter.post(
  '/:id/rating',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const { org } = auth(req);
    const { assignment, shift, isHost, isSupplier } = load(req, req.params.id!);
    if (!['CONFIRMED', 'COMPLETED', 'NO_SHOW'].includes(assignment.status)) throw conflict('Only booked shifts can be rated');
    if (shift.startsAt.getTime() > now().getTime()) throw conflict('You can rate once the shift has started');
    const body = parseBody(req, z.object({ score: z.number().int().min(1).max(5), comment: z.string().max(1000).nullable().optional() }));
    const fromOrgId = isPlatformAdmin(req) ? shift.hostOrgId : org.id;
    const ratingHost = fromOrgId === shift.hostOrgId && isHost;
    if (!ratingHost && !isSupplier) throw forbidden();
    const at = now();
    db.delete(ratings).where(and(eq(ratings.assignmentId, assignment.id), eq(ratings.fromOrgId, fromOrgId))).run();
    const id = newId('rat');
    db.insert(ratings)
      .values({ id, assignmentId: assignment.id, fromOrgId, toOrgId: ratingHost ? assignment.supplierOrgId : shift.hostOrgId, workerId: ratingHost ? assignment.workerId : null, score: body.score, comment: body.comment ?? null, createdAt: at })
      .run();
    res.status(201).json(db.select().from(ratings).where(eq(ratings.id, id)).get());
  }),
);
