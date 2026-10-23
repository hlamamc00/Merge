import { Router } from 'express';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AgencyPosition, UserRole, addDays } from '@merge/shared';
import { auditLog, capacityFlags, organisations, platformSettings, shiftAssignments, shifts, timesheets, users, workers } from '../db/schema.js';
import { auditFromReq } from '../lib/audit.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { deps } from '../lib/context.js';
import { h } from '../lib/errors.js';
import { assertChanges, parseBody, parseQuery, zOptionalDate } from '../lib/validate.js';
import { approvalBlockers } from '../services/compliance.js';
import { tick } from '../services/scheduler.js';
import { getSettings } from '../services/settings.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole(UserRole.PLATFORM_ADMIN));

adminRouter.get('/settings', h((req, res) => res.json(getSettings(deps(req).db))));

adminRouter.patch(
  '/settings',
  h((req, res) => {
    const { db, now } = deps(req);
    const body = parseBody(
      req,
      z.object({
        platformName: z.string().trim().min(1).max(60).optional(),
        priorityWindowMinutes: z.number().int().min(0).max(7 * 24 * 60).optional(),
        agencyWindowMinutes: z.number().int().min(0).max(7 * 24 * 60).optional(),
        agencyPosition: z.nativeEnum(AgencyPosition).optional(),
        urgentThresholdMinutes: z.number().int().min(0).max(7 * 24 * 60).optional(),
        minLeadBeforeStartMinutes: z.number().int().min(0).max(24 * 60).optional(),
        preferredPartnersGetPriority: z.boolean().optional(),
        platformFeePct: z.number().min(0).max(50).optional(),
        currency: z.string().length(3).optional(),
        minRestHours: z.number().min(0).max(24).optional(),
        maxWeeklyHours: z.number().min(1).max(100).optional(),
        maxShiftHours: z.number().min(1).max(24).optional(),
        lateCancellationHours: z.number().min(0).max(168).optional(),
        nationalMinimumWage: z.number().min(0).max(100).optional(),
        employerOnCostPct: z.number().min(0).max(100).optional(),
        noShowWindowDays: z.number().int().min(1).max(365).optional(),
        noShowPriorityPenaltyThreshold: z.number().int().min(1).max(50).optional(),
        noShowPriorityPenaltyDays: z.number().int().min(1).max(365).optional(),
        noShowSuspensionThreshold: z.number().int().min(1).max(50).optional(),
        noShowRateThresholdPct: z.number().min(0).max(100).optional(),
        requestReminderHours: z.number().min(0).max(168).optional(),
        requestReminderBeforeStartHours: z.number().min(0).max(168).optional(),
        documentRetentionYears: z.number().int().min(1).max(30).optional(),
        mouVersion: z.string().trim().min(1).max(20).optional(),
        /** Decision 16: managers and admins must use an authenticator app. */
        twoFactorRequiredForManagers: z.boolean().optional(),
        defaultEscalationMode: z.enum(['MANUAL', 'AUTO']).optional(),
      }),
    );
    assertChanges(body);
    const at = now();
    db.update(platformSettings).set({ ...body, updatedAt: at }).where(eq(platformSettings.id, 'default')).run();
    auditFromReq(req, db, { action: 'UPDATE', entityType: 'platform_settings', entityId: 'default', data: body }, at);
    res.json(getSettings(db));
  }),
);

adminRouter.get(
  '/overview',
  h((req, res) => {
    const { db, now } = deps(req);
    const at = now();
    const since = addDays(at, -30);
    const count = (q: { get(): { c: number } | undefined }) => q.get()?.c ?? 0;
    const recent = db.select().from(shifts).where(gte(shifts.createdAt, since)).all();
    const closed = recent.filter((s) => ['FILLED', 'IN_PROGRESS', 'COMPLETED', 'EXPIRED'].includes(s.status));
    const activeFlags = db.select().from(capacityFlags).where(eq(capacityFlags.status, 'ACTIVE')).all();
    res.json({
      organisations: { total: count(db.select({ c: sql<number>`count(*)` }).from(organisations)), active: count(db.select({ c: sql<number>`count(*)` }).from(organisations).where(eq(organisations.status, 'ACTIVE'))) },
      workers: { total: count(db.select({ c: sql<number>`count(*)` }).from(workers)), shareable: count(db.select({ c: sql<number>`count(*)` }).from(workers).where(and(eq(workers.status, 'ACTIVE'), eq(workers.shareable, true)))) },
      shifts: {
        open: count(db.select({ c: sql<number>`count(*)` }).from(shifts).where(eq(shifts.status, 'OPEN'))),
        postedLast30d: recent.length,
        fillRatePct: closed.length ? Math.round((closed.filter((s) => s.filledCount >= s.headcount).length / closed.length) * 100) : null,
        urgentLast30d: recent.filter((s) => s.urgent).length,
      },
      capacity: {
        surplusHours: activeFlags.filter((f) => f.kind === 'SURPLUS').reduce((s, f) => s + Math.max(0, f.hoursRequested - f.hoursFilled), 0),
        shortageHours: activeFlags.filter((f) => f.kind === 'SHORTAGE').reduce((s, f) => s + Math.max(0, f.hoursRequested - f.hoursFilled), 0),
        surplusOrgs: new Set(activeFlags.filter((f) => f.kind === 'SURPLUS').map((f) => f.orgId)).size,
        shortageOrgs: new Set(activeFlags.filter((f) => f.kind === 'SHORTAGE').map((f) => f.orgId)).size,
      },
      bookings: {
        confirmedLast30d: count(db.select({ c: sql<number>`count(*)` }).from(shiftAssignments).where(and(gte(shiftAssignments.createdAt, since), sql`${shiftAssignments.status} in ('CONFIRMED','COMPLETED')`))),
        lateCancellationsLast30d: count(db.select({ c: sql<number>`count(*)` }).from(shiftAssignments).where(and(gte(shiftAssignments.createdAt, since), eq(shiftAssignments.lateCancellation, true)))),
        noShowsLast30d: count(db.select({ c: sql<number>`count(*)` }).from(shiftAssignments).where(and(gte(shiftAssignments.createdAt, since), eq(shiftAssignments.status, 'NO_SHOW')))),
      },
      money: {
        approvedChargeLast30d: db.select({ v: sql<number>`coalesce(sum(${timesheets.hostCost}),0)` }).from(timesheets).where(and(eq(timesheets.status, 'APPROVED'), gte(timesheets.approvedAt, since))).get()?.v ?? 0,
        platformFeeLast30d: db.select({ v: sql<number>`coalesce(sum(${timesheets.platformFee}),0)` }).from(timesheets).where(and(eq(timesheets.status, 'APPROVED'), gte(timesheets.approvedAt, since))).get()?.v ?? 0,
        timesheetsAwaitingApproval: count(db.select({ c: sql<number>`count(*)` }).from(timesheets).where(eq(timesheets.status, 'SUBMITTED'))),
      },
    });
  }),
);

