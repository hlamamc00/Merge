import { Router } from 'express';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { RelationshipKind, ServiceType, UserRole, addDays } from '@merge/shared';
import { auditLog, orgRelationships, organisations, shiftAssignments, shifts, sites, timesheets, users, workers } from '../db/schema.js';
import { auditFromReq } from '../lib/audit.js';
import { ADMINS, MANAGERS, allowedSiteIds, assertOrgAccess, assertSiteAccess, hashPassword, isPlatformAdmin, isSiteScoped, requireAuth, requireRole } from '../lib/auth.js';
import { auth, deps } from '../lib/context.js';
import { conflict, forbidden, h, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { assertChanges, parseBody, parseQuery, zOptionalDate, zPostcode } from '../lib/validate.js';
import { approvalBlockers, mouDocument } from '../services/compliance.js';
import { getSettings } from '../services/settings.js';
import { publicUser, zOrganisation } from './auth.js';

export const organisationsRouter = Router();

/** Decision 12: the memorandum of understanding, readable before registering (no login needed). */
organisationsRouter.get(
  '/mou',
  h((req, res) => {
    const { db } = deps(req);
    res.json(mouDocument(getSettings(db).mouVersion));
  }),
);

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
    const body = parseBody(
      req,
      zOrganisation.partial().extend({
        status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED']).optional(),
        suspendedReason: z.string().trim().max(500).nullable().optional(),
        /** Decision 6: how unfilled shifts are handled close to their start. */
        escalationMode: z.enum(['MANUAL', 'AUTO']).optional(),
        escalationCeilingPct: z.number().min(0).max(100).optional(),
      }),
    );
    if ((body.status || body.suspendedReason !== undefined) && !isPlatformAdmin(req)) throw forbidden('Only the platform administrator can change an organisation\'s status');
    assertChanges(body);
    const at = now();
    const statusExtras = body.status === 'ACTIVE' ? { suspendedReason: null } : {};
    db.update(organisations).set({ ...body, ...statusExtras, updatedAt: at }).where(eq(organisations.id, req.params.id!)).run();
    auditFromReq(req, db, { action: 'UPDATE', entityType: 'organisation', entityId: req.params.id!, data: body }, at);
    res.json(db.select().from(organisations).where(eq(organisations.id, req.params.id!)).get());
  }),
);

/**
 * Decision 12: activate a pending organisation. Refused until the organisation has a regulator
 * registration number and has accepted the MOU, unless the platform administrator overrides (audited).
 */
organisationsRouter.post(
  '/:id/approve',
  requireRole(UserRole.PLATFORM_ADMIN),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const org = db.select().from(organisations).where(eq(organisations.id, req.params.id!)).get();
    if (!org) throw notFound('Organisation');
    const body = parseBody(req, z.object({ override: z.boolean().optional(), note: z.string().trim().max(500).optional() }));
    if (org.status === 'ACTIVE') throw conflict('Organisation is already active');
    const blockers = approvalBlockers(org);
    if (blockers.length > 0 && !body.override) throw conflict('Organisation cannot be approved yet', { blockers });
    const at = now();
    db.update(organisations).set({ status: 'ACTIVE', suspendedReason: null, updatedAt: at }).where(eq(organisations.id, org.id)).run();
    auditFromReq(req, db, { action: 'APPROVE', entityType: 'organisation', entityId: org.id, data: { override: blockers.length > 0, overriddenBlockers: blockers.length > 0 ? blockers : undefined, note: body.note } }, at);
    notifier.send({ orgId: org.id, type: 'SYSTEM', title: 'Your organisation has been approved', body: `${org.name} is now active on the network: you can post shifts and make workers available.`, data: { organisationId: org.id } });
    res.json(db.select().from(organisations).where(eq(organisations.id, org.id)).get());
  }),
);

/** Decision 12: where a pending organisation stands against the approval checks. */
organisationsRouter.get(
  '/:id/approval',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db } = deps(req);
    assertOrgAccess(req, req.params.id!);
    const org = db.select().from(organisations).where(eq(organisations.id, req.params.id!)).get();
    if (!org) throw notFound('Organisation');
    res.json({ status: org.status, blockers: approvalBlockers(org), mouAcceptedAt: org.mouAcceptedAt, mouVersion: org.mouVersion, currentMouVersion: getSettings(db).mouVersion, cqcRegistrationNumber: org.cqcRegistrationNumber });
  }),
);

/** Decision 12: accept (or re-accept a newer version of) the MOU after registration. */
organisationsRouter.post(
  '/:id/mou/accept',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db, now } = deps(req);
    assertOrgAccess(req, req.params.id!);
    const at = now();
    const version = getSettings(db).mouVersion;
    db.update(organisations).set({ mouAcceptedAt: at, mouVersion: version, mouAcceptedByUserId: auth(req).user.id, updatedAt: at }).where(eq(organisations.id, req.params.id!)).run();
    auditFromReq(req, db, { action: 'APPROVE', entityType: 'organisation', entityId: req.params.id!, data: { mouAccepted: true, mouVersion: version } }, at);
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
    const allowed = allowedSiteIds(req);
    const rows = db.select().from(sites).where(eq(sites.orgId, req.params.id!)).all();
    res.json(allowed ? rows.filter((s) => allowed.includes(s.id)) : rows);
  }),
);

