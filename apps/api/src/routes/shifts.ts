import { Router } from 'express';
import { and, asc, desc, eq, gt, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import { DocumentType, JobRole, ShiftStatus, ShiftVisibility, Skill, UserRole, roleCanCover, shiftPaidHours } from '@merge/shared';
import { organisations, ratings, shiftAccess, shiftAssignments, shifts, sites, workers, type Shift } from '../db/schema.js';
import { auditFromReq } from '../lib/audit.js';
import { MANAGERS, assertOrgAccess, isManager, isPlatformAdmin, requireAuth, requireRole } from '../lib/auth.js';
import { auth, deps } from '../lib/context.js';
import { conflict, forbidden, h, notFound, unprocessable } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { parseBody, parseQuery, zDate } from '../lib/validate.js';
import { offerShift, requestShift } from '../services/assignments.js';
import { accessFor, buildPlan, notifyDueAccess, planForShift } from '../services/dispatch.js';
import { evaluateWorkerForShift } from '../services/eligibility.js';
import { cancelShift, loadSiteForOrg, publishShift } from '../services/shifts.js';

export const shiftsRouter = Router();
shiftsRouter.use(requireAuth);

const zShift = z
  .object({
    hostOrgId: z.string().optional(),
    siteId: z.string(),
    jobRole: z.nativeEnum(JobRole),
    title: z.string().trim().min(2).max(120),
    description: z.string().max(4000).nullable().optional(),
    startsAt: zDate,
    endsAt: zDate,
    breakMinutes: z.number().int().min(0).max(240).default(0),
    headcount: z.number().int().min(1).max(50).default(1),
    requiredSkills: z.array(z.nativeEnum(Skill)).default([]),
    extraRequiredDocuments: z.array(z.nativeEnum(DocumentType)).default([]),
    chargeRate: z.number().positive().max(500),
    visibility: z.nativeEnum(ShiftVisibility).default('NETWORK'),
    priorityWindowMinutesOverride: z.number().int().min(0).max(7 * 24 * 60).nullable().optional(),
    autoConfirm: z.boolean().default(false),
    publish: z.boolean().default(false),
  })
  .refine((b) => b.endsAt > b.startsAt, { message: 'endsAt must be after startsAt' });

const EDITABLE_WHEN_OPEN = ['title', 'description', 'chargeRate', 'headcount', 'autoConfirm', 'breakMinutes', 'requiredSkills', 'extraRequiredDocuments'] as const;

function publicShift(s: Shift) {
  return { ...s, paidHours: shiftPaidHours(s.startsAt, s.endsAt, s.breakMinutes), placesLeft: Math.max(0, s.headcount - s.filledCount) };
}

/**
 * scope=posted    shifts my organisation hosts
 * scope=available shifts other organisations have released (or will release) to mine
 * scope=supplied  shifts my organisation has requested / been booked on
 * scope=all       platform admin only
 */
shiftsRouter.get(
  '/',
  h((req, res) => {
    const { db, now } = deps(req);
    const { user, org } = auth(req);
    const q = parseQuery(
      req,
      z.object({
        scope: z.enum(['posted', 'available', 'supplied', 'all']).default(user.role === UserRole.WORKER ? 'available' : 'posted'),
        status: z.nativeEnum(ShiftStatus).optional(),
        jobRole: z.nativeEnum(JobRole).optional(),
        from: zDate.optional(),
        to: zDate.optional(),
        orgId: z.string().optional(),
        includePast: z.coerce.boolean().default(false),
      }),
    );
    const at = now();
    const base = [];
    if (q.status) base.push(eq(shifts.status, q.status));
    if (q.jobRole) base.push(eq(shifts.jobRole, q.jobRole));
    if (q.from) base.push(gte(shifts.startsAt, q.from));
    if (q.to) base.push(lte(shifts.startsAt, q.to));

    if (q.scope === 'all') {
      if (!isPlatformAdmin(req)) throw forbidden();
      const rows = db
        .select({ shift: shifts, site: sites, hostName: organisations.name })
        .from(shifts)
        .innerJoin(sites, eq(sites.id, shifts.siteId))
        .innerJoin(organisations, eq(organisations.id, shifts.hostOrgId))
        .where(and(...base, q.orgId ? eq(shifts.hostOrgId, q.orgId) : undefined))
        .orderBy(desc(shifts.startsAt))
        .all();
      return res.json(rows.map(({ shift, site, hostName }) => ({ ...publicShift(shift), site, hostName })));
    }

    if (q.scope === 'posted') {
      if (!isManager(req)) throw forbidden();
      const hostOrgId = q.orgId ?? org.id;
      assertOrgAccess(req, hostOrgId);
      const rows = db
        .select({ shift: shifts, site: sites })
        .from(shifts)
        .innerJoin(sites, eq(sites.id, shifts.siteId))
        .where(and(eq(shifts.hostOrgId, hostOrgId), ...base, q.includePast ? undefined : gte(shifts.endsAt, at)))
        .orderBy(asc(shifts.startsAt))
        .all();
      const ids = rows.map((r) => r.shift.id);
      const pending = ids.length
        ? db.select().from(shiftAssignments).where(and(inArray(shiftAssignments.shiftId, ids), inArray(shiftAssignments.status, ['REQUESTED', 'OFFERED', 'CONFIRMED']))).all()
        : [];
      return res.json(
        rows.map(({ shift, site }) => ({
          ...publicShift(shift),
          site,
          pendingRequests: pending.filter((a) => a.shiftId === shift.id && a.status === 'REQUESTED').length,
          confirmed: pending.filter((a) => a.shiftId === shift.id && a.status === 'CONFIRMED').length,
        })),
      );
    }

    if (q.scope === 'supplied') {
      const supplierOrgId = q.orgId ?? org.id;
      assertOrgAccess(req, supplierOrgId);
      const rows = db
        .select({ assignment: shiftAssignments, shift: shifts, site: sites, hostName: organisations.name, worker: workers })
        .from(shiftAssignments)
        .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
        .innerJoin(sites, eq(sites.id, shifts.siteId))
        .innerJoin(organisations, eq(organisations.id, shifts.hostOrgId))
        .innerJoin(workers, eq(workers.id, shiftAssignments.workerId))
        .where(
          and(
            eq(shiftAssignments.supplierOrgId, supplierOrgId),
            user.role === UserRole.WORKER ? eq(shiftAssignments.workerId, user.workerId ?? '') : undefined,
            ...base,
            q.includePast ? undefined : gte(shifts.endsAt, at),
          ),
        )
        .orderBy(asc(shifts.startsAt))
        .all();
      return res.json(
        rows.map(({ assignment, shift, site, hostName, worker }) => ({
          ...publicShift(shift),
          site: siteForGuest(site),
          hostName,
          assignment,
          worker: { id: worker.id, firstName: worker.firstName, lastName: worker.lastName, jobRole: worker.jobRole },
        })),
      );
    }

    // scope=available
    const myWorker = user.role === UserRole.WORKER && user.workerId ? db.select().from(workers).where(eq(workers.id, user.workerId)).get() : null;
    if (user.role === UserRole.WORKER && !org.workerSelfServiceAllowed) return res.json([]);
    const rows = db
      .select({ shift: shifts, site: sites, hostName: organisations.name, access: shiftAccess })
      .from(shiftAccess)
      .innerJoin(shifts, eq(shifts.id, shiftAccess.shiftId))
      .innerJoin(sites, eq(sites.id, shifts.siteId))
      .innerJoin(organisations, eq(organisations.id, shifts.hostOrgId))
      .where(and(eq(shiftAccess.orgId, org.id), eq(shifts.status, ShiftStatus.OPEN), gt(shifts.startsAt, at), ...base))
      .orderBy(asc(shiftAccess.opensAt), asc(shifts.startsAt))
      .all();
    const mine = rows.length
      ? db.select().from(shiftAssignments).where(and(inArray(shiftAssignments.shiftId, rows.map((r) => r.shift.id)), eq(shiftAssignments.supplierOrgId, org.id), inArray(shiftAssignments.status, ['REQUESTED', 'OFFERED', 'CONFIRMED']))).all()
      : [];
    res.json(
      rows
        .filter(({ shift }) => !myWorker || roleCanCover(myWorker.jobRole, shift.jobRole))
        .map(({ shift, site, hostName, access }) => ({
          ...publicShift(shift),
          site: siteForGuest(site),
          hostName,
          access: { tier: access.tier, opensAt: access.opensAt, open: access.opensAt.getTime() <= at.getTime(), reason: access.reason },
          myAssignments: mine.filter((a) => a.shiftId === shift.id),
        })),
    );
  }),
);

shiftsRouter.post(
  '/',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { user, org, settings } = auth(req);
    const body = parseBody(req, zShift);
    const hostOrgId = body.hostOrgId ?? org.id;
    assertOrgAccess(req, hostOrgId);
    const site = loadSiteForOrg(db, body.siteId, hostOrgId);
    if (!site) throw notFound('Site');
    const at = now();
    if (body.startsAt.getTime() <= at.getTime()) throw unprocessable('Shift must start in the future');
    const { publish, hostOrgId: _h, ...data } = body;
    const id = newId('shf');
    db.insert(shifts).values({ id, hostOrgId, ...data, currency: settings.currency, status: ShiftStatus.DRAFT, createdByUserId: user.id, createdAt: at, updatedAt: at }).run();
    let shift = db.select().from(shifts).where(eq(shifts.id, id)).get()!;
    auditFromReq(req, db, { action: 'CREATE', entityType: 'shift', entityId: id }, at);
    if (publish) {
      shift = publishShift(db, notifier, settings, shift, site, at);
      auditFromReq(req, db, { action: 'PUBLISH', entityType: 'shift', entityId: id }, at);
    }
    res.status(201).json({ ...publicShift(shift), site, plan: planForShift(db, id) });
  }),
);

