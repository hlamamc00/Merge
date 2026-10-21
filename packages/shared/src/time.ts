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

/** The time zone working-time weeks are counted in. */
export const PLATFORM_TIME_ZONE = 'Europe/London';

/** Offset (ms) of `timeZone` from UTC at instant `d`; positive east of Greenwich (BST = +3,600,000). */
export function timeZoneOffsetMs(d: Date, timeZone = PLATFORM_TIME_ZONE): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d);
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** Monday 00:00 local time (Europe/London) of the ISO week containing `d`, as an instant. */
export function startOfIsoWeek(d: Date, timeZone = PLATFORM_TIME_ZONE): Date {
  const offset = timeZoneOffsetMs(d, timeZone);
  const local = new Date(d.getTime() + offset); // wall-clock fields readable via getUTC*
  const diffToMonday = (local.getUTCDay() + 6) % 7;
  const mondayLocalMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - diffToMonday);
  // Convert the local midnight back to an instant using the offset in force at that moment.
  const guess = new Date(mondayLocalMidnight - offset);
  return new Date(mondayLocalMidnight - timeZoneOffsetMs(guess, timeZone));
}

/** Paid hours for a shift once the unpaid break is removed. */
export function shiftPaidHours(startsAt: Date, endsAt: Date, breakMinutes = 0): number {
  const gross = hoursBetween(startsAt, endsAt);
  return Math.max(0, round2(gross - breakMinutes / 60));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
