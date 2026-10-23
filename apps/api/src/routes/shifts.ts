import { Router } from 'express';
import { and, asc, desc, eq, gt, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import { DocumentType, JobRole, ShiftStatus, ShiftVisibility, Skill, UserRole, complianceSummary, distanceKm, roleCanCover, shiftPaidHours, type ComplianceStatus } from '@merge/shared';
import type { Db } from '../db/client.js';
import { capacityFlags, organisations, ratings, shiftAccess, shiftAssignments, shiftSeries, shifts, sites, workerDocuments, workers, type Shift } from '../db/schema.js';
import { auditFromReq } from '../lib/audit.js';
import { MANAGERS, allowedSiteIds, assertOrgAccess, assertSiteAccess, isManager, isPlatformAdmin, requireAuth, requireRole } from '../lib/auth.js';
import { auth, deps } from '../lib/context.js';
import { conflict, forbidden, h, notFound, unprocessable } from '../lib/errors.js';
import { parseBody, parseQuery, zDate, zQueryBool } from '../lib/validate.js';
import { declinePendingForShift, offerShift, requestShift } from '../services/assignments.js';
import { accessFor, buildPlan, liveAccessReason, notifyDueAccess, planForShift } from '../services/dispatch.js';
import { evaluateWorkerForShift } from '../services/eligibility.js';
import { ESCALATION_STEP_PCT, escalateShift, escalationHistory, stepDue } from '../services/escalation.js';
import { reliabilityFor } from '../services/reliability.js';
import { MAX_OCCURRENCES, createSeries, expandPattern, seriesShifts } from '../services/series.js';
import { assertHostMayPublish, assertHostRequirementIds, assertRateAboveFloor, cancelShift, createShift, floorRateInfo, loadSiteForOrg, publishShift } from '../services/shifts.js';

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
    /** Decision 11: ids from GET /compliance/requirements that a worker must hold for this shift. */
    requiredHostRequirementIds: z.array(z.string()).max(20).default([]),
    publish: z.boolean().default(false),
  })
  .refine((b) => b.endsAt > b.startsAt, { message: 'endsAt must be after startsAt' });

/** Decision 11 / board view: a worker's standing against the documents the shift needs, as of the shift date. */
function complianceStatusFor(db: Db, workerId: string, jobRole: JobRole, shift: Pick<Shift, 'startsAt' | 'extraRequiredDocuments'>): ComplianceStatus {
  const docs = db.select({ type: workerDocuments.type, expiresAt: workerDocuments.expiresAt, verifiedAt: workerDocuments.verifiedAt }).from(workerDocuments).where(eq(workerDocuments.workerId, workerId)).all();
  return complianceSummary(docs, jobRole, shift.startsAt, shift.extraRequiredDocuments).status;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

const SERIES_PATTERN = z.object({
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  durationHours: z.number().positive().max(24),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const EDITABLE_WHEN_OPEN = ['title', 'description', 'chargeRate', 'headcount', 'autoConfirm', 'breakMinutes', 'requiredSkills', 'extraRequiredDocuments'] as const;

function publicShift(s: Shift) {
  return { ...s, paidHours: shiftPaidHours(s.startsAt, s.endsAt, s.breakMinutes), placesLeft: Math.max(0, s.headcount - s.filledCount) };
}

/** What organisations other than the host get to see: no internal user ids. */
function guestShift(s: Shift) {
  const { createdByUserId: _c, ...rest } = publicShift(s);
  return rest;
}

/** Decision 3: the lowest charge rate anyone may post, and how it is worked out. */
shiftsRouter.get(
  '/floor-rate',
  h((req, res) => {
    res.json(floorRateInfo(auth(req).settings));
  }),
);

/** PR-05: post the same shift on many dates. Either an explicit list of occurrences or a weekly pattern. */
shiftsRouter.post(
  '/series',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { user, org, settings } = auth(req);
    const body = parseBody(
      req,
      z
        .object({
          template: zShift.innerType().omit({ startsAt: true, endsAt: true, publish: true }),
          occurrences: z.array(z.object({ startsAt: zDate, endsAt: zDate })).min(1).max(MAX_OCCURRENCES).optional(),
          pattern: SERIES_PATTERN.optional(),
          publish: z.boolean().default(false),
        })
        .refine((b) => !!b.occurrences || !!b.pattern, { message: 'Provide occurrences or a pattern' }),
    );
    const hostOrgId = body.template.hostOrgId ?? org.id;
    assertOrgAccess(req, hostOrgId);
    const site = loadSiteForOrg(db, body.template.siteId, hostOrgId);
    if (!site) throw notFound('Site');
    assertSiteAccess(req, site.id);
    const at = now();
    const occurrences = body.occurrences ?? expandPattern(body.pattern!);
    const { hostOrgId: _h, ...template } = body.template;
    const result = createSeries(db, notifier, settings, { orgId: hostOrgId, site, createdByUserId: user.id, allowPending: isPlatformAdmin(req) }, template, occurrences, body.publish, body.pattern ?? { occurrences: occurrences.length }, at);
    for (const sh of result.shifts) auditFromReq(req, db, { action: 'CREATE', entityType: 'shift', entityId: sh.id, data: { seriesId: result.seriesId } }, at);
    res.status(201).json({ seriesId: result.seriesId, count: result.shifts.length, shifts: result.shifts.map((sh) => ({ ...publicShift(sh), site })) });
  }),
);

shiftsRouter.get(
  '/series/:id',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db } = deps(req);
    const series = db.select().from(shiftSeries).where(eq(shiftSeries.id, req.params.id!)).get();
    if (!series) throw notFound('Series');
    assertOrgAccess(req, series.hostOrgId);
    res.json({ ...series, shifts: seriesShifts(db, series.id).map(publicShift) });
  }),
);

