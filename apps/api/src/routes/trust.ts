/**
 * Decisions 4 and 14: trust between organisations. Hosts can bar a named worker from their sites and report
 * concerns to the worker's employer; everyone can see an organisation's reliability record.
 */
import { Router } from 'express';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { NotificationType, UserRole } from '@merge/shared';
import { organisations, shiftAccess, shiftAssignments, shifts, sites, users, workerBars, workerReports, workers } from '../db/schema.js';
import { auditFromReq } from '../lib/audit.js';
import { MANAGERS, assertOrgAccess, isManager, isPlatformAdmin, requireAuth, requireRole } from '../lib/auth.js';
import { auth, deps } from '../lib/context.js';
import { conflict, forbidden, h, notFound, unprocessable } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { parseBody, parseQuery } from '../lib/validate.js';
import { cancelFutureBookingsForWorker } from '../services/assignments.js';
import { platformOwnerOrgId, reliabilityFor } from '../services/reliability.js';

export const trustRouter = Router();
trustRouter.use(requireAuth);

/** The reason of a bar is private to the host unless it chose to share it with the employer. */
const SHARED_PREFIX = '[shared] ';
const storeReason = (reason: string, share: boolean) => (share ? SHARED_PREFIX + reason : reason);
const readReason = (stored: string) => (stored.startsWith(SHARED_PREFIX) ? { reason: stored.slice(SHARED_PREFIX.length), shared: true } : { reason: stored, shared: false });

function workerSummary(w: typeof workers.$inferSelect) {
  return { id: w.id, firstName: w.firstName, lastName: w.lastName, jobRole: w.jobRole, orgId: w.orgId };
}

function orgNameOf(db: ReturnType<typeof deps>['db'], id: string): string {
  return db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, id)).get()?.name ?? 'An organisation';
}

/** The worker was booked with the host at some point (confirmed, completed, no-show or a cancelled booking). */
function hostWorkedWith(db: ReturnType<typeof deps>['db'], hostOrgId: string, workerId: string): boolean {
  return !!db
    .select({ id: shiftAssignments.id })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .where(and(eq(shiftAssignments.workerId, workerId), eq(shifts.hostOrgId, hostOrgId), inArray(shiftAssignments.status, ['CONFIRMED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'])))
    .get();
}

/** A host may only bar workers it has actually met: an assignment with the host, or a worker its shifts were released to. */
function hostKnowsWorker(db: ReturnType<typeof deps>['db'], hostOrgId: string, worker: typeof workers.$inferSelect): boolean {
  const worked = db
    .select({ id: shiftAssignments.id })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .where(and(eq(shiftAssignments.workerId, worker.id), eq(shifts.hostOrgId, hostOrgId)))
    .get();
  if (worked) return true;
  if (!worker.shareable) return false;
  return !!db
    .select({ id: shiftAccess.id })
    .from(shiftAccess)
    .innerJoin(shifts, eq(shifts.id, shiftAccess.shiftId))
    .where(and(eq(shiftAccess.orgId, worker.orgId), eq(shifts.hostOrgId, hostOrgId)))
    .get();
}

trustRouter.get(
  '/reliability/:orgId',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const { settings } = auth(req);
    const org = db.select({ id: organisations.id, name: organisations.name }).from(organisations).where(eq(organisations.id, req.params.orgId!)).get();
    if (!org) throw notFound('Organisation');
    res.json({ orgName: org.name, ...reliabilityFor(db, settings, org.id, now()) });
  }),
);

// ---------------------------------------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------------------------------------