function loadShift(req: Parameters<typeof deps>[0], id: string) {
  const { db } = deps(req);
  const row = db.select({ shift: shifts, site: sites, hostName: organisations.name }).from(shifts).innerJoin(sites, eq(sites.id, shifts.siteId)).innerJoin(organisations, eq(organisations.id, shifts.hostOrgId)).where(eq(shifts.id, id)).get();
  if (!row) throw notFound('Shift');
  return row;
}

function siteForGuest(site: typeof sites.$inferSelect) {
  return { id: site.id, name: site.name, serviceType: site.serviceType, addressLine1: site.addressLine1, city: site.city, postcode: site.postcode, lat: site.lat, lng: site.lng, accessNotes: site.accessNotes };
}

shiftsRouter.get(
  '/:id',
  h((req, res) => {
    const { db, now } = deps(req);
    const { org, user } = auth(req);
    const { shift, site, hostName } = loadShift(req, req.params.id!);
    const at = now();
    const isHost = shift.hostOrgId === org.id || isPlatformAdmin(req);
    const access = accessFor(db, shift.id, org.id, at);
    const hasAssignment = db.select({ id: shiftAssignments.id }).from(shiftAssignments).where(and(eq(shiftAssignments.shiftId, shift.id), eq(shiftAssignments.supplierOrgId, org.id))).get();
    if (!isHost && !access.opensAt && !hasAssignment) throw forbidden('This shift has not been released to your organisation');

    const assignmentRows = db
      .select({ assignment: shiftAssignments, worker: workers, supplierName: organisations.name })
      .from(shiftAssignments)
      .innerJoin(workers, eq(workers.id, shiftAssignments.workerId))
      .innerJoin(organisations, eq(organisations.id, shiftAssignments.supplierOrgId))
      .where(and(eq(shiftAssignments.shiftId, shift.id), isHost ? undefined : eq(shiftAssignments.supplierOrgId, org.id), user.role === UserRole.WORKER ? eq(shiftAssignments.workerId, user.workerId ?? '') : undefined))
      .orderBy(desc(shiftAssignments.createdAt))
      .all();
    const assignments = assignmentRows.map(({ assignment, worker, supplierName }) => ({
      ...assignment,
      supplierName,
      worker: { id: worker.id, firstName: worker.firstName, lastName: worker.lastName, jobRole: worker.jobRole, skills: worker.skills },
    }));

    res.json({
      ...publicShift(shift),
      site: isHost ? site : siteForGuest(site),
      hostName,
      isHost,
      access: isHost ? null : access,
      plan: isHost ? planForShift(db, shift.id) : undefined,
      assignments,
    });
  }),
);

