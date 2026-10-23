import { Router, type Request } from 'express';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { DocumentType, UserRole } from '@merge/shared';
import { hostRequirements, organisations, sites, workerDocuments, workerHostRequirements, workers } from '../db/schema.js';
import { auditFromReq } from '../lib/audit.js';
import { MANAGERS, allowedSiteIds, assertOrgAccess, isPlatformAdmin, requireAuth, requireRole } from '../lib/auth.js';
import { auth, deps } from '../lib/context.js';
import { conflict, forbidden, h, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { assertChanges, parseBody, parseQuery, zOptionalDate } from '../lib/validate.js';
import { complianceOverview, expiringDocuments, hostRequirementsForWorker, publicDocument, scopedWorkers, siteNames, verificationQueue } from '../services/compliance.js';

/**
 * Compliance: expiry reports, the verification queue and host-specific requirements (decisions 11 and 18).
 * Everything here is about an employer's own workers, so the documents themselves never cross organisations.
 */
export const complianceRouter = Router();
complianceRouter.use(requireAuth);

/** Which organisation's workers a report covers: the caller's, or any organisation for the platform admin. */
function reportOrg(req: Request, explicit?: string): string {
  if (explicit) {
    assertOrgAccess(req, explicit);
    return explicit;
  }
  return auth(req).org.id;
}

const zOrgQuery = z.object({ orgId: z.string().optional() });

complianceRouter.get(
  '/summary',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const q = parseQuery(req, zOrgQuery);
    const orgId = reportOrg(req, q.orgId);
    const rows = scopedWorkers(db, { orgId, siteIds: allowedSiteIds(req) });
    const at = now();
    const requirements = db.select({ id: hostRequirements.id }).from(hostRequirements).where(and(eq(hostRequirements.hostOrgId, orgId), isNull(hostRequirements.archivedAt))).all().length;
    res.json({ ...complianceOverview(db, rows, at), hostRequirements: requirements, asOf: at });
  }),
);

/** Documents expiring within `days` (default 60), already-expired ones included. */
complianceRouter.get(
  '/expiring',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const q = parseQuery(req, zOrgQuery.extend({ days: z.coerce.number().int().min(0).max(365).default(60), type: z.nativeEnum(DocumentType).optional(), siteId: z.string().optional() }));
    const orgId = reportOrg(req, q.orgId);
    let rows = scopedWorkers(db, { orgId, siteIds: allowedSiteIds(req) }).filter((w) => w.status === 'ACTIVE');
    if (q.siteId) rows = rows.filter((w) => w.homeSiteId === q.siteId);
    const names = siteNames(db, orgId);
    res.json(expiringDocuments(db, rows, now(), q.days, q.type).map((e) => ({ ...e, worker: { ...e.worker, homeSiteName: e.worker.homeSiteId ? names[e.worker.homeSiteId] ?? null : null } })));
  }),
);

complianceRouter.get(
  '/verification-queue',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db } = deps(req);
    const q = parseQuery(req, zOrgQuery);
    const orgId = reportOrg(req, q.orgId);
    const rows = scopedWorkers(db, { orgId, siteIds: allowedSiteIds(req) });
    const names = siteNames(db, orgId);
    res.json(verificationQueue(db, rows).map((e) => ({ ...e, worker: { ...e.worker, homeSiteName: e.worker.homeSiteId ? names[e.worker.homeSiteId] ?? null : null } })));
  }),
);

/** Verify several documents at once (after checking the originals). Only the employer's own managers. */
complianceRouter.post(
  '/verify',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const body = parseBody(req, z.object({ documentIds: z.array(z.string()).min(1).max(200) }));
    const docs = db.select().from(workerDocuments).where(inArray(workerDocuments.id, body.documentIds)).all();
    const workerIds = [...new Set(docs.map((d) => d.workerId))];
    const owners = workerIds.length ? db.select({ id: workers.id, orgId: workers.orgId, homeSiteId: workers.homeSiteId }).from(workers).where(inArray(workers.id, workerIds)).all() : [];
    const ownerById = new Map(owners.map((w) => [w.id, w]));
    const allowed = allowedSiteIds(req);
    const at = now();
    const verified: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of body.documentIds) {
      const d = docs.find((x) => x.id === id);
      const w = d ? ownerById.get(d.workerId) : undefined;
      if (!d || !w) {
        skipped.push({ id, reason: 'not found' });
        continue;
      }
      if (!isPlatformAdmin(req) && w.orgId !== auth(req).org.id) throw forbidden('That document belongs to another organisation');
      if (allowed && w.homeSiteId && !allowed.includes(w.homeSiteId)) throw forbidden('That worker is based at a site you are not assigned to');
      if (d.supersededAt) {
        skipped.push({ id, reason: 'superseded' });
        continue;
      }
      if (d.verifiedAt) {
        skipped.push({ id, reason: 'already verified' });
        continue;
      }
      db.update(workerDocuments).set({ verifiedAt: at, verifiedByUserId: auth(req).user.id }).where(eq(workerDocuments.id, d.id)).run();
      auditFromReq(req, db, { action: 'APPROVE', entityType: 'worker_document', entityId: d.id, data: { workerId: d.workerId, type: d.type, bulk: true } }, at);
      verified.push(d.id);
    }
    res.json({ verified, skipped });
  }),
);

