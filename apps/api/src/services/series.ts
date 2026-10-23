/** PR-05: recurring posting. A pattern or an explicit list of occurrences becomes a set of shifts sharing a series id. */
import { eq } from 'drizzle-orm';
import { timeZoneOffsetMs, PLATFORM_TIME_ZONE } from '@merge/shared';
import type { Db } from '../db/client.js';
import { shiftSeries, shifts, type PlatformSettingsRow, type Shift, type Site } from '../db/schema.js';
import { unprocessable } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { Notifier } from '../lib/notify.js';
import { createShift, type NewShiftData } from './shifts.js';

export interface SeriesPattern {
  /** Local start time, e.g. "19:00". */
  startTime: string;
  durationHours: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  timeZone?: string;
}

export const MAX_OCCURRENCES = 60;

/** Local wall-clock → instant, for the platform time zone (handles the clock change correctly). */
function localToInstant(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const guess = new Date(wall - timeZoneOffsetMs(new Date(wall), timeZone));
  return new Date(wall - timeZoneOffsetMs(guess, timeZone));
}

export function expandPattern(p: SeriesPattern): Array<{ startsAt: Date; endsAt: Date }> {
  const tz = p.timeZone ?? PLATFORM_TIME_ZONE;
  if (!/^\d{2}:\d{2}$/.test(p.startTime)) throw unprocessable('startTime must be HH:mm');
  const from = new Date(`${p.from}T00:00:00Z`);
  const to = new Date(`${p.to}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) throw unprocessable('Invalid date range');
  const out: Array<{ startsAt: Date; endsAt: Date }> = [];
  for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 86_400_000)) {
    if (!p.weekdays.includes(d.getUTCDay())) continue;
    const startsAt = localToInstant(d.toISOString().slice(0, 10), p.startTime, tz);
    out.push({ startsAt, endsAt: new Date(startsAt.getTime() + p.durationHours * 3_600_000) });
    if (out.length > MAX_OCCURRENCES) throw unprocessable(`A series may contain at most ${MAX_OCCURRENCES} shifts`);
  }
  return out;
}

export function createSeries(
  db: Db,
  notifier: Notifier,
  settings: PlatformSettingsRow,
  host: { orgId: string; site: Site; createdByUserId: string; allowPending?: boolean },
  template: Omit<NewShiftData, 'startsAt' | 'endsAt'>,
  occurrences: Array<{ startsAt: Date; endsAt: Date }>,
  publish: boolean,
  pattern: Record<string, unknown>,
  now: Date,
): { seriesId: string; shifts: Shift[] } {
  if (occurrences.length === 0) throw unprocessable('No occurrences in the series');
  if (occurrences.length > MAX_OCCURRENCES) throw unprocessable(`A series may contain at most ${MAX_OCCURRENCES} shifts`);
  for (const o of occurrences) {
    if (!(o.endsAt > o.startsAt)) throw unprocessable('Each occurrence must end after it starts');
    if (o.startsAt.getTime() <= now.getTime()) throw unprocessable(`Occurrence ${o.startsAt.toISOString()} is in the past`);
  }
  const seriesId = newId('ser');
  db.insert(shiftSeries).values({ id: seriesId, hostOrgId: host.orgId, title: template.title, pattern, createdByUserId: host.createdByUserId, createdAt: now }).run();
  const created: Shift[] = [];
  for (const o of occurrences) {
    created.push(createShift(db, notifier, settings, { hostOrgId: host.orgId, site: host.site, data: { ...template, startsAt: o.startsAt, endsAt: o.endsAt }, publish, createdByUserId: host.createdByUserId, seriesId, allowPending: host.allowPending }, now));
  }
  return { seriesId, shifts: created };
}

export function seriesShifts(db: Db, seriesId: string): Shift[] {
  return db.select().from(shifts).where(eq(shifts.seriesId, seriesId)).orderBy(shifts.startsAt).all();
}
