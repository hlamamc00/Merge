import { roleCanCover, type DispatchTier, type DocumentType, type JobRole, type Skill, type WorkerStatus } from '../enums.js';
import { distanceKm } from '../geo.js';
import { shiftPaidHours } from '../time.js';
import { complianceSummary, type ComplianceDocumentLike } from './compliance.js';
import {
  DEFAULT_WORKING_TIME_RULES,
  minimumRestGapHours,
  overlapsAny,
  weeklyBookedHours,
  type BookedShift,
  type WorkingTimeRules,
} from './workingTime.js';

export interface EligibilityShift {
  id: string;
  hostOrgId: string;
  jobRole: JobRole;
  startsAt: Date;
  endsAt: Date;
  breakMinutes: number;
  requiredSkills: Skill[];
  extraRequiredDocuments?: DocumentType[];
  siteLat?: number | null;
  siteLng?: number | null;
}

export interface EligibilityWorker {
  id: string;
  orgId: string;
  jobRole: JobRole;
  status: WorkerStatus;
  /** The employer allows this worker to be lent to other organisations. */
  shareable: boolean;
  skills: Skill[];
  documents: ComplianceDocumentLike[];
  maxHoursPerWeek?: number | null;
  /** Hours the worker is already rostered for by their own employer in the shift's week. */
  internalHoursThisWeek?: number | null;
  optedOutOf48h?: boolean;
  lat?: number | null;
  lng?: number | null;
  travelRadiusKm?: number | null;
  /** Periods the worker has told their employer they are unavailable (leave, other commitments). */
  unavailableWindows?: BookedShift[];
}

export interface EligibilityContext {
  now: Date;
  /** Shifts already REQUESTED/OFFERED/CONFIRMED for this worker on the platform. */
  bookedShifts: BookedShift[];
  /** Whether the worker's organisation currently has access to the shift under the dispatch plan. */
  access: { open: boolean; opensAt?: Date; tier?: DispatchTier };
  rules?: Partial<WorkingTimeRules>;
  /** A manager may override the weekly-hours limit when the worker has opted out of the 48h cap. */
  allowHoursOverride?: boolean;
}

export type EligibilityCode =
  | 'OWN_ORGANISATION'
  | 'WORKER_INACTIVE'
  | 'WORKER_NOT_SHAREABLE'
  | 'ROLE_MISMATCH'
  | 'MISSING_SKILLS'
  | 'NON_COMPLIANT'
  | 'ACCESS_NOT_OPEN'
  | 'NO_ACCESS'
  | 'OVERLAPPING_SHIFT'
  | 'INSUFFICIENT_REST'
  | 'WEEKLY_HOURS_EXCEEDED'
  | 'SHIFT_TOO_LONG'
  | 'DOCUMENT_EXPIRING'
  | 'LONG_SHIFT'
  | 'INSUFFICIENT_BREAK'
  | 'OUT_OF_TRAVEL_RANGE'
  | 'WORKER_UNAVAILABLE'
  | 'SHIFT_IN_PAST';

export interface EligibilityIssue {
  code: EligibilityCode;
  message: string;
}

export interface EligibilityResult {
  eligible: boolean;
  blockers: EligibilityIssue[];
  warnings: EligibilityIssue[];
  /** Useful context for the UI. */
  facts: {
    shiftHours: number;
    weeklyHoursAfter: number;
    restGapHours: number | null;
    distanceKm: number | null;
  };
}

/**
 * Decide whether a specific worker may be put forward for a specific shift, and why not if not.
 * Pure function: all state is passed in so the same rules run on the server and can be explained in the UI.
 */
