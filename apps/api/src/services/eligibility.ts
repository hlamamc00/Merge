import { and, eq, gt, inArray, isNull, lt, ne } from 'drizzle-orm';
import { evaluateEligibility, startOfIsoWeek, type EligibilityIssue, type EligibilityResult } from '@merge/shared';
import type { Db } from '../db/client.js';
import {
  hostRequirements,
  shiftAssignments,
  shifts,
  sites,
  workerBars,
  workerDocuments,
  workerHostRequirements,
  workerUnavailability,
  type PlatformSettingsRow,
  type Shift,
  type Site,
  type Worker,
} from '../db/schema.js';
import { accessFor, type AccessInfo } from './dispatch.js';
import { workingTimeRulesFrom } from './settings.js';
import { getInternalHours } from './weekHours.js';

export const LIVE_ASSIGNMENT_STATUSES = ['REQUESTED', 'OFFERED', 'CONFIRMED'] as const;

/** Decision 7: a pending request elsewhere is a soft hold, surfaced as a warning rather than a blocker. */
export type ShiftWarning = EligibilityIssue | { code: 'PENDING_ELSEWHERE'; message: string };
export type ShiftEligibilityResult = Omit<EligibilityResult, 'warnings'> & { warnings: ShiftWarning[] };

export interface WorkerShiftEvaluation {
  result: ShiftEligibilityResult;
  access: AccessInfo;
}

/** Assemble everything the pure eligibility rules need from the database and run them. */
export function evaluateWorkerForShift(
  db: Db,
  settings: PlatformSettingsRow,
  shift: Shift,
  site: Site,
  worker: Worker,
  now: Date,
  opts: { allowHoursOverride?: boolean } = {},
): WorkerShiftEvaluation {
  // Corrected documents stay as history (supersededAt set) and must not count towards compliance.
  const documents = db.select().from(workerDocuments).where(and(eq(workerDocuments.workerId, worker.id), isNull(workerDocuments.supersededAt))).all();
  // Decision 7: only firm bookings count as booked time; requests and offers elsewhere are soft holds (warned below).
  const booked = db
    .select({ startsAt: shifts.startsAt, endsAt: shifts.endsAt, breakMinutes: shifts.breakMinutes })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .where(and(eq(shiftAssignments.workerId, worker.id), eq(shiftAssignments.status, 'CONFIRMED'), ne(shiftAssignments.shiftId, shift.id)))
    .all();
  const pendingElsewhere = db
    .select({ status: shiftAssignments.status, title: shifts.title, startsAt: shifts.startsAt })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .where(
      and(
        eq(shiftAssignments.workerId, worker.id),
        inArray(shiftAssignments.status, ['REQUESTED', 'OFFERED']),
        ne(shiftAssignments.shiftId, shift.id),
        lt(shifts.startsAt, shift.endsAt),
        gt(shifts.endsAt, shift.startsAt),
      ),
    )
    .all();
  const unavailable = db
    .select({ startsAt: workerUnavailability.startsAt, endsAt: workerUnavailability.endsAt })
    .from(workerUnavailability)
    .where(eq(workerUnavailability.workerId, worker.id))
    .all();
  const access = accessFor(db, shift.id, worker.orgId, now);
  // Decision 14: a host may bar a named worker (for all sites or the shift's site).
  const bar = db
    .select({ siteId: workerBars.siteId })
    .from(workerBars)
    .where(and(eq(workerBars.hostOrgId, shift.hostOrgId), eq(workerBars.workerId, worker.id), isNull(workerBars.liftedAt)))
    .all()
    .find((b) => !b.siteId || b.siteId === shift.siteId);
  // Decision 11: host-specific requirements the shift names must be held by the worker.
  let missingHostRequirements: string[] = [];
  if (shift.requiredHostRequirementIds.length > 0) {
    const held = new Set(
      db
        .select({ requirementId: workerHostRequirements.requirementId, expiresAt: workerHostRequirements.expiresAt })
        .from(workerHostRequirements)
        .where(and(eq(workerHostRequirements.workerId, worker.id), inArray(workerHostRequirements.requirementId, shift.requiredHostRequirementIds)))
        .all()
        .filter((r) => !r.expiresAt || r.expiresAt.getTime() > shift.startsAt.getTime())
        .map((r) => r.requirementId),
    );
    missingHostRequirements = db
      .select({ id: hostRequirements.id, name: hostRequirements.name })
      .from(hostRequirements)
      .where(inArray(hostRequirements.id, shift.requiredHostRequirementIds))
      .all()
      .filter((r) => !held.has(r.id))
      .map((r) => r.name);
  }

  const evaluated = evaluateEligibility(
    {
      id: shift.id,
      hostOrgId: shift.hostOrgId,
      jobRole: shift.jobRole,
      startsAt: shift.startsAt,
      endsAt: shift.endsAt,
      breakMinutes: shift.breakMinutes,
      requiredSkills: shift.requiredSkills,
      extraRequiredDocuments: shift.extraRequiredDocuments,
      siteLat: site.lat,
      siteLng: site.lng,
    },
    {
      id: worker.id,
      orgId: worker.orgId,
      jobRole: worker.jobRole,
      status: worker.status,
      shareable: worker.shareable,
      skills: worker.skills,
      documents,
      maxHoursPerWeek: worker.maxHoursPerWeek,
      // Decision 8: assume the worker works their full contracted hours for their employer unless the
      // employer has recorded the real figure for the shift's week (by hand or through a surplus flag).
      internalHoursThisWeek: getInternalHours(db, worker.id, startOfIsoWeek(shift.startsAt)) ?? worker.contractedHoursPerWeek ?? 0,
      optedOutOf48h: worker.optedOutOf48h,
      lat: worker.lat,
      lng: worker.lng,
      travelRadiusKm: worker.travelRadiusKm,
      unavailableWindows: unavailable,
    },
    {
      now,
      bookedShifts: booked,
      access: { open: access.open, opensAt: access.opensAt, tier: access.tier },
      rules: workingTimeRulesFrom(settings),
      allowHoursOverride: opts.allowHoursOverride,
      barredByHost: !!bar,
      missingHostRequirements,
    },
  );
  const result: ShiftEligibilityResult = { ...evaluated, warnings: [...evaluated.warnings] };
  if (pendingElsewhere.length > 0) {
    const first = pendingElsewhere[0]!;
    result.warnings.push({
      code: 'PENDING_ELSEWHERE',
      message: `${first.status === 'OFFERED' ? 'Offered' : 'Requested'} for an overlapping shift (${first.title}, ${first.startsAt.toISOString()})${pendingElsewhere.length > 1 ? ` and ${pendingElsewhere.length - 1} more` : ''}; whichever is confirmed first wins and the others are withdrawn`,
    });
  }
  return { result, access };
}

export function loadShiftWithSite(db: Db, shiftId: string): { shift: Shift; site: Site } | undefined {
  return db.select({ shift: shifts, site: sites }).from(shifts).innerJoin(sites, eq(sites.id, shifts.siteId)).where(eq(shifts.id, shiftId)).get();
}
