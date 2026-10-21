import { Router } from 'express';
import { and, avg, desc, eq, gte, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DocumentType, JobRole, Skill, UserRole, WorkerStatus, complianceSummary } from '@merge/shared';
import { ratings, shiftAssignments, shifts, users, workerDocuments, workerUnavailability, workers } from '../db/schema.js';
import { auditFromReq } from '../lib/audit.js';
import { MANAGERS, assertOrgAccess, hashPassword, isPlatformAdmin, requireAuth, requireRole } from '../lib/auth.js';
import { auth, deps } from '../lib/context.js';
import { conflict, forbidden, h, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { parseBody, parseQuery, zDate, zOptionalDate, zPostcode } from '../lib/validate.js';

export const workersRouter = Router();
workersRouter.use(requireAuth);

const zWorker = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  email: z.string().email().nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  jobRole: z.nativeEnum(JobRole),
  skills: z.array(z.nativeEnum(Skill)).default([]),
  status: z.nativeEnum(WorkerStatus).default('ACTIVE'),
  shareable: z.boolean().default(true),
  contractedHoursPerWeek: z.number().min(0).max(80).nullable().optional(),
  maxHoursPerWeek: z.number().min(1).max(80).nullable().optional(),
  optedOutOf48h: z.boolean().default(false),
  postcode: zPostcode.nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  travelRadiusKm: z.number().min(0).max(500).nullable().optional(),
  hourlyPayRate: z.number().min(0).max(500).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

function resolveOrgId(req: Parameters<typeof deps>[0], explicit?: string): string {
  if (explicit) {
    assertOrgAccess(req, explicit);
    return explicit;
  }
  return auth(req).org.id;
}

/** Employers never see other employers' pay rates; hosts never see pay rates at all. */
function stripPrivate(w: typeof workers.$inferSelect, own: boolean) {
  if (own) return w;
  const { hourlyPayRate: _p, notes: _n, ...rest } = w;
  return rest;
}

workersRouter.get(
  '/',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const q = parseQuery(req, z.object({ orgId: z.string().optional(), status: z.nativeEnum(WorkerStatus).optional(), jobRole: z.nativeEnum(JobRole).optional() }));
    const conditions = [];
    if (!(isPlatformAdmin(req) && !q.orgId)) conditions.push(eq(workers.orgId, resolveOrgId(req, q.orgId)));
    if (q.status) conditions.push(eq(workers.status, q.status));
    if (q.jobRole) conditions.push(eq(workers.jobRole, q.jobRole));
    const rows = db.select().from(workers).where(conditions.length ? and(...conditions) : undefined).orderBy(workers.lastName, workers.firstName).all();
    const at = now();
    const docs = rows.length ? db.select().from(workerDocuments).where(inArray(workerDocuments.workerId, rows.map((r) => r.id))).all() : [];
    res.json(
      rows.map((w) => ({
        ...stripPrivate(w, w.orgId === auth(req).org.id || isPlatformAdmin(req)),
        compliance: complianceSummary(docs.filter((d) => d.workerId === w.id), w.jobRole, at),
      })),
    );
  }),
);

workersRouter.post(
  '/',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const body = parseBody(req, zWorker.extend({ orgId: z.string().optional() }));
    const { orgId: explicitOrg, ...data } = body;
    const orgId = resolveOrgId(req, explicitOrg);
    const id = newId('wrk');
    const at = now();
    db.insert(workers).values({ id, orgId, ...data, createdAt: at, updatedAt: at }).run();
    auditFromReq(req, db, { action: 'CREATE', entityType: 'worker', entityId: id }, at);
    res.status(201).json(db.select().from(workers).where(eq(workers.id, id)).get());
  }),
);

function loadWorker(req: Parameters<typeof deps>[0], id: string) {
  const { db } = deps(req);
  const w = db.select().from(workers).where(eq(workers.id, id)).get();
  if (!w) throw notFound('Worker');
  const { user } = auth(req);
  const own = w.orgId === user.orgId || isPlatformAdmin(req);
  const self = user.workerId === w.id;
  if (!own && !self) throw forbidden('That worker belongs to another organisation');
  return { worker: w, own, self };
}

workersRouter.get(
  '/:id',
  h((req, res) => {
    const { db, now } = deps(req);
    const { worker, own } = loadWorker(req, req.params.id!);
    const at = now();
    const docs = db.select().from(workerDocuments).where(eq(workerDocuments.workerId, worker.id)).orderBy(desc(workerDocuments.createdAt)).all();
    const unavailability = db.select().from(workerUnavailability).where(and(eq(workerUnavailability.workerId, worker.id), gte(workerUnavailability.endsAt, at))).all();
    const upcoming = db
      .select({ assignment: shiftAssignments, shift: shifts })
      .from(shiftAssignments)
      .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
      .where(and(eq(shiftAssignments.workerId, worker.id), inArray(shiftAssignments.status, ['REQUESTED', 'OFFERED', 'CONFIRMED']), gte(shifts.endsAt, at)))
      .orderBy(shifts.startsAt)
      .all();
    const rating = db.select({ avg: avg(ratings.score) }).from(ratings).where(eq(ratings.workerId, worker.id)).get();
    const login = worker.userId ? db.select({ id: users.id, email: users.email, status: users.status }).from(users).where(eq(users.id, worker.userId)).get() : null;
    res.json({
      ...stripPrivate(worker, own),
      compliance: complianceSummary(docs, worker.jobRole, at),
      documents: docs,
      unavailability,
      upcoming,
      averageRating: rating?.avg ? Number(rating.avg) : null,
      login,
    });
  }),
);