shiftsRouter.patch(
  '/:id',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { settings } = auth(req);
    const { shift } = loadShift(req, req.params.id!);
    assertOrgAccess(req, shift.hostOrgId);
    const at = now();
    if (shift.status === ShiftStatus.DRAFT) {
      const body = parseBody(req, zShift.innerType().omit({ publish: true, hostOrgId: true }).partial());
      if (body.siteId && !loadSiteForOrg(db, body.siteId, shift.hostOrgId)) throw notFound('Site');
      db.update(shifts).set({ ...body, updatedAt: at }).where(eq(shifts.id, shift.id)).run();
    } else if (shift.status === ShiftStatus.OPEN) {
      const body = parseBody(req, zShift.innerType().pick(Object.fromEntries(EDITABLE_WHEN_OPEN.map((k) => [k, true])) as Record<(typeof EDITABLE_WHEN_OPEN)[number], true>).partial());
      if (body.headcount !== undefined && body.headcount < shift.filledCount) throw conflict(`Headcount cannot be below the ${shift.filledCount} already confirmed`);
      db.update(shifts).set({ ...body, status: body.headcount !== undefined && body.headcount <= shift.filledCount ? ShiftStatus.FILLED : shift.status, updatedAt: at }).where(eq(shifts.id, shift.id)).run();
      if (body.chargeRate !== undefined && body.chargeRate > shift.chargeRate) {
        // A rate rise is worth re-announcing to everyone who already has access.
        db.update(shiftAccess).set({ notifiedAt: null }).where(and(eq(shiftAccess.shiftId, shift.id), lte(shiftAccess.opensAt, at))).run();
        notifyDueAccess(db, notifier, at);
      }
    } else {
      throw conflict(`A ${shift.status.toLowerCase().replace('_', ' ')} shift cannot be edited`);
    }
    auditFromReq(req, db, { action: 'UPDATE', entityType: 'shift', entityId: shift.id, data: req.body }, at);
    res.json(publicShift(db.select().from(shifts).where(eq(shifts.id, shift.id)).get()!));
  }),
);

