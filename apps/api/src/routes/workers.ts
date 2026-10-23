import { Router, type NextFunction, type Request, type Response } from 'express';
import { and, avg, desc, eq, gte, inArray } from 'drizzle-orm';
import multer from 'multer';
import { z } from 'zod';
import { DocumentType, JobRole, Skill, UserRole, WorkerStatus, complianceSummary } from '@merge/shared';
import { ratings, shiftAssignments, shifts, sites, users, workerDocuments, workerUnavailability, workers } from '../db/schema.js';
import { auditFromReq } from '../lib/audit.js';
import { MANAGERS, allowedSiteIds, assertOrgAccess, hashPassword, isManager, isPlatformAdmin, isSiteScoped, requireAuth, requireRole } from '../lib/auth.js';
import { auth, deps } from '../lib/context.js';
import { HttpError, badRequest, conflict, forbidden, h, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { getStorage, newFileKey } from '../lib/storage.js';
import { assertChanges, parseBody, parseQuery, zDate, zOptionalDate, zPostcode } from '../lib/validate.js';
import { ALLOWED_DOCUMENT_MIME_TYPES, MAX_DOCUMENT_BYTES, activeDocuments, hostRequirementsForWorker, publicDocument } from '../services/compliance.js';

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
  /** Decision 10: the site this worker is based at (one of the organisation's own sites). */
  homeSiteId: z.string().nullable().optional(),
  /** Decision 14: the worker has consented to their profile being shown to other organisations. */
  consentToShare: z.boolean().optional(),
});

function resolveOrgId(req: Request, explicit?: string): string {
  if (explicit) {
    assertOrgAccess(req, explicit);
    return explicit;
  }
  return auth(req).org.id;
}

/**
 * Employers never see other employers' pay rates; hosts never see pay rates at all.
 * A manager limited to particular sites sees their colleagues' rota data but not pay or private notes.
 */
function stripPrivate(w: typeof workers.$inferSelect, canSeePrivate: boolean) {
  if (canSeePrivate) return w;
  const { hourlyPayRate: _p, notes: _n, ...rest } = w;
  return rest;
}

function canSeePrivate(req: Request, w: { orgId: string }): boolean {
  if (isPlatformAdmin(req)) return true;
  return w.orgId === auth(req).org.id && !isSiteScoped(req);
}

/** A home site must belong to the worker's organisation, and a site-limited manager may only use their own sites. */
function checkHomeSite(req: Request, orgId: string, homeSiteId: string | null | undefined): void {
  if (!homeSiteId) {
    if (homeSiteId === null && isSiteScoped(req)) throw forbidden('You are limited to particular sites and cannot unassign a worker from a site');
    return;
  }
  const { db } = deps(req);
  const site = db.select({ id: sites.id, orgId: sites.orgId }).from(sites).where(eq(sites.id, homeSiteId)).get();
  if (!site || site.orgId !== orgId) throw notFound('Site');
  const allowed = allowedSiteIds(req);
  if (allowed && !allowed.includes(homeSiteId)) throw forbidden('You are not assigned to that site');
}

workersRouter.get(
  '/',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const q = parseQuery(req, z.object({ orgId: z.string().optional(), status: z.nativeEnum(WorkerStatus).optional(), jobRole: z.nativeEnum(JobRole).optional(), siteId: z.string().optional(), compliance: z.enum(['COMPLIANT', 'EXPIRING', 'NON_COMPLIANT']).optional() }));
    const conditions = [];
    if (!(isPlatformAdmin(req) && !q.orgId)) conditions.push(eq(workers.orgId, resolveOrgId(req, q.orgId)));
    if (q.status) conditions.push(eq(workers.status, q.status));
    if (q.jobRole) conditions.push(eq(workers.jobRole, q.jobRole));
    if (q.siteId) conditions.push(eq(workers.homeSiteId, q.siteId));
    let rows = db.select().from(workers).where(conditions.length ? and(...conditions) : undefined).orderBy(workers.lastName, workers.firstName).all();
    const allowed = allowedSiteIds(req);
    if (allowed) rows = rows.filter((w) => !w.homeSiteId || allowed.includes(w.homeSiteId)); // unassigned workers stay visible to every manager
    const at = now();
    const docs = rows.length ? activeDocuments(db.select().from(workerDocuments).where(inArray(workerDocuments.workerId, rows.map((r) => r.id))).all()) : [];
    const homeSiteIds = [...new Set(rows.map((w) => w.homeSiteId).filter((x): x is string => !!x))];
    const siteRows = homeSiteIds.length ? db.select({ id: sites.id, name: sites.name }).from(sites).where(inArray(sites.id, homeSiteIds)).all() : [];
    const siteName = new Map(siteRows.map((s) => [s.id, s.name]));
    res.json(
      rows
        .map((w) => ({
          ...stripPrivate(w, canSeePrivate(req, w)),
          homeSiteName: w.homeSiteId ? siteName.get(w.homeSiteId) ?? null : null,
          compliance: complianceSummary(docs.filter((d) => d.workerId === w.id), w.jobRole, at),
        }))
        .filter((w) => !q.compliance || w.compliance.status === q.compliance),
    );
  }),
);