// ---------- Host requirements (decision 11) ----------

const zRequirement = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  /** True when the host itself records who holds it (e.g. a site induction) rather than the employer declaring it. */
  recordedByHost: z.boolean().default(false),
});

/** A host's requirements. Any manager may read another host's list (to see what their workers would need); hosts manage their own. */
complianceRouter.get(
  '/requirements',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db } = deps(req);
    const q = parseQuery(req, z.object({ hostOrgId: z.string().optional(), includeArchived: z.enum(['true', 'false']).optional() }));
    const hostOrgId = q.hostOrgId ?? auth(req).org.id;
    const own = hostOrgId === auth(req).org.id || isPlatformAdmin(req);
    const rows = db
      .select({ requirement: hostRequirements, hostName: organisations.name })
      .from(hostRequirements)
      .innerJoin(organisations, eq(organisations.id, hostRequirements.hostOrgId))
      .where(and(eq(hostRequirements.hostOrgId, hostOrgId), own && q.includeArchived === 'true' ? undefined : isNull(hostRequirements.archivedAt)))
      .orderBy(hostRequirements.name)
      .all();
    const ids = rows.map((r) => r.requirement.id);
    const holders = ids.length ? db.select({ requirementId: workerHostRequirements.requirementId }).from(workerHostRequirements).where(inArray(workerHostRequirements.requirementId, ids)).all() : [];
    const counts = new Map<string, number>();
    for (const h of holders) counts.set(h.requirementId, (counts.get(h.requirementId) ?? 0) + 1);
    res.json(rows.map((r) => ({ ...r.requirement, hostName: r.hostName, holders: counts.get(r.requirement.id) ?? 0, own })));
  }),
);

complianceRouter.post(
  '/requirements',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const body = parseBody(req, zRequirement.extend({ hostOrgId: z.string().optional() }));
    const hostOrgId = reportOrg(req, body.hostOrgId);
    const id = newId('hrq');
    const at = now();
    db.insert(hostRequirements).values({ id, hostOrgId, name: body.name, description: body.description ?? null, recordedByHost: body.recordedByHost, createdAt: at }).run();
    auditFromReq(req, db, { action: 'CREATE', entityType: 'host_requirement', entityId: id, data: { name: body.name } }, at);
    res.status(201).json(db.select().from(hostRequirements).where(eq(hostRequirements.id, id)).get());
  }),
);

function loadRequirement(req: Request, id: string) {
  const { db } = deps(req);
  const r = db.select().from(hostRequirements).where(eq(hostRequirements.id, id)).get();
  if (!r) throw notFound('Requirement');
  return r;
}

complianceRouter.patch(
  '/requirements/:id',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const r = loadRequirement(req, req.params.id!);
    assertOrgAccess(req, r.hostOrgId);
    const body = parseBody(req, zRequirement.partial().extend({ archived: z.boolean().optional() }));
    const { archived, ...changes } = body;
    const at = now();
    const patch = { ...changes, ...(archived === undefined ? {} : { archivedAt: archived ? at : null }) };
    assertChanges(patch);
    db.update(hostRequirements).set(patch).where(eq(hostRequirements.id, r.id)).run();
    auditFromReq(req, db, { action: 'UPDATE', entityType: 'host_requirement', entityId: r.id, data: body }, at);
    res.json(db.select().from(hostRequirements).where(eq(hostRequirements.id, r.id)).get());
  }),
);

/** Archive a requirement: shifts that named it stop requiring it, and holders' records are kept. */
complianceRouter.delete(
  '/requirements/:id',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const r = loadRequirement(req, req.params.id!);
    assertOrgAccess(req, r.hostOrgId);
    const at = now();
    db.update(hostRequirements).set({ archivedAt: at }).where(eq(hostRequirements.id, r.id)).run();
    auditFromReq(req, db, { action: 'DELETE', entityType: 'host_requirement', entityId: r.id }, at);
    res.status(204).end();
  }),
);

/** Who holds a requirement: the host sees everyone recorded; an employer sees its own workers. */
complianceRouter.get(
  '/requirements/:id/workers',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const r = loadRequirement(req, req.params.id!);
    const me = auth(req).org.id;
    const rows = db
      .select({ workerId: workerHostRequirements.workerId, firstName: workers.firstName, lastName: workers.lastName, jobRole: workers.jobRole, orgId: workers.orgId, orgName: organisations.name, expiresAt: workerHostRequirements.expiresAt, documentId: workerHostRequirements.documentId, recordedAt: workerHostRequirements.createdAt })
      .from(workerHostRequirements)
      .innerJoin(workers, eq(workers.id, workerHostRequirements.workerId))
      .innerJoin(organisations, eq(organisations.id, workers.orgId))
      .where(eq(workerHostRequirements.requirementId, r.id))
      .all();
    const at = now();
    const visible = isPlatformAdmin(req) || r.hostOrgId === me ? rows : rows.filter((x) => x.orgId === me);
    res.json(visible.map((x) => ({ ...x, expired: !!x.expiresAt && x.expiresAt.getTime() <= at.getTime() })));
  }),
);