trustRouter.post(
  '/bars',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { user, org, settings } = auth(req);
    const body = parseBody(req, z.object({ workerId: z.string(), siteId: z.string().nullable().optional(), reason: z.string().trim().min(3).max(1000), shareReason: z.boolean().default(false), hostOrgId: z.string().optional() }));
    const hostOrgId = body.hostOrgId ?? org.id;
    assertOrgAccess(req, hostOrgId);
    const worker = db.select().from(workers).where(eq(workers.id, body.workerId)).get();
    if (!worker) throw notFound('Worker');
    if (worker.orgId === hostOrgId) throw unprocessable('You cannot bar your own employee; change their status instead');
    if (!hostKnowsWorker(db, hostOrgId, worker)) throw unprocessable('This worker has not worked for you and is not on your candidate list');
    if (body.siteId) {
      const site = db.select({ id: sites.id }).from(sites).where(and(eq(sites.id, body.siteId), eq(sites.orgId, hostOrgId))).get();
      if (!site) throw notFound('Site');
    }
    const existing = db
      .select()
      .from(workerBars)
      .where(and(eq(workerBars.hostOrgId, hostOrgId), eq(workerBars.workerId, worker.id), isNull(workerBars.liftedAt)))
      .all()
      .find((b) => !b.siteId || b.siteId === (body.siteId ?? null));
    if (existing) throw conflict('This worker is already barred');
    const at = now();
    const id = newId('bar');
    db.insert(workerBars).values({ id, hostOrgId, workerId: worker.id, siteId: body.siteId ?? null, reason: storeReason(body.reason, body.shareReason), createdByUserId: user.id, createdAt: at }).run();
    // Future bookings with this host are released; the supplier is not penalised for a cancellation it did not make.
    const released = cancelFutureBookingsForWorker(db, notifier, settings, worker.id, { userId: user.id, orgId: hostOrgId }, 'Worker barred by the host', at, { hostOrgId });
    const hostName = orgNameOf(db, hostOrgId);
    const siteName = body.siteId ? db.select({ name: sites.name }).from(sites).where(eq(sites.id, body.siteId)).get()?.name : null;
    notifier.send({
      orgId: worker.orgId,
      type: NotificationType.SYSTEM,
      title: `${hostName} will no longer take ${worker.firstName} ${worker.lastName}`,
      body: `${hostName} has barred ${worker.firstName} ${worker.lastName} from ${siteName ? `their site ${siteName}` : 'all their sites'}.${body.shareReason ? ` Reason given: ${body.reason}` : ' No reason was shared.'}${released.cancelled.length ? ` ${released.cancelled.length} future booking(s) were cancelled.` : ''}`,
      data: { kind: 'worker-bar', barId: id, workerId: worker.id, hostOrgId },
    });
    auditFromReq(req, db, { action: 'CREATE', entityType: 'worker_bar', entityId: id, data: { workerId: worker.id, siteId: body.siteId ?? null } }, at);
    const row = db.select().from(workerBars).where(eq(workerBars.id, id)).get()!;
    res.status(201).json({ ...row, ...readReason(row.reason), worker: workerSummary(worker), siteName: siteName ?? null, released });
  }),
);

trustRouter.get(
  '/bars',
  h((req, res) => {
    const { db } = deps(req);
    const { org } = auth(req);
    const q = parseQuery(req, z.object({ orgId: z.string().optional(), includeLifted: z.enum(['true', 'false']).optional(), workerId: z.string().optional() }));
    if (!isManager(req)) throw forbidden();
    const orgId = q.orgId ?? org.id;
    assertOrgAccess(req, orgId);
    const rows = db
      .select({ bar: workerBars, worker: workers, hostName: organisations.name, siteName: sites.name })
      .from(workerBars)
      .innerJoin(workers, eq(workers.id, workerBars.workerId))
      .innerJoin(organisations, eq(organisations.id, workerBars.hostOrgId))
      .leftJoin(sites, eq(sites.id, workerBars.siteId))
      .where(and(q.includeLifted === 'true' ? undefined : isNull(workerBars.liftedAt), q.workerId ? eq(workerBars.workerId, q.workerId) : undefined))
      .orderBy(desc(workerBars.createdAt))
      .all();
    const out = rows
      .filter(({ bar, worker }) => bar.hostOrgId === orgId || worker.orgId === orgId)
      .map(({ bar, worker, hostName, siteName }) => {
        const asHost = bar.hostOrgId === orgId;
        const r = readReason(bar.reason);
        return { ...bar, reason: asHost || r.shared ? r.reason : null, shared: r.shared, role: asHost ? 'host' : 'employer', hostName, siteName: siteName ?? null, worker: workerSummary(worker) };
      });
    res.json(out);
  }),
);

trustRouter.delete(
  '/bars/:id',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { user } = auth(req);
    const bar = db.select().from(workerBars).where(eq(workerBars.id, req.params.id!)).get();
    if (!bar) throw notFound('Bar');
    assertOrgAccess(req, bar.hostOrgId);
    if (bar.liftedAt) throw conflict('This bar has already been lifted');
    const at = now();
    db.update(workerBars).set({ liftedAt: at, liftedByUserId: user.id }).where(eq(workerBars.id, bar.id)).run();
    const worker = db.select().from(workers).where(eq(workers.id, bar.workerId)).get();
    if (worker) {
      notifier.send({ orgId: worker.orgId, type: NotificationType.SYSTEM, title: `${orgNameOf(db, bar.hostOrgId)} lifted the bar on ${worker.firstName} ${worker.lastName}`, body: 'The worker can be put forward for their shifts again.', data: { kind: 'worker-bar-lifted', barId: bar.id, workerId: worker.id } });
    }
    auditFromReq(req, db, { action: 'DELETE', entityType: 'worker_bar', entityId: bar.id }, at);
    res.json({ ...db.select().from(workerBars).where(eq(workerBars.id, bar.id)).get()!, ...readReason(bar.reason) });
  }),
);

