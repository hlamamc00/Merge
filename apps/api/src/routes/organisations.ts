import { Router } from 'express';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { RelationshipKind, ServiceType, UserRole, addDays } from '@merge/shared';
import { orgRelationships, organisations, shiftAssignments, shifts, sites, timesheets, users, workers } from '../db/schema.js';
import { auditFromReq } from '../lib/audit.js';
import { ADMINS, MANAGERS, assertOrgAccess, hashPassword, isPlatformAdmin, requireAuth, requireRole } from '../lib/auth.js';
import { auth, deps } from '../lib/context.js';
import { conflict, forbidden, h, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { parseBody, parseQuery, zPostcode } from '../lib/validate.js';
import { publicUser, zOrganisation } from './auth.js';

export const organisationsRouter = Router();
organisationsRouter.use(requireAuth);

/** Network directory. Everyone can see who is on the network; only platform admins see status and contact details. */
organisationsRouter.get(
  '/',
  h((req, res) => {
    const { db } = deps(req);
    const rows = isPlatformAdmin(req) ? db.select().from(organisations).all() : db.select().from(organisations).where(eq(organisations.status, 'ACTIVE')).all();
    res.json(rows.map((o) => (isPlatformAdmin(req) ? o : directoryView(o))));
  }),
);

organisationsRouter.get(
  '/:id',
  h((req, res) => {
    const { db } = deps(req);
    const org = db.select().from(organisations).where(eq(organisations.id, req.params.id!)).get();
    if (!org) throw notFound('Organisation');
    const own = auth(req).org.id === org.id || isPlatformAdmin(req);
    res.json(own ? org : directoryView(org));
  }),
);

organisationsRouter.patch(
  '/:id',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db, now } = deps(req);
    assertOrgAccess(req, req.params.id!);
    const body = parseBody(req, zOrganisation.partial().extend({ status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED']).optional() }));
    if (body.status && !isPlatformAdmin(req)) throw forbidden('Only the platform administrator can change an organisation\'s status');
    const at = now();
    db.update(organisations).set({ ...body, updatedAt: at }).where(eq(organisations.id, req.params.id!)).run();
    auditFromReq(req, db, { action: 'UPDATE', entityType: 'organisation', entityId: req.params.id!, data: body }, at);
    res.json(db.select().from(organisations).where(eq(organisations.id, req.params.id!)).get());
  }),
);

/** Headline numbers for an organisation's dashboard. */
organisationsRouter.get(
  '/:id/stats',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const orgId = req.params.id!;
    assertOrgAccess(req, orgId);
    const at = now();
    const since = addDays(at, -30);
    const posted = db.select().from(shifts).where(and(eq(shifts.hostOrgId, orgId), gte(shifts.createdAt, since))).all();
    const closed = posted.filter((s) => ['FILLED', 'IN_PROGRESS', 'COMPLETED', 'EXPIRED'].includes(s.status));
    const filled = closed.filter((s) => s.filledCount >= s.headcount);
    const supplied = db
      .select({ a: shiftAssignments, s: shifts })
      .from(shiftAssignments)
      .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
      .where(and(eq(shiftAssignments.supplierOrgId, orgId), gte(shiftAssignments.createdAt, since), inArray(shiftAssignments.status, ['CONFIRMED', 'COMPLETED'])))
      .all();
    const payable = db.select({ v: sql<number>`coalesce(sum(${timesheets.hostCost}),0)` }).from(timesheets).where(and(eq(timesheets.hostOrgId, orgId), eq(timesheets.status, 'APPROVED'), gte(timesheets.approvedAt, since))).get();
    const receivable = db.select({ v: sql<number>`coalesce(sum(${timesheets.supplierAmount}),0)` }).from(timesheets).where(and(eq(timesheets.supplierOrgId, orgId), eq(timesheets.status, 'APPROVED'), gte(timesheets.approvedAt, since))).get();
    const pendingTimesheets = db.select({ c: sql<number>`count(*)` }).from(timesheets).where(and(eq(timesheets.hostOrgId, orgId), eq(timesheets.status, 'SUBMITTED'))).get();
    const lateCancellations = db.select({ c: sql<number>`count(*)` }).from(shiftAssignments).where(and(eq(shiftAssignments.supplierOrgId, orgId), eq(shiftAssignments.lateCancellation, true), gte(shiftAssignments.cancelledAt, since))).get();
    res.json({
      periodDays: 30,
      shiftsPosted: posted.length,
      shiftsOpen: posted.filter((s) => s.status === 'OPEN').length,
      fillRatePct: closed.length ? Math.round((filled.length / closed.length) * 100) : null,
      shiftsSupplied: supplied.length,
      hoursSupplied: Math.round(supplied.reduce((sum, { s }) => sum + (s.endsAt.getTime() - s.startsAt.getTime()) / 3_600_000 - s.breakMinutes / 60, 0) * 10) / 10,
      approvedSpend: payable?.v ?? 0,
      approvedEarnings: receivable?.v ?? 0,
      timesheetsAwaitingApproval: pendingTimesheets?.c ?? 0,
      lateCancellations: lateCancellations?.c ?? 0,
    });
  }),
);