workersRouter.post(
  '/',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const body = parseBody(req, zWorker.extend({ orgId: z.string().optional() }));
    const { orgId: explicitOrg, consentToShare, ...data } = body;
    const orgId = resolveOrgId(req, explicitOrg);
    checkHomeSite(req, orgId, data.homeSiteId);
    const id = newId('wrk');
    const at = now();
    db.insert(workers).values({ id, orgId, ...data, consentToShareAt: consentToShare ? at : null, createdAt: at, updatedAt: at }).run();
    auditFromReq(req, db, { action: 'CREATE', entityType: 'worker', entityId: id }, at);
    res.status(201).json(db.select().from(workers).where(eq(workers.id, id)).get());
  }),
);

function loadWorker(req: Request, id: string) {
  const { db } = deps(req);
  const w = db.select().from(workers).where(eq(workers.id, id)).get();
  if (!w) throw notFound('Worker');
  const { user } = auth(req);
  const allowed = allowedSiteIds(req);
  const inScope = !allowed || !w.homeSiteId || allowed.includes(w.homeSiteId);
  const own = ((isManager(req) && w.orgId === user.orgId && inScope) || isPlatformAdmin(req)); // workers never get organisation-wide access
  const self = user.workerId === w.id && user.orgId === w.orgId;
  if (!own && !self) throw forbidden(isManager(req) && w.orgId === user.orgId ? 'That worker is based at a site you are not assigned to' : 'That worker belongs to another organisation');
  return { worker: w, own, self };
}

