import { Router } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { TimesheetStatus, UserRole } from '@merge/shared';
import { organisations, shifts, timesheets, workers } from '../db/schema.js';
import { auditFromReq } from '../lib/audit.js';
import { MANAGERS, isPlatformAdmin, requireAuth, requireRole } from '../lib/auth.js';
import { auth, deps } from '../lib/context.js';
import { forbidden, h, notFound } from '../lib/errors.js';
import { parseBody, parseQuery, zDate } from '../lib/validate.js';
import * as ts from '../services/timesheets.js';

export const timesheetsRouter = Router();
timesheetsRouter.use(requireAuth);

function load(req: Parameters<typeof deps>[0], id: string) {
  const { db } = deps(req);
  const row = db.select().from(timesheets).where(eq(timesheets.id, id)).get();
  if (!row) throw notFound('Timesheet');
  const { org, user } = auth(req);
  const isHost = row.hostOrgId === org.id || isPlatformAdmin(req);
  const isSupplier = row.supplierOrgId === org.id || isPlatformAdmin(req);
  const isWorker = user.role === UserRole.WORKER && user.workerId === row.workerId;
  if (!isHost && !isSupplier && !isWorker) throw forbidden();
  return { timesheet: row, isHost, isSupplier, isWorker };
}

timesheetsRouter.get(
  '/',
  h((req, res) => {
    const { db } = deps(req);
    const { org, user } = auth(req);
    const q = parseQuery(req, z.object({ scope: z.enum(['payable', 'receivable', 'all']).default(user.role === UserRole.WORKER ? 'receivable' : 'payable'), status: z.string().optional() }));
    const statuses = q.status ? (q.status.split(',') as TimesheetStatus[]) : undefined;
    if (q.scope === 'all' && !isPlatformAdmin(req)) throw forbidden();
    const rows = db
      .select({ timesheet: timesheets, shift: shifts, worker: workers, hostName: organisations.name })
      .from(timesheets)
      .innerJoin(shifts, eq(shifts.id, timesheets.shiftId))
      .innerJoin(workers, eq(workers.id, timesheets.workerId))
      .innerJoin(organisations, eq(organisations.id, timesheets.hostOrgId))
      .where(
        and(
          q.scope === 'payable' ? eq(timesheets.hostOrgId, org.id) : q.scope === 'receivable' ? eq(timesheets.supplierOrgId, org.id) : undefined,
          user.role === UserRole.WORKER ? eq(timesheets.workerId, user.workerId ?? '') : undefined,
          statuses ? inArray(timesheets.status, statuses) : undefined,
        ),
      )
      .orderBy(desc(shifts.startsAt))
      .all();
    const supplierNames = Object.fromEntries(db.select({ id: organisations.id, name: organisations.name }).from(organisations).all().map((o) => [o.id, o.name]));
    res.json(
      rows.map(({ timesheet, shift, worker, hostName }) => ({
        ...timesheet,
        hostName,
        supplierName: supplierNames[timesheet.supplierOrgId],
        worker: { id: worker.id, firstName: worker.firstName, lastName: worker.lastName, jobRole: worker.jobRole },
        shift: { id: shift.id, title: shift.title, jobRole: shift.jobRole, startsAt: shift.startsAt, endsAt: shift.endsAt, breakMinutes: shift.breakMinutes },
      })),
    );
  }),
);

timesheetsRouter.get(
  '/:id',
  h((req, res) => {
    const { db } = deps(req);
    const { timesheet } = load(req, req.params.id!);
    const shift = db.select().from(shifts).where(eq(shifts.id, timesheet.shiftId)).get();
    res.json({ ...timesheet, shift });
  }),
);

timesheetsRouter.post(
  '/:id/clock-in',
  h((req, res) => {
    const { db, now } = deps(req);
    const { timesheet, isHost, isSupplier, isWorker } = load(req, req.params.id!);
    if (!isHost && !isSupplier && !isWorker) throw forbidden();
    const body = parseBody(req, z.object({ at: zDate.optional(), lat: z.number().nullable().optional(), lng: z.number().nullable().optional() }));
    const at = now();
    const updated = ts.clockIn(db, timesheet, body.at ?? at, body, at);
    auditFromReq(req, db, { action: 'UPDATE', entityType: 'timesheet', entityId: timesheet.id, data: { clockIn: updated.clockInAt } }, at);
    res.json(updated);
  }),
);

timesheetsRouter.post(
  '/:id/clock-out',
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { timesheet } = load(req, req.params.id!);
    const body = parseBody(req, z.object({ at: zDate.optional(), breakMinutes: z.number().int().min(0).max(240).optional() }));
    const at = now();
    const updated = ts.clockOut(db, notifier, timesheet, body.at ?? at, body.breakMinutes, at);
    auditFromReq(req, db, { action: 'UPDATE', entityType: 'timesheet', entityId: timesheet.id, data: { clockOut: updated.clockOutAt, paidHours: updated.paidHours } }, at);
    res.json(updated);
  }),
);

/** Manual submission or correction by the supplier side. */
timesheetsRouter.post(
  '/:id/submit',
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { timesheet, isSupplier, isWorker } = load(req, req.params.id!);
    if (!isSupplier && !isWorker) throw forbidden('Only the supplying organisation or the worker can submit times');
    const body = parseBody(req, z.object({ clockInAt: zDate, clockOutAt: zDate, breakMinutes: z.number().int().min(0).max(240).default(0), notes: z.string().max(1000).nullable().optional() }));
    const at = now();
    const updated = ts.submitTimes(db, notifier, timesheet, body, at);
    auditFromReq(req, db, { action: 'UPDATE', entityType: 'timesheet', entityId: timesheet.id, data: body }, at);
    res.json(updated);
  }),
);

timesheetsRouter.post(
  '/:id/approve',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { timesheet, isHost } = load(req, req.params.id!);
    if (!isHost) throw forbidden('Only the host organisation can approve timesheets');
    const at = now();
    const updated = ts.approve(db, notifier, timesheet, auth(req).user.id, at);
    auditFromReq(req, db, { action: 'APPROVE', entityType: 'timesheet', entityId: timesheet.id }, at);
    res.json(updated);
  }),
);

timesheetsRouter.post(
  '/:id/dispute',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { timesheet, isHost } = load(req, req.params.id!);
    if (!isHost) throw forbidden('Only the host organisation can dispute timesheets');
    const body = parseBody(req, z.object({ reason: z.string().min(3).max(1000) }));
    const at = now();
    const updated = ts.dispute(db, notifier, timesheet, body.reason, at);
    auditFromReq(req, db, { action: 'DISPUTE', entityType: 'timesheet', entityId: timesheet.id, data: body }, at);
    res.json(updated);
  }),
);

timesheetsRouter.post(
  '/:id/reject',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { timesheet, isHost } = load(req, req.params.id!);
    if (!isHost) throw forbidden('Only the host organisation can reject timesheets');
    const body = parseBody(req, z.object({ reason: z.string().min(3).max(1000) }));
    const at = now();
    const updated = ts.reject(db, notifier, timesheet, body.reason, at);
    auditFromReq(req, db, { action: 'DISPUTE', entityType: 'timesheet', entityId: timesheet.id, data: { ...body, rejected: true } }, at);
    res.json(updated);
  }),
);
