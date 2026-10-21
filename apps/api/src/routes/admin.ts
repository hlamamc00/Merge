import { Router } from 'express';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AgencyPosition, UserRole, addDays } from '@merge/shared';
import { auditLog, capacityFlags, organisations, platformSettings, shiftAssignments, shifts, timesheets, workers } from '../db/schema.js';
import { auditFromReq } from '../lib/audit.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { deps } from '../lib/context.js';
import { h } from '../lib/errors.js';
import { parseBody, parseQuery } from '../lib/validate.js';
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
      }),
    );
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

adminRouter.get(
  '/audit',
  h((req, res) => {
    const { db } = deps(req);
    const q = parseQuery(req, z.object({ entityType: z.string().optional(), entityId: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }));
    const rows = db
      .select()
      .from(auditLog)
      .where(and(q.entityType ? eq(auditLog.entityType, q.entityType) : undefined, q.entityId ? eq(auditLog.entityId, q.entityId) : undefined))
      .orderBy(desc(auditLog.createdAt))
      .limit(q.limit)
      .all();
    res.json(rows);
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