/** Cancel every shift in the series that has not started (drafts, open, filled). */
shiftsRouter.post(
  '/series/:id/cancel',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const series = db.select().from(shiftSeries).where(eq(shiftSeries.id, req.params.id!)).get();
    if (!series) throw notFound('Series');
    assertOrgAccess(req, series.hostOrgId);
    const body = parseBody(req, z.object({ reason: z.string().max(500).nullable().optional() }));
    const at = now();
    const cancelled: string[] = [];
    for (const sh of seriesShifts(db, series.id)) {
      if (!['DRAFT', 'OPEN', 'FILLED'].includes(sh.status)) continue;
      cancelShift(db, notifier, sh, body.reason ?? 'Series cancelled by host', at);
      auditFromReq(req, db, { action: 'CANCEL', entityType: 'shift', entityId: sh.id, data: { seriesId: series.id, reason: body.reason } }, at);
      cancelled.push(sh.id);
    }
    res.json({ seriesId: series.id, cancelled, shifts: seriesShifts(db, series.id).map(publicShift) });
  }),
);

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
    const { user, org, settings } = auth(req);
    const q = parseQuery(
      req,
      z.object({
        scope: z.enum(['posted', 'available', 'supplied', 'all']).default(user.role === UserRole.WORKER ? 'available' : 'posted'),
        status: z.nativeEnum(ShiftStatus).optional(),
        jobRole: z.nativeEnum(JobRole).optional(),
        from: zDate.optional(),
        to: zDate.optional(),
        orgId: z.string().optional(),
        includePast: zQueryBool,
        /** scope=available only. */
        sort: z.enum(['opens', 'start', 'rate', 'distance']).default('opens'),
        nearKm: z.coerce.number().positive().max(500).optional(),
        seriesId: z.string().optional(),
      }),
    );
    const at = now();
    const base = [];
    if (q.status) base.push(eq(shifts.status, q.status));
    if (q.jobRole) base.push(eq(shifts.jobRole, q.jobRole));
    if (q.from) base.push(gte(shifts.startsAt, q.from));
    if (q.to) base.push(lte(shifts.startsAt, q.to));
    if (q.seriesId) base.push(eq(shifts.seriesId, q.seriesId));

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
      const allowedSites = allowedSiteIds(req); // a site-limited manager sees only their sites' rota
      const rows = db
        .select({ shift: shifts, site: sites })
        .from(shifts)
        .innerJoin(sites, eq(sites.id, shifts.siteId))
        .where(and(eq(shifts.hostOrgId, hostOrgId), ...base, q.includePast ? undefined : gte(shifts.endsAt, at), allowedSites ? inArray(shifts.siteId, allowedSites) : undefined))
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
          /** Decision 6: an open shift inside the escalation window with places left needs attention. */
          escalationDue: shift.status === ShiftStatus.OPEN && shift.filledCount < shift.headcount && stepDue(shift.startsAt, at) > 0,
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
          ...forViewer(guestShift(shift), user.role),
          site: siteForGuest(site, assignment.status === 'CONFIRMED' || assignment.status === 'COMPLETED'),
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
    const flagIds = rows.map((r) => r.access.matchedFlagId).filter((f): f is string => !!f);
    const flagsById = new Map(flagIds.length ? db.select().from(capacityFlags).where(inArray(capacityFlags.id, flagIds)).all().map((f) => [f.id, f]) : []);
    // Distance is measured from the worker's home, or from the organisation's address for a manager.
    const origin = myWorker?.lat != null && myWorker.lng != null ? { lat: myWorker.lat, lng: myWorker.lng } : org.lat != null && org.lng != null ? { lat: org.lat, lng: org.lng } : null;
    const out = rows
      .filter(({ shift }) => !myWorker || roleCanCover(myWorker.jobRole, shift.jobRole))
      .map(({ shift, site, hostName, access }) => {
        const distance = origin && site.lat != null && site.lng != null ? round1(distanceKm(origin.lat, origin.lng, site.lat, site.lng)) : null;
        const evaluation = myWorker ? evaluateWorkerForShift(db, settings, shift, site, myWorker, at) : null;
        return {
          ...forViewer(guestShift(shift), user.role),
          site: siteForGuest(site),
          hostName,
          access: { tier: access.tier, opensAt: access.opensAt, open: access.opensAt.getTime() <= at.getTime(), reason: liveAccessReason(access.reason, access.matchedFlagId ? flagsById.get(access.matchedFlagId) : null) },
          myAssignments: mine.filter((a) => a.shiftId === shift.id),
          distanceKm: distance,
          ...(evaluation ? { eligible: evaluation.result.eligible, blockers: evaluation.result.blockers, warnings: evaluation.result.warnings } : {}),
        };
      })
      .filter((r) => q.nearKm === undefined || (r.distanceKm !== null && r.distanceKm <= q.nearKm));
    const far = Number.MAX_SAFE_INTEGER;
    if (q.sort === 'start') out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    else if (q.sort === 'rate') out.sort((a, b) => (b.chargeRate ?? 0) - (a.chargeRate ?? 0) || a.startsAt.getTime() - b.startsAt.getTime());
    else if (q.sort === 'distance') out.sort((a, b) => (a.distanceKm ?? far) - (b.distanceKm ?? far) || a.startsAt.getTime() - b.startsAt.getTime());
    res.json(out);
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
    assertSiteAccess(req, site.id);
    const at = now();
    const { publish, hostOrgId: _h, ...data } = body;
    const shift = createShift(db, notifier, settings, { hostOrgId, site, data, publish, createdByUserId: user.id, allowPending: isPlatformAdmin(req) }, at);
    auditFromReq(req, db, { action: 'CREATE', entityType: 'shift', entityId: shift.id }, at);
    if (publish) auditFromReq(req, db, { action: 'PUBLISH', entityType: 'shift', entityId: shift.id }, at);
    res.status(201).json({ ...publicShift(shift), site, plan: planForShift(db, shift.id) });
  }),
);