shiftsRouter.post(
  '/:id/publish',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { settings } = auth(req);
    const { shift, site } = loadShift(req, req.params.id!);
    assertOrgAccess(req, shift.hostOrgId);
    if (shift.status !== ShiftStatus.DRAFT) throw conflict('Only draft shifts can be published');
    const at = now();
    if (shift.startsAt.getTime() <= at.getTime()) throw unprocessable('Shift must start in the future');
    const published = publishShift(db, notifier, settings, shift, site, at);
    auditFromReq(req, db, { action: 'PUBLISH', entityType: 'shift', entityId: shift.id }, at);
    res.json({ ...publicShift(published), site, plan: planForShift(db, shift.id) });
  }),
);

shiftsRouter.post(
  '/:id/cancel',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { shift } = loadShift(req, req.params.id!);
    assertOrgAccess(req, shift.hostOrgId);
    if (!['DRAFT', 'OPEN', 'FILLED'].includes(shift.status)) throw conflict(`A ${shift.status.toLowerCase().replace('_', ' ')} shift cannot be cancelled`);
    const body = parseBody(req, z.object({ reason: z.string().max(500).nullable().optional() }));
    const at = now();
    const cancelled = cancelShift(db, notifier, shift, body.reason ?? null, at);
    auditFromReq(req, db, { action: 'CANCEL', entityType: 'shift', entityId: shift.id, data: { reason: body.reason } }, at);
    res.json(publicShift(cancelled));
  }),
);