// ---------------------------------------------------------------------------------------------------------
// Reports (concerns about a lent worker, handled by the employer under its own frameworks)
// ---------------------------------------------------------------------------------------------------------

const zCategory = z.enum(['SAFEGUARDING', 'CONDUCT', 'ATTENDANCE', 'COMPETENCE', 'OTHER']);

function reportRow(db: ReturnType<typeof deps>['db'], id: string) {
  const row = db
    .select({ report: workerReports, worker: workers, hostName: organisations.name })
    .from(workerReports)
    .innerJoin(workers, eq(workers.id, workerReports.workerId))
    .innerJoin(organisations, eq(organisations.id, workerReports.hostOrgId))
    .where(eq(workerReports.id, id))
    .get();
  if (!row) throw notFound('Report');
  const raisedBy = row.report.createdByUserId ? db.select({ firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, row.report.createdByUserId)).get() : null;
  return { ...row.report, hostName: row.hostName, supplierName: orgNameOf(db, row.report.supplierOrgId), worker: workerSummary(row.worker), raisedBy: raisedBy ? `${raisedBy.firstName} ${raisedBy.lastName}` : null };
}

trustRouter.post(
  '/reports',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { user, org, settings } = auth(req);
    const body = parseBody(req, z.object({ workerId: z.string(), assignmentId: z.string().nullable().optional(), category: zCategory, description: z.string().trim().min(10).max(4000), hostOrgId: z.string().optional() }));
    const hostOrgId = body.hostOrgId ?? org.id;
    assertOrgAccess(req, hostOrgId);
    const worker = db.select().from(workers).where(eq(workers.id, body.workerId)).get();
    if (!worker) throw notFound('Worker');
    if (worker.orgId === hostOrgId) throw unprocessable('Reports are for workers lent by another organisation');
    if (body.assignmentId) {
      const a = db.select({ a: shiftAssignments, hostOrgId: shifts.hostOrgId }).from(shiftAssignments).innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId)).where(eq(shiftAssignments.id, body.assignmentId)).get();
      if (!a || a.a.workerId !== worker.id || a.hostOrgId !== hostOrgId) throw unprocessable('That assignment is not this worker working for you');
    } else if (!hostWorkedWith(db, hostOrgId, worker.id)) {
      throw unprocessable('This worker has not worked for you');
    }
    const at = now();
    const id = newId('rpt');
    db.insert(workerReports)
      .values({ id, hostOrgId, supplierOrgId: worker.orgId, workerId: worker.id, assignmentId: body.assignmentId ?? null, category: body.category, description: body.description, status: 'OPEN', createdByUserId: user.id, createdAt: at })
      .run();
    const hostName = orgNameOf(db, hostOrgId);
    const label = body.category.charAt(0) + body.category.slice(1).toLowerCase();
    notifier.send({
      orgId: worker.orgId,
      type: NotificationType.SYSTEM,
      title: `${label} concern raised about ${worker.firstName} ${worker.lastName} by ${hostName}`,
      body: `${body.description}\n\nUnder the network agreement this is for you to handle through your own frameworks. Acknowledge the report and record your response on the Trust page.`,
      data: { kind: 'worker-report', reportId: id, workerId: worker.id, category: body.category },
    });
    if (body.category === 'SAFEGUARDING') {
      const owner = platformOwnerOrgId(db, settings);
      if (owner && owner !== worker.orgId) {
        notifier.send({ orgId: owner, type: NotificationType.SYSTEM, title: `Safeguarding concern: ${hostName} about a ${orgNameOf(db, worker.orgId)} worker`, body: `Report ${id} was raised with the employer. Follow up to make sure it is handled.`, data: { kind: 'worker-report', reportId: id, workerId: worker.id, category: body.category } });
      }
    }
    auditFromReq(req, db, { action: 'CREATE', entityType: 'worker_report', entityId: id, data: { workerId: worker.id, category: body.category } }, at);
    res.status(201).json(reportRow(db, id));
  }),
);