// ---------- Sites ----------

const zSite = z.object({
  name: z.string().trim().min(1).max(120),
  serviceType: z.nativeEnum(ServiceType).nullable().optional(),
  addressLine1: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  postcode: zPostcode,
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  accessNotes: z.string().max(2000).nullable().optional(),
});

organisationsRouter.get(
  '/:id/sites',
  h((req, res) => {
    const { db } = deps(req);
    assertOrgAccess(req, req.params.id!); // site addresses and access notes are released per shift, never listed cross-org
    res.json(db.select().from(sites).where(eq(sites.orgId, req.params.id!)).all());
  }),
);

organisationsRouter.post(
  '/:id/sites',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    assertOrgAccess(req, req.params.id!);
    const body = parseBody(req, zSite);
    const id = newId('site');
    const at = now();
    db.insert(sites).values({ id, orgId: req.params.id!, ...body, createdAt: at }).run();
    auditFromReq(req, db, { action: 'CREATE', entityType: 'site', entityId: id }, at);
    res.status(201).json(db.select().from(sites).where(eq(sites.id, id)).get());
  }),
);

organisationsRouter.patch(
  '/:id/sites/:siteId',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    assertOrgAccess(req, req.params.id!);
    const site = db.select().from(sites).where(and(eq(sites.id, req.params.siteId!), eq(sites.orgId, req.params.id!))).get();
    if (!site) throw notFound('Site');
    const body = parseBody(req, zSite.partial());
    db.update(sites).set(body).where(eq(sites.id, site.id)).run();
    auditFromReq(req, db, { action: 'UPDATE', entityType: 'site', entityId: site.id, data: body }, now());
    res.json(db.select().from(sites).where(eq(sites.id, site.id)).get());
  }),
);

organisationsRouter.delete(
  '/:id/sites/:siteId',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    assertOrgAccess(req, req.params.id!);
    const site = db.select().from(sites).where(and(eq(sites.id, req.params.siteId!), eq(sites.orgId, req.params.id!))).get();
    if (!site) throw notFound('Site');
    const used = db.select({ id: shifts.id }).from(shifts).where(eq(shifts.siteId, site.id)).get();
    if (used) throw conflict('Site has shifts attached and cannot be deleted');
    db.delete(sites).where(eq(sites.id, site.id)).run();
    auditFromReq(req, db, { action: 'DELETE', entityType: 'site', entityId: site.id }, now());
    res.status(204).end();
  }),
);

// ---------- Relationships (preferred partners / blocklist) ----------

organisationsRouter.get(
  '/:id/relationships',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db } = deps(req);
    assertOrgAccess(req, req.params.id!);
    const rows = db
      .select({ id: orgRelationships.id, otherOrgId: orgRelationships.otherOrgId, otherOrgName: organisations.name, kind: orgRelationships.kind, note: orgRelationships.note, createdAt: orgRelationships.createdAt })
      .from(orgRelationships)
      .innerJoin(organisations, eq(organisations.id, orgRelationships.otherOrgId))
      .where(eq(orgRelationships.orgId, req.params.id!))
      .all();
    res.json(rows);
  }),
);

organisationsRouter.put(
  '/:id/relationships/:otherOrgId',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db, now } = deps(req);
    const orgId = req.params.id!;
    const otherOrgId = req.params.otherOrgId!;
    assertOrgAccess(req, orgId);
    if (orgId === otherOrgId) throw conflict('An organisation cannot have a relationship with itself');
    if (!db.select({ id: organisations.id }).from(organisations).where(eq(organisations.id, otherOrgId)).get()) throw notFound('Organisation');
    const body = parseBody(req, z.object({ kind: z.nativeEnum(RelationshipKind), note: z.string().max(500).nullable().optional() }));
    const at = now();
    db.delete(orgRelationships).where(and(eq(orgRelationships.orgId, orgId), eq(orgRelationships.otherOrgId, otherOrgId))).run();
    db.insert(orgRelationships).values({ id: newId('rel'), orgId, otherOrgId, kind: body.kind, note: body.note ?? null, createdAt: at }).run();
    auditFromReq(req, db, { action: 'UPDATE', entityType: 'relationship', entityId: `${orgId}:${otherOrgId}`, data: body }, at);
    res.json({ orgId, otherOrgId, ...body });
  }),
);