/** Who would see this shift and when, computed live (drafts) or from the saved plan (published). */
shiftsRouter.get(
  '/:id/dispatch-preview',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const { settings } = auth(req);
    const { shift, site } = loadShift(req, req.params.id!);
    assertOrgAccess(req, shift.hostOrgId);
    if (shift.status !== ShiftStatus.DRAFT) return res.json({ persisted: true, urgent: shift.urgent, entries: planForShift(db, shift.id) });
    const at = now();
    const plan = buildPlan(db, settings, shift, site, at, at);
    const names = Object.fromEntries(db.select({ id: organisations.id, name: organisations.name, type: organisations.type }).from(organisations).all().map((o) => [o.id, o]));
    res.json({
      persisted: false,
      urgent: plan.urgent,
      stages: plan.stages,
      entries: plan.entries.map((e) => ({ ...e, orgName: names[e.orgId]?.name, orgType: names[e.orgId]?.type })),
      excluded: plan.excluded.map((e) => ({ ...e, orgName: names[e.orgId]?.name })),
    });
  }),
);

/** Supplier view: which of my workers could cover this shift, with the reasons for those who cannot. */
shiftsRouter.get(
  '/:id/eligible-workers',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const { org, settings } = auth(req);
    const q = parseQuery(req, z.object({ orgId: z.string().optional(), allowHoursOverride: z.coerce.boolean().default(false) }));
    const supplierOrgId = q.orgId ?? org.id;
    assertOrgAccess(req, supplierOrgId);
    const { shift, site } = loadShift(req, req.params.id!);
    const at = now();
    const access = accessFor(db, shift.id, supplierOrgId, at);
    if (!access.opensAt && !isPlatformAdmin(req)) throw forbidden('This shift has not been released to your organisation');
    const pool = db.select().from(workers).where(and(eq(workers.orgId, supplierOrgId), eq(workers.status, 'ACTIVE'))).all();
    const live = db.select().from(shiftAssignments).where(and(eq(shiftAssignments.shiftId, shift.id), inArray(shiftAssignments.status, ['REQUESTED', 'OFFERED', 'CONFIRMED']))).all();
    res.json({
      access,
      workers: pool.map((w) => {
        const { result } = evaluateWorkerForShift(db, settings, shift, site, w, at, { allowHoursOverride: q.allowHoursOverride });
        return {
          id: w.id,
          firstName: w.firstName,
          lastName: w.lastName,
          jobRole: w.jobRole,
          skills: w.skills,
          shareable: w.shareable,
          alreadyRequested: live.some((a) => a.workerId === w.id),
          ...result,
        };
      }),
    });
  }),
);