/** Host-side actions: the caller's organisation must own the shift and a site-limited manager must cover its site. */
function assertHostShiftAccess(req: Parameters<typeof deps>[0], shift: { hostOrgId: string; siteId: string }) {
  assertOrgAccess(req, shift.hostOrgId);
  const allowed = allowedSiteIds(req);
  if (allowed && !allowed.includes(shift.siteId)) throw forbidden('You are not assigned to that site');
}

function loadShift(req: Parameters<typeof deps>[0], id: string) {
  const { db } = deps(req);
  const row = db.select({ shift: shifts, site: sites, hostName: organisations.name }).from(shifts).innerJoin(sites, eq(sites.id, shifts.siteId)).innerJoin(organisations, eq(organisations.id, shifts.hostOrgId)).where(eq(shifts.id, id)).get();
  if (!row) throw notFound('Shift');
  return row;
}

/** What other organisations see of a site. Access notes (door codes, who to report to) only once a booking is confirmed. */
function siteForGuest(site: typeof sites.$inferSelect, confirmed = false) {
  return { id: site.id, name: site.name, serviceType: site.serviceType, addressLine1: site.addressLine1, city: site.city, postcode: site.postcode, lat: site.lat, lng: site.lng, accessNotes: confirmed ? site.accessNotes : null };
}