/**
 * Record that a worker holds a requirement. Employer-declared requirements are declared by the worker's
 * own managers; host-recorded ones (inductions) by the host. Re-recording updates expiry and evidence.
 */
complianceRouter.post(
  '/requirements/:id/workers',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const r = loadRequirement(req, req.params.id!);
    if (r.archivedAt) throw conflict('That requirement has been archived');
    const body = parseBody(req, z.object({ workerId: z.string(), expiresAt: zOptionalDate, documentId: z.string().nullable().optional() }));
    const worker = db.select({ id: workers.id, orgId: workers.orgId, homeSiteId: workers.homeSiteId }).from(workers).where(eq(workers.id, body.workerId)).get();
    if (!worker) throw notFound('Worker');
    const me = auth(req).org.id;
    const isEmployer = worker.orgId === me;
    const isHost = r.hostOrgId === me;
    if (!isPlatformAdmin(req)) {
      if (r.recordedByHost && !isHost) throw forbidden('Only the host records who holds this requirement');
      if (!r.recordedByHost && !isEmployer) throw forbidden('Only the worker\'s employer can declare this requirement');
      const allowed = allowedSiteIds(req);
      if (isEmployer && allowed && worker.homeSiteId && !allowed.includes(worker.homeSiteId)) throw forbidden('That worker is based at a site you are not assigned to');
    }
    if (body.documentId) {
      const doc = db.select({ id: workerDocuments.id }).from(workerDocuments).where(and(eq(workerDocuments.id, body.documentId), eq(workerDocuments.workerId, worker.id))).get();
      if (!doc) throw notFound('Document');
    }
    const at = now();
    const existing = db.select().from(workerHostRequirements).where(and(eq(workerHostRequirements.workerId, worker.id), eq(workerHostRequirements.requirementId, r.id))).get();
    if (existing) {
      db.update(workerHostRequirements).set({ expiresAt: body.expiresAt ?? null, documentId: body.documentId ?? null, recordedByUserId: auth(req).user.id, createdAt: at }).where(eq(workerHostRequirements.id, existing.id)).run();
    } else {
      db.insert(workerHostRequirements).values({ id: newId('whr'), workerId: worker.id, requirementId: r.id, expiresAt: body.expiresAt ?? null, documentId: body.documentId ?? null, recordedByUserId: auth(req).user.id, createdAt: at }).run();
    }
    auditFromReq(req, db, { action: existing ? 'UPDATE' : 'CREATE', entityType: 'worker_host_requirement', entityId: `${worker.id}:${r.id}`, data: { workerId: worker.id, requirementId: r.id, expiresAt: body.expiresAt ?? null } }, at);
    res.status(existing ? 200 : 201).json(hostRequirementsForWorker(db, worker.id, at).find((x) => x.requirementId === r.id));
  }),
);

complianceRouter.delete(
  '/requirements/:id/workers/:workerId',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const r = loadRequirement(req, req.params.id!);
    const worker = db.select({ id: workers.id, orgId: workers.orgId }).from(workers).where(eq(workers.id, req.params.workerId!)).get();
    if (!worker) throw notFound('Worker');
    const me = auth(req).org.id;
    if (!isPlatformAdmin(req) && !(r.recordedByHost ? r.hostOrgId === me : worker.orgId === me)) throw forbidden();
    db.delete(workerHostRequirements).where(and(eq(workerHostRequirements.workerId, worker.id), eq(workerHostRequirements.requirementId, r.id))).run();
    auditFromReq(req, db, { action: 'DELETE', entityType: 'worker_host_requirement', entityId: `${worker.id}:${r.id}` }, now());
    res.status(204).end();
  }),
);

/** The signed-in worker's own documents (for the "My documents" screen). */
complianceRouter.get(
  '/my-documents',
  requireRole(UserRole.WORKER),
  h((req, res) => {
    const { db, now } = deps(req);
    const { user } = auth(req);
    if (!user.workerId) throw notFound('Worker');
    const docs = db.select().from(workerDocuments).where(eq(workerDocuments.workerId, user.workerId)).all();
    const w = db.select().from(workers).where(eq(workers.id, user.workerId)).get();
    if (!w) throw notFound('Worker');
    const at = now();
    const site = w.homeSiteId ? db.select({ name: sites.name }).from(sites).where(eq(sites.id, w.homeSiteId)).get() : undefined;
    res.json({ workerId: w.id, jobRole: w.jobRole, homeSiteName: site?.name ?? null, documents: docs.filter((d) => !d.supersededAt).map(publicDocument), hostRequirements: hostRequirementsForWorker(db, w.id, at) });
  }),
);