trustRouter.get(
  '/reports',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db } = deps(req);
    const { org } = auth(req);
    const q = parseQuery(req, z.object({ scope: z.enum(['raised', 'received', 'all']).default('received'), orgId: z.string().optional(), status: z.enum(['OPEN', 'ACKNOWLEDGED', 'CLOSED']).optional(), workerId: z.string().optional() }));
    const orgId = q.orgId ?? org.id;
    assertOrgAccess(req, orgId);
    if (q.scope === 'all' && !isPlatformAdmin(req)) throw forbidden();
    const rows = db
      .select({ report: workerReports, worker: workers, hostName: organisations.name })
      .from(workerReports)
      .innerJoin(workers, eq(workers.id, workerReports.workerId))
      .innerJoin(organisations, eq(organisations.id, workerReports.hostOrgId))
      .where(
        and(
          q.scope === 'raised' ? eq(workerReports.hostOrgId, orgId) : q.scope === 'received' ? eq(workerReports.supplierOrgId, orgId) : undefined,
          q.status ? eq(workerReports.status, q.status) : undefined,
          q.workerId ? eq(workerReports.workerId, q.workerId) : undefined,
        ),
      )
      .orderBy(desc(workerReports.createdAt))
      .all();
    res.json(rows.map(({ report, worker, hostName }) => ({ ...report, hostName, supplierName: orgNameOf(db, report.supplierOrgId), worker: workerSummary(worker) })));
  }),
);

trustRouter.get(
  '/reports/:id',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db } = deps(req);
    const { org } = auth(req);
    const row = reportRow(db, req.params.id!);
    if (!isPlatformAdmin(req) && row.hostOrgId !== org.id && row.supplierOrgId !== org.id) throw forbidden();
    res.json(row);
  }),
);

trustRouter.post(
  '/reports/:id/acknowledge',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const report = db.select().from(workerReports).where(eq(workerReports.id, req.params.id!)).get();
    if (!report) throw notFound('Report');
    assertOrgAccess(req, report.supplierOrgId);
    if (report.status !== 'OPEN') throw conflict(`Report is ${report.status.toLowerCase()}`);
    const at = now();
    db.update(workerReports).set({ status: 'ACKNOWLEDGED', acknowledgedAt: at }).where(eq(workerReports.id, report.id)).run();
    notifier.send({ orgId: report.hostOrgId, type: NotificationType.SYSTEM, title: `${orgNameOf(db, report.supplierOrgId)} acknowledged your report`, body: 'The employer has received the concern and is handling it under its own procedures.', data: { kind: 'worker-report', reportId: report.id } });
    auditFromReq(req, db, { action: 'UPDATE', entityType: 'worker_report', entityId: report.id, data: { status: 'ACKNOWLEDGED' } }, at);
    res.json(reportRow(db, report.id));
  }),
);

trustRouter.post(
  '/reports/:id/close',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const body = parseBody(req, z.object({ employerResponse: z.string().trim().min(5).max(4000) }));
    const report = db.select().from(workerReports).where(eq(workerReports.id, req.params.id!)).get();
    if (!report) throw notFound('Report');
    assertOrgAccess(req, report.supplierOrgId);
    if (report.status === 'CLOSED') throw conflict('Report is already closed');
    const at = now();
    db.update(workerReports).set({ status: 'CLOSED', employerResponse: body.employerResponse, acknowledgedAt: report.acknowledgedAt ?? at, closedAt: at }).where(eq(workerReports.id, report.id)).run();
    notifier.send({ orgId: report.hostOrgId, type: NotificationType.SYSTEM, title: `${orgNameOf(db, report.supplierOrgId)} closed your report`, body: body.employerResponse, data: { kind: 'worker-report', reportId: report.id } });
    auditFromReq(req, db, { action: 'UPDATE', entityType: 'worker_report', entityId: report.id, data: { status: 'CLOSED' } }, at);
    res.json(reportRow(db, report.id));
  }),
);

/** Workers may see whether they are barred anywhere (no reasons), so an unexplained missing shift is not a mystery. */
trustRouter.get(
  '/me/bars',
  h((req, res) => {
    const { db } = deps(req);
    const { user } = auth(req);
    if (user.role !== UserRole.WORKER || !user.workerId) return res.json([]);
    const rows = db
      .select({ bar: workerBars, hostName: organisations.name })
      .from(workerBars)
      .innerJoin(organisations, eq(organisations.id, workerBars.hostOrgId))
      .where(and(eq(workerBars.workerId, user.workerId), isNull(workerBars.liftedAt)))
      .all();
    res.json(rows.map(({ bar, hostName }) => ({ id: bar.id, hostName, siteId: bar.siteId, createdAt: bar.createdAt })));
  }),
);