/** Decision 12: the approval queue, with what each pending organisation still lacks. */
adminRouter.get(
  '/organisations',
  h((req, res) => {
    const { db } = deps(req);
    const q = parseQuery(req, z.object({ status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED']).optional() }));
    const rows = db.select().from(organisations).where(q.status ? eq(organisations.status, q.status) : undefined).orderBy(desc(organisations.createdAt)).all();
    const ids = rows.map((o) => o.id);
    const admins = ids.length ? db.select({ id: users.id, orgId: users.orgId, firstName: users.firstName, lastName: users.lastName, email: users.email, role: users.role, createdAt: users.createdAt }).from(users).where(and(inArray(users.orgId, ids), eq(users.role, 'ORG_ADMIN'))).all() : [];
    const workerCounts = ids.length ? db.select({ orgId: workers.orgId, c: sql<number>`count(*)` }).from(workers).where(inArray(workers.orgId, ids)).groupBy(workers.orgId).all() : [];
    const countByOrg = new Map(workerCounts.map((w) => [w.orgId, w.c]));
    res.json(
      rows.map((o) => {
        const admin = admins.filter((a) => a.orgId === o.id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null;
        return { ...o, blockers: approvalBlockers(o), workerCount: countByOrg.get(o.id) ?? 0, admin: admin ? { id: admin.id, name: `${admin.firstName} ${admin.lastName}`, email: admin.email } : null };
      }),
    );
  }),
);

/** Every login on the platform (for audit filters and support). */
adminRouter.get(
  '/users',
  h((req, res) => {
    const { db } = deps(req);
    const q = parseQuery(req, z.object({ orgId: z.string().optional(), q: z.string().optional() }));
    const rows = db
      .select({ id: users.id, orgId: users.orgId, orgName: organisations.name, email: users.email, firstName: users.firstName, lastName: users.lastName, role: users.role, status: users.status, totpEnabledAt: users.totpEnabledAt, lockedUntil: users.lockedUntil, lastLoginAt: users.lastLoginAt, createdAt: users.createdAt })
      .from(users)
      .innerJoin(organisations, eq(organisations.id, users.orgId))
      .where(q.orgId ? eq(users.orgId, q.orgId) : undefined)
      .orderBy(organisations.name, users.lastName, users.firstName)
      .all();
    const needle = q.q?.trim().toLowerCase();
    const filtered = needle ? rows.filter((u) => `${u.firstName} ${u.lastName} ${u.email} ${u.orgName}`.toLowerCase().includes(needle)) : rows;
    res.json(filtered.map(({ totpEnabledAt, ...u }) => ({ ...u, twoFactorEnabled: !!totpEnabledAt })));
  }),
);

adminRouter.get(
  '/audit',
  h((req, res) => {
    const { db } = deps(req);
    const q = parseQuery(req, z.object({ entityType: z.string().optional(), entityId: z.string().optional(), userId: z.string().optional(), orgId: z.string().optional(), action: z.string().optional(), from: zOptionalDate, to: zOptionalDate, limit: z.coerce.number().int().min(1).max(500).default(100) }));
    const rows = db
      .select()
      .from(auditLog)
      .where(
        and(
          q.entityType ? eq(auditLog.entityType, q.entityType) : undefined,
          q.entityId ? eq(auditLog.entityId, q.entityId) : undefined,
          q.userId ? eq(auditLog.actorUserId, q.userId) : undefined,
          q.orgId ? eq(auditLog.actorOrgId, q.orgId) : undefined,
          q.action ? eq(auditLog.action, q.action as typeof auditLog.$inferSelect.action) : undefined,
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

/** Run the background jobs immediately (useful for demos and tests). */
adminRouter.post(
  '/scheduler/tick',
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    res.json(tick(db, notifier, now()));
  }),
);