workersRouter.get(
  '/:id',
  h((req, res) => {
    const { db, now } = deps(req);
    const { worker, own, self } = loadWorker(req, req.params.id!);
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
    const login = worker.userId ? db.select({ id: users.id, email: users.email, status: users.status, totpEnabledAt: users.totpEnabledAt, lastLoginAt: users.lastLoginAt }).from(users).where(eq(users.id, worker.userId)).get() : null;
    const homeSite = worker.homeSiteId ? db.select({ id: sites.id, name: sites.name }).from(sites).where(eq(sites.id, worker.homeSiteId)).get() ?? null : null;
    res.json({
      ...stripPrivate(worker, own && canSeePrivate(req, worker)),
      homeSiteName: homeSite?.name ?? null,
      compliance: complianceSummary(activeDocuments(docs), worker.jobRole, at),
      documents: docs.map(publicDocument),
      hostRequirements: hostRequirementsForWorker(db, worker.id, at),
      unavailability,
      upcoming,
      averageRating: rating?.avg ? Number(rating.avg) : null,
      login: login ? { id: login.id, email: login.email, status: login.status, twoFactorEnabled: !!login.totpEnabledAt, lastLoginAt: login.lastLoginAt } : null,
      viewer: { canManage: own, isSelf: self },
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
    const { consentToShare, ...changes } = body;
    const patch: Partial<typeof workers.$inferInsert> = { ...changes };
    if (!canSeePrivate(req, worker)) {
      // Site-limited managers can run the rota but not change what the worker is paid.
      delete patch.hourlyPayRate;
      delete patch.notes;
    }
    if (changes.homeSiteId !== undefined) checkHomeSite(req, worker.orgId, changes.homeSiteId);
    if (consentToShare !== undefined) patch.consentToShareAt = consentToShare ? worker.consentToShareAt ?? now() : null;
    assertChanges(patch);
    const at = now();
    db.update(workers).set({ ...patch, updatedAt: at }).where(eq(workers.id, worker.id)).run();
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

/** Employer managers record documents for their workers; a worker may also add their own (unverified) for a manager to check. */
workersRouter.post(
  '/:id/documents',
  h((req, res) => {
    const { db, now } = deps(req);
    const { worker, own, self } = loadWorker(req, req.params.id!);
    if (!own && !self) throw forbidden();
    const body = parseBody(req, zDocument);
    const id = newId('doc');
    const at = now();
    db.insert(workerDocuments).values({ id, workerId: worker.id, ...body, verifiedAt: null, verifiedByUserId: null, uploadedByUserId: auth(req).user.id, createdAt: at }).run();
    auditFromReq(req, db, { action: 'CREATE', entityType: 'worker_document', entityId: id, data: { workerId: worker.id, type: body.type, bySelf: !own } }, at);
    res.status(201).json(publicDocument(db.select().from(workerDocuments).where(eq(workerDocuments.id, id)).get()!));
  }),
);

const IMMUTABLE_ONCE_VERIFIED = ['type', 'reference', 'issuedAt', 'expiresAt'] as const;

/**
 * Update a document. A verified document is an audit record: changing what was verified (type,
 * reference, dates) creates a fresh unverified document that replaces it, and the old one is kept
 * as superseded. Notes, the file link and the verification flag itself can change in place.
 */
workersRouter.patch(
  '/:id/documents/:docId',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const { worker } = loadWorker(req, req.params.id!);
    const doc = db.select().from(workerDocuments).where(and(eq(workerDocuments.id, req.params.docId!), eq(workerDocuments.workerId, worker.id))).get();
    if (!doc) throw notFound('Document');
    if (doc.supersededAt) throw conflict('This document has been replaced by a newer version and can no longer change');
    const body = parseBody(req, zDocument.partial().extend({ verified: z.boolean().optional() }));
    const { verified, ...data } = body;
    const at = now();
    const verification = verified === undefined ? {} : verified ? { verifiedAt: at, verifiedByUserId: auth(req).user.id } : { verifiedAt: null, verifiedByUserId: null };
    assertChanges({ ...data, ...verification });

    const substantive = doc.verifiedAt && IMMUTABLE_ONCE_VERIFIED.some((k) => data[k] !== undefined && String(data[k] instanceof Date ? (data[k] as Date).getTime() : data[k]) !== String(doc[k] instanceof Date ? (doc[k] as Date).getTime() : doc[k]));
    if (substantive) {
      const id = newId('doc');
      const { id: _old, verifiedAt: _va, verifiedByUserId: _vb, createdAt: _ca, supersededAt: _sa, replacesDocumentId: _r, ...carry } = doc;
      db.insert(workerDocuments)
        .values({ ...carry, ...data, id, verifiedAt: verified ? at : null, verifiedByUserId: verified ? auth(req).user.id : null, uploadedByUserId: auth(req).user.id, replacesDocumentId: doc.id, createdAt: at })
        .run();
      db.update(workerDocuments).set({ supersededAt: at }).where(eq(workerDocuments.id, doc.id)).run();
      auditFromReq(req, db, { action: 'UPDATE', entityType: 'worker_document', entityId: id, data: { ...body, replaces: doc.id } }, at);
      res.json(publicDocument(db.select().from(workerDocuments).where(eq(workerDocuments.id, id)).get()!));
      return;
    }
    db.update(workerDocuments).set({ ...data, ...verification }).where(eq(workerDocuments.id, doc.id)).run();
    auditFromReq(req, db, { action: verified ? 'APPROVE' : 'UPDATE', entityType: 'worker_document', entityId: doc.id, data: body }, at);
    res.json(publicDocument(db.select().from(workerDocuments).where(eq(workerDocuments.id, doc.id)).get()!));
  }),
);

workersRouter.delete(
  '/:id/documents/:docId',
  requireRole(...MANAGERS),
  h(async (req, res) => {
    const { db, now } = deps(req);
    const { worker } = loadWorker(req, req.params.id!);
    const doc = db.select().from(workerDocuments).where(and(eq(workerDocuments.id, req.params.docId!), eq(workerDocuments.workerId, worker.id))).get();
    if (!doc) throw notFound('Document');
    if (doc.verifiedAt && !doc.supersededAt) throw conflict('A verified document is part of the compliance record and cannot be deleted; correct it instead, which keeps the old version as history');
    if (doc.fileKey) await getStorage().delete(doc.fileKey);
    db.delete(workerDocuments).where(eq(workerDocuments.id, doc.id)).run();
    auditFromReq(req, db, { action: 'DELETE', entityType: 'worker_document', entityId: doc.id, data: { type: doc.type } }, now());
    res.status(204).end();
  }),
);

// ---------- Document files (decision 18) ----------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_DOCUMENT_MIME_TYPES[file.mimetype]) cb(null, true);
    else cb(new HttpError(415, 'Only PDF, JPEG and PNG files are accepted'));
  },
});

