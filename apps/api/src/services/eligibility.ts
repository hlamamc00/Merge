import { and, eq, inArray, ne } from 'drizzle-orm';
import { evaluateEligibility, type EligibilityResult } from '@merge/shared';
import type { Db } from '../db/client.js';
import {
  shiftAssignments,
  shifts,
  sites,
  workerDocuments,
  workerUnavailability,
  type PlatformSettingsRow,
  type Shift,
  type Site,
  type Worker,
} from '../db/schema.js';
import { accessFor, type AccessInfo } from './dispatch.js';
import { workingTimeRulesFrom } from './settings.js';

export const LIVE_ASSIGNMENT_STATUSES = ['REQUESTED', 'OFFERED', 'CONFIRMED'] as const;

export interface WorkerShiftEvaluation {
  result: EligibilityResult;
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
  const documents = db.select().from(workerDocuments).where(eq(workerDocuments.workerId, worker.id)).all();
  const booked = db
    .select({ startsAt: shifts.startsAt, endsAt: shifts.endsAt, breakMinutes: shifts.breakMinutes })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .where(and(eq(shiftAssignments.workerId, worker.id), inArray(shiftAssignments.status, [...LIVE_ASSIGNMENT_STATUSES]), ne(shiftAssignments.shiftId, shift.id)))
    .all();
  const unavailable = db
    .select({ startsAt: workerUnavailability.startsAt, endsAt: workerUnavailability.endsAt })
    .from(workerUnavailability)
    .where(eq(workerUnavailability.workerId, worker.id))
    .all();
  const access = accessFor(db, shift.id, worker.orgId, now);

  const result = evaluateEligibility(
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
    },
  );
  return { result, access };
}

export function loadShiftWithSite(db: Db, shiftId: string): { shift: Shift; site: Site } | undefined {
  return db.select({ shift: shifts, site: sites }).from(shifts).innerJoin(sites, eq(sites.id, shifts.siteId)).where(eq(shifts.id, shiftId)).get();
}