organisationsRouter.delete(
  '/:id/relationships/:otherOrgId',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db, now } = deps(req);
    assertOrgAccess(req, req.params.id!);
    db.delete(orgRelationships).where(and(eq(orgRelationships.orgId, req.params.id!), eq(orgRelationships.otherOrgId, req.params.otherOrgId!))).run();
    auditFromReq(req, db, { action: 'DELETE', entityType: 'relationship', entityId: `${req.params.id}:${req.params.otherOrgId}` }, now());
    res.status(204).end();
  }),
);

// ---------- Users ----------

organisationsRouter.get(
  '/:id/users',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db } = deps(req);
    assertOrgAccess(req, req.params.id!);
    res.json(db.select().from(users).where(eq(users.orgId, req.params.id!)).orderBy(desc(users.createdAt)).all().map(publicUser));
  }),
);

organisationsRouter.post(
  '/:id/users',
  requireRole(...ADMINS),
  h(async (req, res) => {
    const { db, now } = deps(req);
    const orgId = req.params.id!;
    assertOrgAccess(req, orgId);
    const body = parseBody(
      req,
      z.object({
        email: z.string().email().transform((e) => e.toLowerCase()),
        password: z.string().min(8).max(200),
        firstName: z.string().trim().min(1).max(60),
        lastName: z.string().trim().min(1).max(60),
        role: z.enum([UserRole.ORG_ADMIN, UserRole.ORG_MANAGER, UserRole.WORKER, UserRole.PLATFORM_ADMIN]),
        workerId: z.string().nullable().optional(),
      }),
    );
    if (body.role === UserRole.PLATFORM_ADMIN && !isPlatformAdmin(req)) throw forbidden('Only platform administrators can create platform administrators');
    if (db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).get()) throw conflict('An account with that email already exists');
    const linkedWorker = body.workerId ? db.select().from(workers).where(and(eq(workers.id, body.workerId), eq(workers.orgId, orgId))).get() : undefined;
    if (body.workerId && !linkedWorker) throw notFound('Worker');
    if (linkedWorker?.userId) throw conflict('Worker already has a login');
    const id = newId('usr');
    const at = now();
    db.insert(users).values({ id, orgId, email: body.email, passwordHash: await hashPassword(body.password), firstName: body.firstName, lastName: body.lastName, role: body.role, workerId: linkedWorker?.id ?? null, status: 'ACTIVE', createdAt: at }).run();
    if (linkedWorker) db.update(workers).set({ userId: id, updatedAt: at }).where(eq(workers.id, linkedWorker.id)).run();
    auditFromReq(req, db, { action: 'CREATE', entityType: 'user', entityId: id, data: { role: body.role, workerId: linkedWorker?.id } }, at);
    res.status(201).json(publicUser(db.select().from(users).where(eq(users.id, id)).get()!));
  }),
);

organisationsRouter.patch(
  '/:id/users/:userId',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db, now } = deps(req);
    assertOrgAccess(req, req.params.id!);
    const user = db.select().from(users).where(and(eq(users.id, req.params.userId!), eq(users.orgId, req.params.id!))).get();
    if (!user) throw notFound('User');
    const body = parseBody(req, z.object({ role: z.enum([UserRole.ORG_ADMIN, UserRole.ORG_MANAGER, UserRole.WORKER]).optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional(), firstName: z.string().trim().min(1).max(60).optional(), lastName: z.string().trim().min(1).max(60).optional() }));
    if (user.id === auth(req).user.id && body.status === 'DISABLED') throw conflict('You cannot disable your own account');
    db.update(users).set(body).where(eq(users.id, user.id)).run();
    auditFromReq(req, db, { action: 'UPDATE', entityType: 'user', entityId: user.id, data: body }, now());
    res.json(publicUser(db.select().from(users).where(eq(users.id, user.id)).get()!));
  }),
);

function directoryView(o: typeof organisations.$inferSelect) {
  return { id: o.id, name: o.name, type: o.type, serviceTypes: o.serviceTypes, city: o.city, postcode: o.postcode, status: o.status };
}
