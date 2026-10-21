import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { CapacityFlagKind, CapacityFlagStatus, JobRole } from '@merge/shared';
import { capacityFlags, organisations, sites } from '../db/schema.js';
import { auditFromReq } from '../lib/audit.js';
import { MANAGERS, assertOrgAccess, isPlatformAdmin, requireAuth, requireRole } from '../lib/auth.js';
import { auth, deps } from '../lib/context.js';
import { conflict, h, notFound } from '../lib/errors.js';
import { parseBody, parseQuery, zDate } from '../lib/validate.js';
import { createFlag, networkCapacity, withdrawFlag } from '../services/capacity.js';

export const capacityRouter = Router();
capacityRouter.use(requireAuth);

const zFlag = z
  .object({
    orgId: z.string().optional(),
    kind: z.nativeEnum(CapacityFlagKind),
    jobRole: z.nativeEnum(JobRole).nullable().optional(),
    headcount: z.number().int().min(1).max(500).default(1),
    hoursRequested: z.number().positive().max(10_000),
    startsAt: zDate,
    endsAt: zDate,
    siteId: z.string().nullable().optional(),
    postcodeAreas: z.array(z.string().trim().min(1).max(4)).max(50).nullable().optional(),
    radiusKm: z.number().positive().max(500).nullable().optional(),
    note: z.string().max(1000).nullable().optional(),
  })
  .refine((b) => b.endsAt > b.startsAt, { message: 'endsAt must be after startsAt' });

/** My organisation's flags (platform admin: any org, or all with no orgId). */
capacityRouter.get(
  '/flags',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db } = deps(req);
    const q = parseQuery(req, z.object({ orgId: z.string().optional(), status: z.nativeEnum(CapacityFlagStatus).optional(), kind: z.nativeEnum(CapacityFlagKind).optional() }));
    const conditions = [];
    if (!(isPlatformAdmin(req) && !q.orgId)) {
      const orgId = q.orgId ?? auth(req).org.id;
      assertOrgAccess(req, orgId);
      conditions.push(eq(capacityFlags.orgId, orgId));
    }
    if (q.status) conditions.push(eq(capacityFlags.status, q.status));
    if (q.kind) conditions.push(eq(capacityFlags.kind, q.kind));
    const rows = db
      .select({ flag: capacityFlags, orgName: organisations.name })
      .from(capacityFlags)
      .innerJoin(organisations, eq(organisations.id, capacityFlags.orgId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(capacityFlags.createdAt))
      .all();
    res.json(rows.map(({ flag, orgName }) => ({ ...flag, orgName, hoursRemaining: Math.max(0, flag.hoursRequested - flag.hoursFilled) })));
  }),
);

/**
 * Raise a capacity flag. A SURPLUS flag says "we have staff who need hours" and puts the organisation
 * at the front of the queue for matching shifts; a SHORTAGE flag says "we will be posting shifts".
 */
capacityRouter.post(
  '/flags',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const body = parseBody(req, zFlag);
    const orgId = body.orgId ?? auth(req).org.id;
    assertOrgAccess(req, orgId);
    if (body.siteId && !db.select({ id: sites.id }).from(sites).where(and(eq(sites.id, body.siteId), eq(sites.orgId, orgId))).get()) throw notFound('Site');
    const at = now();
    if (body.endsAt.getTime() <= at.getTime()) throw conflict('The flag period has already ended');
    const flag = createFlag(db, auth(req).settings, { ...body, orgId, createdByUserId: auth(req).user.id }, at);
    auditFromReq(req, db, { action: 'CREATE', entityType: 'capacity_flag', entityId: flag.id, data: { kind: flag.kind, jobRole: flag.jobRole, hoursRequested: flag.hoursRequested } }, at);
    res.status(201).json({ ...flag, hoursRemaining: flag.hoursRequested });
  }),
);

capacityRouter.post(
  '/flags/:id/withdraw',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const flag = db.select().from(capacityFlags).where(eq(capacityFlags.id, req.params.id!)).get();
    if (!flag) throw notFound('Capacity flag');
    assertOrgAccess(req, flag.orgId);
    if (flag.status !== CapacityFlagStatus.ACTIVE) throw conflict(`Flag is already ${flag.status.toLowerCase()}`);
    const at = now();
    const updated = withdrawFlag(db, flag, at);
    auditFromReq(req, db, { action: 'CANCEL', entityType: 'capacity_flag', entityId: flag.id }, at);
    res.json(updated);
  }),
);

/** Live supply/demand across the network. Platform admins also see which organisations raised each flag. */
capacityRouter.get(
  '/network',
  h((req, res) => {
    const { db, now } = deps(req);
    res.json(networkCapacity(db, now(), isPlatformAdmin(req)));
  }),
);