workersRouter.patch(
  '/:id',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const { worker } = loadWorker(req, req.params.id!);
    const body = parseBody(req, zWorker.partial());
    const at = now();
    db.update(workers).set({ ...body, updatedAt: at }).where(eq(workers.id, worker.id)).run();
    auditFromReq(req, db, { action: 'UPDATE', entityType: 'worker', entityId: worker.id, data: body }, at);
    res.json(db.select().from(workers).where(eq(workers.id, worker.id)).get());
  }),
);

/** Give a worker their own login so they can see and (if the employer allows) request shifts themselves. */
workersRouter.post(
  '/:id/login',
  requireRole(...MANAGERS),
  h(async (req, res) => {
    const { db, now } = deps(req);
    const { worker } = loadWorker(req, req.params.id!);
    if (worker.userId) throw conflict('Worker already has a login');
    const body = parseBody(req, z.object({ email: z.string().email().transform((e) => e.toLowerCase()), password: z.string().min(8).max(200) }));
    if (db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).get()) throw conflict('An account with that email already exists');
    const id = newId('usr');
    const at = now();
    db.insert(users).values({ id, orgId: worker.orgId, workerId: worker.id, email: body.email, passwordHash: await hashPassword(body.password), firstName: worker.firstName, lastName: worker.lastName, role: UserRole.WORKER, status: 'ACTIVE', createdAt: at }).run();
    db.update(workers).set({ userId: id, email: worker.email ?? body.email, updatedAt: at }).where(eq(workers.id, worker.id)).run();
    auditFromReq(req, db, { action: 'CREATE', entityType: 'user', entityId: id, data: { workerId: worker.id } }, at);
    res.status(201).json({ userId: id, email: body.email });
  }),
);

// ---------- Compliance documents ----------

const zDocument = z.object({
  type: z.nativeEnum(DocumentType),
  reference: z.string().trim().max(120).nullable().optional(),
  issuedAt: zOptionalDate,
  expiresAt: zOptionalDate,
  fileUrl: z.string().url().max(500).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

workersRouter.post(
  '/:id/documents',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const { worker } = loadWorker(req, req.params.id!);
    const body = parseBody(req, zDocument);
    const id = newId('doc');
    const at = now();
    db.insert(workerDocuments).values({ id, workerId: worker.id, ...body, verifiedAt: null, verifiedByUserId: null, createdAt: at }).run();
    auditFromReq(req, db, { action: 'CREATE', entityType: 'worker_document', entityId: id, data: { workerId: worker.id, type: body.type } }, at);
    res.status(201).json(db.select().from(workerDocuments).where(eq(workerDocuments.id, id)).get());
  }),
);

workersRouter.patch(
  '/:id/documents/:docId',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const { worker } = loadWorker(req, req.params.id!);
    const doc = db.select().from(workerDocuments).where(and(eq(workerDocuments.id, req.params.docId!), eq(workerDocuments.workerId, worker.id))).get();
    if (!doc) throw notFound('Document');
    const body = parseBody(req, zDocument.partial().extend({ verified: z.boolean().optional() }));
    const { verified, ...data } = body;
    const at = now();
    const verification = verified === undefined ? {} : verified ? { verifiedAt: at, verifiedByUserId: auth(req).user.id } : { verifiedAt: null, verifiedByUserId: null };
    db.update(workerDocuments).set({ ...data, ...verification }).where(eq(workerDocuments.id, doc.id)).run();
    auditFromReq(req, db, { action: verified ? 'APPROVE' : 'UPDATE', entityType: 'worker_document', entityId: doc.id, data: body }, at);
    res.json(db.select().from(workerDocuments).where(eq(workerDocuments.id, doc.id)).get());
  }),
);

workersRouter.delete(
  '/:id/documents/:docId',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const { worker } = loadWorker(req, req.params.id!);
    db.delete(workerDocuments).where(and(eq(workerDocuments.id, req.params.docId!), eq(workerDocuments.workerId, worker.id))).run();
    auditFromReq(req, db, { action: 'DELETE', entityType: 'worker_document', entityId: req.params.docId! }, now());
    res.status(204).end();
  }),
);

// ---------- Unavailability ----------

workersRouter.post(
  '/:id/unavailability',
  h((req, res) => {
    const { db, now } = deps(req);
    const { worker, own, self } = loadWorker(req, req.params.id!);
    if (!own && !self) throw forbidden();
    const body = parseBody(req, z.object({ startsAt: zDate, endsAt: zDate, reason: z.string().max(200).nullable().optional() }).refine((b) => b.endsAt > b.startsAt, { message: 'endsAt must be after startsAt' }));
    const id = newId('unv');
    db.insert(workerUnavailability).values({ id, workerId: worker.id, ...body, createdAt: now() }).run();
    res.status(201).json(db.select().from(workerUnavailability).where(eq(workerUnavailability.id, id)).get());
  }),
);

workersRouter.delete(
  '/:id/unavailability/:unavailabilityId',
  h((req, res) => {
    const { db } = deps(req);
    const { worker } = loadWorker(req, req.params.id!);
    db.delete(workerUnavailability).where(and(eq(workerUnavailability.id, req.params.unavailabilityId!), eq(workerUnavailability.workerId, worker.id))).run();
    res.status(204).end();
  }),
);