/** A worker login is paid by their employer, not at the inter-organisation charge rate, so that figure is withheld. */
function forViewer<T extends { chargeRate: number }>(s: T, role: UserRole): T | (Omit<T, 'chargeRate'> & { chargeRate: null }) {
  return role === UserRole.WORKER ? { ...s, chargeRate: null } : s;
}

shiftsRouter.get(
  '/:id',
  h((req, res) => {
    const { db, now } = deps(req);
    const { org, user, settings } = auth(req);
    const { shift, site, hostName } = loadShift(req, req.params.id!);
    const at = now();
    // isHost: the viewer's own organisation posted it. canManage: host or platform admin (oversight of any shift).
    const isHost = shift.hostOrgId === org.id;
    const canManage = isHost || isPlatformAdmin(req);
    const access = accessFor(db, shift.id, org.id, at);
    const hasAssignment = db.select({ id: shiftAssignments.id, status: shiftAssignments.status }).from(shiftAssignments).where(and(eq(shiftAssignments.shiftId, shift.id), eq(shiftAssignments.supplierOrgId, org.id))).all();
    if (!canManage && !access.opensAt && hasAssignment.length === 0) throw forbidden('This shift has not been released to your organisation');
    const hasConfirmed = hasAssignment.some((a) => a.status === 'CONFIRMED' || a.status === 'COMPLETED');

    const assignmentRows = db
      .select({ assignment: shiftAssignments, worker: workers, supplierName: organisations.name })
      .from(shiftAssignments)
      .innerJoin(workers, eq(workers.id, shiftAssignments.workerId))
      .innerJoin(organisations, eq(organisations.id, shiftAssignments.supplierOrgId))
      .where(and(eq(shiftAssignments.shiftId, shift.id), canManage ? undefined : eq(shiftAssignments.supplierOrgId, org.id), user.role === UserRole.WORKER ? eq(shiftAssignments.workerId, user.workerId ?? '') : undefined))
      .orderBy(desc(shiftAssignments.createdAt))
      .all();
    const assignments = assignmentRows.map(({ assignment, worker, supplierName }) => ({
      ...assignment,
      supplierName,
      worker: { id: worker.id, firstName: worker.firstName, lastName: worker.lastName, jobRole: worker.jobRole, skills: worker.skills },
      /** Status only (decision 13): the employer holds the documents. */
      complianceStatus: complianceStatusFor(db, worker.id, worker.jobRole, shift),
    }));
    const host = canManage ? db.select({ escalationMode: organisations.escalationMode, escalationCeilingPct: organisations.escalationCeilingPct }).from(organisations).where(eq(organisations.id, shift.hostOrgId)).get() : null;
    const original = shift.originalChargeRate ?? shift.chargeRate;
    const myWorker = user.role === UserRole.WORKER && user.workerId ? db.select().from(workers).where(eq(workers.id, user.workerId)).get() : null;
    const myEvaluation = myWorker && shift.status === ShiftStatus.OPEN ? evaluateWorkerForShift(db, settings, shift, site, myWorker, at).result : null;
    const origin = myWorker?.lat != null && myWorker.lng != null ? { lat: myWorker.lat, lng: myWorker.lng } : org.lat != null && org.lng != null ? { lat: org.lat, lng: org.lng } : null;

    res.json({
      ...(canManage ? publicShift(shift) : forViewer(guestShift(shift), user.role)),
      site: canManage ? site : siteForGuest(site, hasConfirmed),
      hostName,
      isHost,
      canManage,
      access: isHost ? null : access,
      plan: canManage ? planForShift(db, shift.id) : undefined,
      assignments,
      distanceKm: !isHost && origin && site.lat != null && site.lng != null ? round1(distanceKm(origin.lat, origin.lng, site.lat, site.lng)) : null,
      myEligibility: myEvaluation ? { eligible: myEvaluation.eligible, blockers: myEvaluation.blockers, warnings: myEvaluation.warnings } : undefined,
      floor: canManage ? floorRateInfo(settings).floor : undefined,
      escalation: host
        ? {
            mode: host.escalationMode,
            ceilingPct: host.escalationCeilingPct,
            ceilingRate: Math.round(original * (1 + host.escalationCeilingPct / 100) * 20) / 20,
            originalChargeRate: original,
            step: shift.escalationStep,
            stepDue: shift.status === ShiftStatus.OPEN ? stepDue(shift.startsAt, at) : 0,
            lastEscalatedAt: shift.lastEscalatedAt,
            suggestedRaisePct: ESCALATION_STEP_PCT,
            history: escalationHistory(db, shift.id),
          }
        : undefined,
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
    assertHostShiftAccess(req, shift);
    const at = now();
    if (shift.status === ShiftStatus.DRAFT) {
      const body = parseBody(req, zShift.innerType().omit({ publish: true, hostOrgId: true }).partial());
      if (body.siteId && !loadSiteForOrg(db, body.siteId, shift.hostOrgId)) throw notFound('Site');
      if (body.siteId) assertSiteAccess(req, body.siteId);
      if (body.chargeRate !== undefined) assertRateAboveFloor(settings, body.chargeRate);
      if (body.requiredHostRequirementIds) body.requiredHostRequirementIds = assertHostRequirementIds(db, shift.hostOrgId, body.requiredHostRequirementIds);
      db.update(shifts).set({ ...body, updatedAt: at }).where(eq(shifts.id, shift.id)).run();
    } else if (shift.status === ShiftStatus.OPEN) {
      const body = parseBody(req, zShift.innerType().pick(Object.fromEntries(EDITABLE_WHEN_OPEN.map((k) => [k, true])) as Record<(typeof EDITABLE_WHEN_OPEN)[number], true>).partial());
      if (body.chargeRate !== undefined) assertRateAboveFloor(settings, body.chargeRate);
      if (body.headcount !== undefined && body.headcount < shift.filledCount) throw conflict(`Headcount cannot be below the ${shift.filledCount} already confirmed`);
      if (body.breakMinutes !== undefined && body.breakMinutes !== shift.breakMinutes && shift.filledCount > 0) {
        throw conflict('The break cannot be changed once workers are confirmed, because their paid hours and flag hours are already committed');
      }
      const nowFull = body.headcount !== undefined && body.headcount <= shift.filledCount;
      db.update(shifts).set({ ...body, status: nowFull ? ShiftStatus.FILLED : shift.status, updatedAt: at }).where(eq(shifts.id, shift.id)).run();
      if (nowFull) declinePendingForShift(db, notifier, db.select().from(shifts).where(eq(shifts.id, shift.id)).get()!, 'Shift filled by another worker', at);
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
    assertHostShiftAccess(req, shift);
    if (shift.status !== ShiftStatus.DRAFT) throw conflict('Only draft shifts can be published');
    assertHostMayPublish(db, shift.hostOrgId, { allowPending: isPlatformAdmin(req) });
    const at = now();
    if (shift.startsAt.getTime() <= at.getTime()) throw unprocessable('Shift must start in the future');
    assertRateAboveFloor(settings, shift.chargeRate);
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
    assertHostShiftAccess(req, shift);
    if (!['DRAFT', 'OPEN', 'FILLED'].includes(shift.status)) throw conflict(`A ${shift.status.toLowerCase().replace('_', ' ')} shift cannot be cancelled`);
    const body = parseBody(req, z.object({ reason: z.string().max(500).nullable().optional() }));
    const at = now();
    const cancelled = cancelShift(db, notifier, shift, body.reason ?? null, at);
    auditFromReq(req, db, { action: 'CANCEL', entityType: 'shift', entityId: shift.id, data: { reason: body.reason } }, at);
    res.json(publicShift(cancelled));
  }),
);

/** Decision 6: the host escalates by hand at any time: raise the rate and/or open every tier now. */
shiftsRouter.post(
  '/:id/escalate',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { user, settings } = auth(req);
    const { shift } = loadShift(req, req.params.id!);
    assertHostShiftAccess(req, shift);
    const body = parseBody(req, z.object({ raiseRatePct: z.number().min(0).max(100).optional(), openToAll: z.boolean().default(true) }));
    if (shift.status !== ShiftStatus.OPEN) throw conflict(`A ${shift.status.toLowerCase().replace('_', ' ')} shift cannot be escalated`);
    if (!body.raiseRatePct && !body.openToAll) throw unprocessable('Raise the rate, open to all, or both');
    const at = now();
    const r = escalateShift(db, notifier, shift, { mode: 'MANUAL', raiseRatePct: body.raiseRatePct, openToAll: body.openToAll, actor: { userId: user.id, orgId: shift.hostOrgId } }, at);
    res.json({ ...publicShift(r.shift), previousRate: r.previousRate, newRate: r.newRate, opened: r.opened, step: r.step, floor: floorRateInfo(settings).floor, plan: planForShift(db, shift.id) });
  }),
);

/** PR-05: post this shift again on another date (same site, role, rate, requirements). */
shiftsRouter.post(
  '/:id/copy',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { user, settings } = auth(req);
    const { shift, site } = loadShift(req, req.params.id!);
    assertHostShiftAccess(req, shift);
    const body = parseBody(req, z.object({ startsAt: zDate, endsAt: zDate, publish: z.boolean().default(false), chargeRate: z.number().positive().max(500).optional() }).refine((b) => b.endsAt > b.startsAt, { message: 'endsAt must be after startsAt' }));
    const at = now();
    const copy = createShift(
      db,
      notifier,
      settings,
      {
        hostOrgId: shift.hostOrgId,
        site,
        publish: body.publish,
        createdByUserId: user.id,
        allowPending: isPlatformAdmin(req),
        data: {
          siteId: shift.siteId,
          jobRole: shift.jobRole,
          title: shift.title,
          description: shift.description,
          startsAt: body.startsAt,
          endsAt: body.endsAt,
          breakMinutes: shift.breakMinutes,
          headcount: shift.headcount,
          requiredSkills: shift.requiredSkills,
          extraRequiredDocuments: shift.extraRequiredDocuments,
          chargeRate: body.chargeRate ?? shift.originalChargeRate ?? shift.chargeRate,
          visibility: shift.visibility,
          priorityWindowMinutesOverride: shift.priorityWindowMinutesOverride,
          autoConfirm: shift.autoConfirm,
          requiredHostRequirementIds: shift.requiredHostRequirementIds,
        },
      },
      at,
    );
    auditFromReq(req, db, { action: 'CREATE', entityType: 'shift', entityId: copy.id, data: { copiedFrom: shift.id } }, at);
    if (body.publish) auditFromReq(req, db, { action: 'PUBLISH', entityType: 'shift', entityId: copy.id }, at);
    res.status(201).json({ ...publicShift(copy), site, plan: planForShift(db, copy.id) });
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
    assertHostShiftAccess(req, shift);
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
    const q = parseQuery(req, z.object({ orgId: z.string().optional(), allowHoursOverride: zQueryBool }));
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
    assertHostShiftAccess(req, shift);
    const at = now();
    const openOrgs = db.select({ orgId: shiftAccess.orgId, tier: shiftAccess.tier }).from(shiftAccess).where(and(eq(shiftAccess.shiftId, shift.id), lte(shiftAccess.opensAt, at))).all();
    if (openOrgs.length === 0) return res.json([]);
    const reliabilityByOrg = new Map<string, ReturnType<typeof reliabilityFor>>();
    const reliabilityOf = (orgId: string) => {
      let r = reliabilityByOrg.get(orgId);
      if (!r) {
        r = reliabilityFor(db, settings, orgId, at);
        reliabilityByOrg.set(orgId, r);
      }
      return r;
    };
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
        complianceStatus: complianceStatusFor(db, worker.id, worker.jobRole, shift),
        reliability: reliabilityOf(worker.orgId),
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
    assertHostShiftAccess(req, shift);
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