organisationsRouter.post(
  '/:id/sites',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    assertOrgAccess(req, req.params.id!);
    if (isSiteScoped(req)) throw forbidden('Managers limited to particular sites cannot add sites');
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
    assertSiteAccess(req, site.id);
    const body = parseBody(req, zSite.partial());
    assertChanges(body);
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
    if (isSiteScoped(req)) throw forbidden('Managers limited to particular sites cannot delete sites');
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
        /** Decision 10: limit an organisation manager to these sites (null or empty = all sites). */
        siteIds: z.array(z.string()).nullable().optional(),
        phone: z.string().trim().max(30).nullable().optional(),
      }),
    );
    if (body.role === UserRole.PLATFORM_ADMIN && !isPlatformAdmin(req)) throw forbidden('Only platform administrators can create platform administrators');
    const siteIds = normaliseSiteIds(db, orgId, body.role, body.siteIds);
    if (db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).get()) throw conflict('An account with that email already exists');
    const linkedWorker = body.workerId ? db.select().from(workers).where(and(eq(workers.id, body.workerId), eq(workers.orgId, orgId))).get() : undefined;
    if (body.workerId && !linkedWorker) throw notFound('Worker');
    if (linkedWorker?.userId) throw conflict('Worker already has a login');
    const id = newId('usr');
    const at = now();
    db.insert(users).values({ id, orgId, email: body.email, passwordHash: await hashPassword(body.password), firstName: body.firstName, lastName: body.lastName, role: body.role, workerId: linkedWorker?.id ?? null, siteIds, phone: body.phone ?? null, status: 'ACTIVE', createdAt: at }).run();
    if (linkedWorker) db.update(workers).set({ userId: id, updatedAt: at }).where(eq(workers.id, linkedWorker.id)).run();
    auditFromReq(req, db, { action: 'CREATE', entityType: 'user', entityId: id, data: { role: body.role, workerId: linkedWorker?.id, siteIds } }, at);
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
    const body = parseBody(
      req,
      z.object({
        role: z.enum([UserRole.ORG_ADMIN, UserRole.ORG_MANAGER, UserRole.WORKER]).optional(),
        status: z.enum(['ACTIVE', 'DISABLED']).optional(),
        firstName: z.string().trim().min(1).max(60).optional(),
        lastName: z.string().trim().min(1).max(60).optional(),
        phone: z.string().trim().max(30).nullable().optional(),
        siteIds: z.array(z.string()).nullable().optional(),
        /** Platform or organisation admin resets a user's authenticator (lost phone). */
        resetTwoFactor: z.boolean().optional(),
      }),
    );
    if (user.id === auth(req).user.id && body.status === 'DISABLED') throw conflict('You cannot disable your own account');
    const { resetTwoFactor, ...changes } = body;
    const patch: Partial<typeof users.$inferInsert> = { ...changes };
    if (body.siteIds !== undefined) patch.siteIds = normaliseSiteIds(db, user.orgId, body.role ?? user.role, body.siteIds);
    if (body.role && body.role !== UserRole.ORG_MANAGER && body.siteIds === undefined) patch.siteIds = null; // only managers are site-limited
    if (resetTwoFactor) {
      patch.totpSecret = null;
      patch.totpEnabledAt = null;
    }
    assertChanges(patch);
    db.update(users).set(patch).where(eq(users.id, user.id)).run();
    auditFromReq(req, db, { action: 'UPDATE', entityType: 'user', entityId: user.id, data: { ...changes, resetTwoFactor: resetTwoFactor || undefined } }, now());
    res.json(publicUser(db.select().from(users).where(eq(users.id, user.id)).get()!));
  }),
);

/** What an organisation's own administrators did on the platform, filterable by user and period. */
organisationsRouter.get(
  '/:id/audit',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db } = deps(req);
    assertOrgAccess(req, req.params.id!);
    const q = parseQuery(req, z.object({ userId: z.string().optional(), entityType: z.string().optional(), from: zOptionalDate, to: zOptionalDate, limit: z.coerce.number().int().min(1).max(500).default(100) }));
    const rows = db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorOrgId, req.params.id!),
          q.userId ? eq(auditLog.actorUserId, q.userId) : undefined,
          q.entityType ? eq(auditLog.entityType, q.entityType) : undefined,
          q.from ? gte(auditLog.createdAt, q.from) : undefined,
          q.to ? lte(auditLog.createdAt, q.to) : undefined,
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(q.limit)
      .all();
    const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x))];
    const actors = actorIds.length ? db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email }).from(users).where(inArray(users.id, actorIds)).all() : [];
    const byId = new Map(actors.map((a) => [a.id, a]));
    res.json(rows.map((r) => ({ ...r, actor: r.actorUserId ? byId.get(r.actorUserId) ?? null : null })));
  }),
);

/** Site restrictions only apply to organisation managers and must name the organisation's own sites. */
function normaliseSiteIds(db: ReturnType<typeof deps>['db'], orgId: string, role: string, siteIds: string[] | null | undefined): string[] | null {
  if (!siteIds || siteIds.length === 0) return null;
  if (role !== UserRole.ORG_MANAGER) throw conflict('Only organisation managers can be limited to particular sites');
  const unique = [...new Set(siteIds)];
  const found = db.select({ id: sites.id }).from(sites).where(and(eq(sites.orgId, orgId), inArray(sites.id, unique))).all();
  if (found.length !== unique.length) throw notFound('Site');
  return unique;
}

function directoryView(o: typeof organisations.$inferSelect) {
  return { id: o.id, name: o.name, type: o.type, serviceTypes: o.serviceTypes, city: o.city, postcode: o.postcode, status: o.status };
}
