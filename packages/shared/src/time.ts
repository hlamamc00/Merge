export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * MINUTE_MS);
}

export function addHours(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * HOUR_MS);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / MINUTE_MS;
}

export function hoursBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / HOUR_MS;
}

export function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

export function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

/** True when [aStart, aEnd) and [bStart, bEnd) share any time. */
export function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

/** Monday 00:00 UTC of the ISO week containing `d`. */
export function startOfIsoWeek(d: Date): Date {
  const day = d.getUTCDay(); // 0 = Sunday
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - diffToMonday);
  return monday;
}

/** Paid hours for a shift once the unpaid break is removed. */
export function shiftPaidHours(startsAt: Date, endsAt: Date, breakMinutes = 0): number {
  const gross = hoursBetween(startsAt, endsAt);
  return Math.max(0, round2(gross - breakMinutes / 60));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
