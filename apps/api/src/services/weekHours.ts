import { and, countDistinct, eq, gte, inArray, lt } from 'drizzle-orm';
import { addHours, startOfIsoWeek } from '@merge/shared';
import type { Db } from '../db/client.js';
import { workerWeekHours, type CapacityFlag, type WorkerWeekHours } from '../db/schema.js';
import { newId } from '../lib/ids.js';

/**
 * Decision 8: eligibility assumes a worker works their full contracted hours for their employer.
 * A worker_week_hours row replaces that assumption for one ISO week, either because a manager
 * recorded the real figure or because a surplus flag named the worker as free.
 */

export const weekStartFor = (date: Date): Date => startOfIsoWeek(date);

/** The Monday after `weekStart`; aiming at noon keeps a DST change from landing on the wrong side of midnight. */
export function nextWeekStart(weekStart: Date): Date {
  return startOfIsoWeek(addHours(weekStart, 7 * 24 + 12));
}

/** Monday instants of every ISO week that overlaps [from, to). */
export function weekStartsBetween(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  for (let w = weekStartFor(from); w.getTime() < to.getTime(); w = nextWeekStart(w)) out.push(w);
  return out;
}

export function getWeekHoursRow(db: Db, workerId: string, weekStart: Date): WorkerWeekHours | undefined {
  return db.select().from(workerWeekHours).where(and(eq(workerWeekHours.workerId, workerId), eq(workerWeekHours.weekStart, weekStart))).get();
}

export function getInternalHours(db: Db, workerId: string, weekStart: Date): number | null {
  return getWeekHoursRow(db, workerId, weekStart)?.internalHours ?? null;
}

export interface SetInternalHoursInput {
  workerId: string;
  weekStart: Date;
  internalHours: number;
  note?: string | null;
  sourceFlagId?: string | null;
  userId?: string | null;
}

/** Upsert the week's figure. A manual edit detaches the row from any flag so withdrawing the flag leaves it alone. */
export function setInternalHours(db: Db, input: SetInternalHoursInput, now: Date): WorkerWeekHours {
  const set = { internalHours: input.internalHours, note: input.note ?? null, sourceFlagId: input.sourceFlagId ?? null, setByUserId: input.userId ?? null, updatedAt: now };
  db.insert(workerWeekHours)
    .values({ id: newId('wwh'), workerId: input.workerId, weekStart: input.weekStart, ...set, createdAt: now })
    .onConflictDoUpdate({ target: [workerWeekHours.workerId, workerWeekHours.weekStart], set })
    .run();
  return getWeekHoursRow(db, input.workerId, input.weekStart)!;
}

/** Back to the contracted-hours assumption for that week. */
export function clearInternalHours(db: Db, workerId: string, weekStart: Date): boolean {
  return db.delete(workerWeekHours).where(and(eq(workerWeekHours.workerId, workerId), eq(workerWeekHours.weekStart, weekStart))).run().changes > 0;
}

/** Rows for weeks starting in [startOfIsoWeek(from), to). */
export function listWeekHours(db: Db, workerId: string, from: Date, to: Date): WorkerWeekHours[] {
  return db
    .select()
    .from(workerWeekHours)
    .where(and(eq(workerWeekHours.workerId, workerId), gte(workerWeekHours.weekStart, weekStartFor(from)), lt(workerWeekHours.weekStart, to)))
    .orderBy(workerWeekHours.weekStart)
    .all();
}

/** A surplus flag frees the named staff: record `internalHours` for each of them in every week the flag covers. Returns rows written. */
export function releaseWorkersForFlag(db: Db, flag: Pick<CapacityFlag, 'id' | 'startsAt' | 'endsAt'>, workerIds: string[], internalHours: number, userId: string | null | undefined, now: Date): number {
  const weeks = weekStartsBetween(flag.startsAt, flag.endsAt);
  let written = 0;
  for (const workerId of new Set(workerIds)) {
    for (const weekStart of weeks) {
      setInternalHours(db, { workerId, weekStart, internalHours, sourceFlagId: flag.id, userId }, now);
      written += 1;
    }
  }
  return written;
}

/** Withdrawing a flag puts its staff back on their contracted hours from `fromWeekStart` on; weeks already worked stay as recorded. */
export function clearWeekHoursForFlag(db: Db, flagId: string, fromWeekStart: Date): number {
  return db.delete(workerWeekHours).where(and(eq(workerWeekHours.sourceFlagId, flagId), gte(workerWeekHours.weekStart, fromWeekStart))).run().changes;
}

/** How many distinct workers each flag freed, keyed by flag id (flags with none are absent). */
export function releasedWorkerCounts(db: Db, flagIds: string[]): Map<string, number> {
  if (flagIds.length === 0) return new Map();
  const rows = db
    .select({ flagId: workerWeekHours.sourceFlagId, workers: countDistinct(workerWeekHours.workerId) })
    .from(workerWeekHours)
    .where(inArray(workerWeekHours.sourceFlagId, flagIds))
    .groupBy(workerWeekHours.sourceFlagId)
    .all();
  return new Map(rows.filter((r) => r.flagId).map((r) => [r.flagId!, Number(r.workers)]));
}