/** Host view: workers the host could offer the shift to directly (shareable, eligible, from organisations with open access). */
shiftsRouter.get(
  '/:id/candidates',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const { settings } = auth(req);
    const { shift, site } = loadShift(req, req.params.id!);
    assertOrgAccess(req, shift.hostOrgId);
    const at = now();
    const openOrgs = db.select({ orgId: shiftAccess.orgId, tier: shiftAccess.tier }).from(shiftAccess).where(and(eq(shiftAccess.shiftId, shift.id), lte(shiftAccess.opensAt, at))).all();
    if (openOrgs.length === 0) return res.json([]);
    const pool = db
      .select({ worker: workers, orgName: organisations.name })
      .from(workers)
      .innerJoin(organisations, eq(organisations.id, workers.orgId))
      .where(and(inArray(workers.orgId, openOrgs.map((o) => o.orgId)), eq(workers.status, 'ACTIVE'), eq(workers.shareable, true)))
      .all();
    const ratingRows = db.select({ workerId: ratings.workerId, score: ratings.score }).from(ratings).where(eq(ratings.fromOrgId, shift.hostOrgId)).all();
    const alreadyInvolved = new Set(
      db.select({ workerId: shiftAssignments.workerId }).from(shiftAssignments).where(and(eq(shiftAssignments.shiftId, shift.id), inArray(shiftAssignments.status, ['REQUESTED', 'OFFERED', 'CONFIRMED']))).all().map((a) => a.workerId),
    );
    const out = [];
    for (const { worker, orgName } of pool) {
      if (alreadyInvolved.has(worker.id)) continue;
      if (!roleCanCover(worker.jobRole, shift.jobRole)) continue;
      const { result } = evaluateWorkerForShift(db, settings, shift, site, worker, at);
      if (!result.eligible) continue;
      const myRatings = ratingRows.filter((r) => r.workerId === worker.id);
      out.push({
        id: worker.id,
        firstName: worker.firstName,
        lastName: worker.lastName,
        jobRole: worker.jobRole,
        skills: worker.skills,
        orgId: worker.orgId,
        orgName,
        tier: openOrgs.find((o) => o.orgId === worker.orgId)?.tier,
        distanceKm: result.facts.distanceKm,
        warnings: result.warnings,
        previousShiftsWithYou: myRatings.length,
        yourAverageRating: myRatings.length ? myRatings.reduce((s, r) => s + r.score, 0) / myRatings.length : null,
      });
    }
    out.sort((a, b) => (b.yourAverageRating ?? 0) - (a.yourAverageRating ?? 0) || (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
    res.json(out);
  }),
);

/** Supplier manager (or a self-service worker) puts a worker forward. */
shiftsRouter.post(
  '/:id/requests',
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { user, org, settings } = auth(req);
    const { shift, site } = loadShift(req, req.params.id!);
    const body = parseBody(req, z.object({ workerId: z.string().optional(), allowHoursOverride: z.boolean().default(false), note: z.string().max(500).nullable().optional() }));
    let workerId = body.workerId;
    if (user.role === UserRole.WORKER) {
      if (!org.workerSelfServiceAllowed) throw forbidden('Your employer has not enabled self-service shift requests');
      if (!user.workerId) throw forbidden('Your login is not linked to a worker record');
      if (workerId && workerId !== user.workerId) throw forbidden('Workers can only request shifts for themselves');
      workerId = user.workerId;
      body.allowHoursOverride = false;
    }
    if (!workerId) throw unprocessable('workerId is required');
    const worker = db.select().from(workers).where(eq(workers.id, workerId)).get();
    if (!worker) throw notFound('Worker');
    assertOrgAccess(req, worker.orgId);
    const at = now();
    const result = requestShift(db, notifier, settings, shift, site, worker, { userId: user.id, orgId: worker.orgId }, body, at);
    auditFromReq(req, db, { action: 'REQUEST', entityType: 'shift_assignment', entityId: result.assignment.id, data: { shiftId: shift.id, workerId } }, at);
    res.status(201).json({ assignment: result.assignment, shift: publicShift(result.shift), warnings: result.warnings });
  }),
);

/** Host offers the shift to a named worker from an organisation that has access. */
shiftsRouter.post(
  '/:id/offers',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { user, settings } = auth(req);
    const { shift, site } = loadShift(req, req.params.id!);
    assertOrgAccess(req, shift.hostOrgId);
    const body = parseBody(req, z.object({ workerId: z.string() }));
    const worker = db.select().from(workers).where(eq(workers.id, body.workerId)).get();
    if (!worker) throw notFound('Worker');
    if (!worker.shareable) throw conflict('That worker is not available to other organisations');
    const at = now();
    const assignment = offerShift(db, notifier, settings, shift, site, worker, { userId: user.id, orgId: shift.hostOrgId }, at);
    auditFromReq(req, db, { action: 'OFFER', entityType: 'shift_assignment', entityId: assignment.id, data: { shiftId: shift.id, workerId: worker.id } }, at);
    res.status(201).json(assignment);
  }),
);