/** Run multer's single-file parser and turn its errors into API errors. */
function singleFile(field: string) {
  const mw = upload.single(field);
  return (req: Request, res: Response, next: NextFunction) => {
    mw(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof HttpError) return next(err);
      const code = (err as { code?: string }).code;
      if (code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, `File is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB`));
      if (code === 'LIMIT_UNEXPECTED_FILE') return next(badRequest(`Send the file in the "${field}" field`));
      next(err);
    });
  };
}

/** Attach the scanned document. Employer managers or the worker themselves; replaces any earlier file. */
workersRouter.post(
  '/:id/documents/:docId/file',
  singleFile('file'),
  h(async (req, res) => {
    const { db, now } = deps(req);
    const { worker, own, self } = loadWorker(req, req.params.id!);
    if (!own && !self) throw forbidden();
    const doc = db.select().from(workerDocuments).where(and(eq(workerDocuments.id, req.params.docId!), eq(workerDocuments.workerId, worker.id))).get();
    if (!doc) throw notFound('Document');
    if (doc.supersededAt) throw conflict('This document has been replaced; attach the file to the current version');
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) throw badRequest('No file received (send multipart/form-data with a "file" field)');
    const key = newFileKey(`documents/${worker.orgId}/${worker.id}`, ALLOWED_DOCUMENT_MIME_TYPES[file.mimetype] ?? 'bin');
    await getStorage().put(key, file.buffer, file.mimetype);
    if (doc.fileKey) await getStorage().delete(doc.fileKey).catch(() => undefined);
    const at = now();
    db.update(workerDocuments).set({ fileKey: key, fileName: file.originalname.slice(0, 200), mimeType: file.mimetype, fileSize: file.size, uploadedByUserId: auth(req).user.id }).where(eq(workerDocuments.id, doc.id)).run();
    auditFromReq(req, db, { action: 'UPDATE', entityType: 'worker_document', entityId: doc.id, data: { file: file.originalname, size: file.size, bySelf: !own } }, at);
    res.status(201).json(publicDocument(db.select().from(workerDocuments).where(eq(workerDocuments.id, doc.id)).get()!));
  }),
);

/** Download the scanned document: employer managers and the worker only. Hosts never see the documents themselves. */
workersRouter.get(
  '/:id/documents/:docId/file',
  h(async (req, res) => {
    const { db } = deps(req);
    const { worker, own, self } = loadWorker(req, req.params.id!);
    if (!own && !self) throw forbidden();
    const doc = db.select().from(workerDocuments).where(and(eq(workerDocuments.id, req.params.docId!), eq(workerDocuments.workerId, worker.id))).get();
    if (!doc) throw notFound('Document');
    if (!doc.fileKey) throw notFound('File');
    const stored = await getStorage().get(doc.fileKey);
    if (!stored) throw notFound('File');
    res.setHeader('Content-Type', doc.mimeType ?? stored.mimeType);
    res.setHeader('Content-Length', String(stored.body.length));
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${(doc.fileName ?? 'document').replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(stored.body);
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