export function evaluateEligibility(
  shift: EligibilityShift,
  worker: EligibilityWorker,
  ctx: EligibilityContext,
): EligibilityResult {
  const rules: WorkingTimeRules = { ...DEFAULT_WORKING_TIME_RULES, ...(ctx.rules ?? {}) };
  const blockers: EligibilityIssue[] = [];
  const warnings: EligibilityIssue[] = [];

  const shiftHours = shiftPaidHours(shift.startsAt, shift.endsAt, shift.breakMinutes);
  const booked = ctx.bookedShifts.filter((b) => !(b.startsAt.getTime() === shift.startsAt.getTime() && b.endsAt.getTime() === shift.endsAt.getTime()));

  if (shift.startsAt.getTime() <= ctx.now.getTime()) {
    blockers.push({ code: 'SHIFT_IN_PAST', message: 'The shift has already started' });
  }
  if (worker.orgId === shift.hostOrgId) {
    blockers.push({ code: 'OWN_ORGANISATION', message: 'Workers cannot be traded to their own organisation; use your internal rota' });
  }
  if (worker.status !== 'ACTIVE') {
    blockers.push({ code: 'WORKER_INACTIVE', message: `Worker is ${worker.status.toLowerCase().replace('_', ' ')}` });
  }
  if (!worker.shareable) {
    blockers.push({ code: 'WORKER_NOT_SHAREABLE', message: 'Worker is not marked as available for other organisations' });
  }
  if (!roleCanCover(worker.jobRole, shift.jobRole)) {
    blockers.push({ code: 'ROLE_MISMATCH', message: `A ${label(worker.jobRole)} cannot cover a ${label(shift.jobRole)} shift` });
  }
  const missingSkills = shift.requiredSkills.filter((s) => !worker.skills.includes(s));
  if (missingSkills.length > 0) {
    blockers.push({ code: 'MISSING_SKILLS', message: `Missing required skills: ${missingSkills.map(label).join(', ')}` });
  }

  const compliance = complianceSummary(worker.documents, shift.jobRole, shift.startsAt, shift.extraRequiredDocuments ?? []);
  if (compliance.status === 'NON_COMPLIANT') {
    const problems = compliance.items.filter((i) => i.status !== 'VALID' && i.status !== 'EXPIRING');
    blockers.push({
      code: 'NON_COMPLIANT',
      message: `Compliance: ${problems.map((p) => `${label(p.type)} ${p.status.toLowerCase().replace(/_/g, ' ')}`).join('; ')}`,
    });
  } else if (compliance.status === 'EXPIRING') {
    const expiring = compliance.items.filter((i) => i.status === 'EXPIRING');
    warnings.push({ code: 'DOCUMENT_EXPIRING', message: `Expiring soon: ${expiring.map((e) => label(e.type)).join(', ')}` });
  }

  if (!ctx.access.opensAt && !ctx.access.open) {
    blockers.push({ code: 'NO_ACCESS', message: 'Your organisation is not included in this shift\'s release plan' });
  } else if (!ctx.access.open) {
    blockers.push({ code: 'ACCESS_NOT_OPEN', message: `This shift opens to your organisation at ${ctx.access.opensAt!.toISOString()}` });
  }

  if (worker.unavailableWindows && overlapsAny(shift, worker.unavailableWindows)) {
    blockers.push({ code: 'WORKER_UNAVAILABLE', message: 'Worker has marked this time as unavailable' });
  }

  const overlap = overlapsAny(shift, booked);
  let restGap: number | null = null;
  if (overlap) {
    blockers.push({ code: 'OVERLAPPING_SHIFT', message: 'Worker already has a shift at this time' });
  } else if (booked.length > 0) {
    restGap = minimumRestGapHours(shift, booked);
    if (restGap < rules.minRestHours) {
      blockers.push({ code: 'INSUFFICIENT_REST', message: `Only ${restGap.toFixed(1)}h rest from an adjacent shift (minimum ${rules.minRestHours}h)` });
    }
  }

  const weeklyBefore = weeklyBookedHours(shift, booked) + (worker.internalHoursThisWeek ?? 0);
  const weeklyAfter = weeklyBefore + shiftHours;
  const cap = Math.min(worker.maxHoursPerWeek ?? rules.maxWeeklyHours, rules.maxWeeklyHours);
  if (weeklyAfter > cap) {
    const msg = `Would take the worker to ${weeklyAfter.toFixed(1)}h this week (limit ${cap}h)`;
    if (worker.optedOutOf48h && ctx.allowHoursOverride) warnings.push({ code: 'WEEKLY_HOURS_EXCEEDED', message: `${msg} – overridden (48h opt-out on file)` });
    else blockers.push({ code: 'WEEKLY_HOURS_EXCEEDED', message: msg });
  }

  if (shiftHours > rules.maxShiftHours) {
    blockers.push({ code: 'SHIFT_TOO_LONG', message: `Shift is ${shiftHours}h; the platform limit is ${rules.maxShiftHours}h` });
  } else if (shiftHours > rules.warnShiftHours) {
    warnings.push({ code: 'LONG_SHIFT', message: `Long shift (${shiftHours}h)` });
  }
  if (shiftHours > rules.breakRequiredAfterHours && shift.breakMinutes < rules.minBreakMinutes) {
    warnings.push({ code: 'INSUFFICIENT_BREAK', message: `Shifts over ${rules.breakRequiredAfterHours}h should include a ${rules.minBreakMinutes} minute break` });
  }

  let distance: number | null = null;
  if (worker.lat != null && worker.lng != null && shift.siteLat != null && shift.siteLng != null) {
    distance = Math.round(distanceKm(worker.lat, worker.lng, shift.siteLat, shift.siteLng) * 10) / 10;
    if (worker.travelRadiusKm != null && distance > worker.travelRadiusKm) {
      warnings.push({ code: 'OUT_OF_TRAVEL_RANGE', message: `Site is ${distance}km away; worker's travel limit is ${worker.travelRadiusKm}km` });
    }
  }

  return {
    eligible: blockers.length === 0,
    blockers,
    warnings,
    facts: { shiftHours, weeklyHoursAfter: Math.round(weeklyAfter * 100) / 100, restGapHours: restGap, distanceKm: distance },
  };
}

function label(code: string): string {
  return code.toLowerCase().replace(/_/g, ' ');
}
