import { hoursBetween, rangesOverlap, shiftPaidHours, startOfIsoWeek, addDays } from '../time.js';

/**
 * Working-time rules applied when a worker is matched to a shift. Defaults follow the
 * UK Working Time Regulations; the platform admin can tune them.
 */
export interface WorkingTimeRules {
  /** Minimum rest between the end of one shift and the start of the next (WTR: 11h). */
  minRestHours: number;
  /** Maximum paid hours in a Monday–Sunday week unless the worker has opted out (WTR: 48h average). */
  maxWeeklyHours: number;
  /** Longest single shift the platform will book (warning above `warnShiftHours`, blocked above this). */
  maxShiftHours: number;
  warnShiftHours: number;
  /** Shifts longer than this must include at least `minBreakMinutes` unpaid break (WTR: 20 min after 6h). */
  breakRequiredAfterHours: number;
  minBreakMinutes: number;
}

export const DEFAULT_WORKING_TIME_RULES: WorkingTimeRules = {
  minRestHours: 11,
  maxWeeklyHours: 48,
  maxShiftHours: 14,
  warnShiftHours: 12,
  breakRequiredAfterHours: 6,
  minBreakMinutes: 20,
};

export interface BookedShift {
  startsAt: Date;
  endsAt: Date;
  breakMinutes?: number;
}

export function overlapsAny(shift: BookedShift, booked: BookedShift[]): BookedShift | undefined {
  return booked.find((b) => rangesOverlap(shift.startsAt, shift.endsAt, b.startsAt, b.endsAt));
}

/** Smallest rest gap (hours) between the candidate shift and any already-booked shift. */
export function minimumRestGapHours(shift: BookedShift, booked: BookedShift[]): number {
  let min = Infinity;
  for (const b of booked) {
    if (rangesOverlap(shift.startsAt, shift.endsAt, b.startsAt, b.endsAt)) return 0;
    const gap = b.endsAt <= shift.startsAt ? hoursBetween(b.endsAt, shift.startsAt) : hoursBetween(shift.endsAt, b.startsAt);
    if (gap < min) min = gap;
  }
  return min;
}

/** Paid hours already booked in the Monday–Sunday week containing the candidate shift. */
export function weeklyBookedHours(shift: BookedShift, booked: BookedShift[]): number {
  const weekStart = startOfIsoWeek(shift.startsAt);
  const weekEnd = addDays(weekStart, 7);
  return booked
    .filter((b) => b.startsAt >= weekStart && b.startsAt < weekEnd)
    .reduce((sum, b) => sum + shiftPaidHours(b.startsAt, b.endsAt, b.breakMinutes ?? 0), 0);
}
