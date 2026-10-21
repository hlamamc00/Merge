import { and, eq, gt, lt, lte } from 'drizzle-orm';
import { CapacityFlagKind, CapacityFlagStatus, JOB_ROLE_LABELS, NotificationType, type JobRole } from '@merge/shared';
import type { Db } from '../db/client.js';
import { capacityFlags, organisations, type CapacityFlag, type PlatformSettingsRow } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import type { Notifier } from '../lib/notify.js';
import { replanOpenShiftsForOrg } from './dispatch.js';

export interface NewFlagInput {
  orgId: string;
  kind: CapacityFlagKind;
  jobRole?: JobRole | null;
  headcount?: number;
  hoursRequested: number;
  startsAt: Date;
  endsAt: Date;
  siteId?: string | null;
  postcodeAreas?: string[] | null;
  radiusKm?: number | null;
  note?: string | null;
  createdByUserId?: string | null;
}

export function createFlag(db: Db, settings: PlatformSettingsRow, input: NewFlagInput, now: Date): CapacityFlag {
  const id = newId('flag');
  db.insert(capacityFlags)
    .values({
      id,
      orgId: input.orgId,
      kind: input.kind,
      jobRole: input.jobRole ?? null,
      headcount: input.headcount ?? 1,
      hoursRequested: input.hoursRequested,
      hoursFilled: 0,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      siteId: input.siteId ?? null,
      postcodeAreas: input.postcodeAreas && input.postcodeAreas.length > 0 ? input.postcodeAreas.map((a) => a.toUpperCase()) : null,
      radiusKm: input.radiusKm ?? null,
      note: input.note ?? null,
      status: CapacityFlagStatus.ACTIVE,
      createdByUserId: input.createdByUserId ?? null,
      closedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  // A new surplus flag promotes the organisation on shifts that are already open.
  if (input.kind === CapacityFlagKind.SURPLUS) replanOpenShiftsForOrg(db, settings, input.orgId, now);
  return db.select().from(capacityFlags).where(eq(capacityFlags.id, id)).get()!;
}

export function withdrawFlag(db: Db, flag: CapacityFlag, now: Date): CapacityFlag {
  db.update(capacityFlags).set({ status: CapacityFlagStatus.WITHDRAWN, closedAt: now, updatedAt: now }).where(eq(capacityFlags.id, flag.id)).run();
  return db.select().from(capacityFlags).where(eq(capacityFlags.id, flag.id)).get()!;
}

/** Record hours covered against a surplus flag when an assignment is confirmed; fulfil it when the request is met. */
export function applyHoursToFlag(db: Db, notifier: Notifier, flagId: string | null | undefined, hours: number, now: Date): boolean {
  if (!flagId) return false;
  const flag = db.select().from(capacityFlags).where(eq(capacityFlags.id, flagId)).get();
  if (!flag || flag.status !== CapacityFlagStatus.ACTIVE) return false;
  const hoursFilled = flag.hoursFilled + hours;
  const fulfilled = hoursFilled >= flag.hoursRequested;
  db.update(capacityFlags)
    .set({ hoursFilled, status: fulfilled ? CapacityFlagStatus.FULFILLED : flag.status, closedAt: fulfilled ? now : null, updatedAt: now })
    .where(eq(capacityFlags.id, flag.id))
    .run();
  if (fulfilled) {
    notifier.send({
      orgId: flag.orgId,
      type: NotificationType.FLAG_FULFILLED,
      title: 'Capacity flag fulfilled',
      body: `Your surplus flag for ${flag.jobRole ? JOB_ROLE_LABELS[flag.jobRole] : 'any role'} (${flag.hoursRequested}h) has been fully matched. Raise a new flag if you still have staff to place.`,
      data: { flagId: flag.id },
    });
  }
  return true;
}

/** Give hours back to a flag when a confirmed assignment is cancelled. */
export function releaseHoursFromFlag(db: Db, flagId: string | null | undefined, hours: number, now: Date): void {
  if (!flagId) return;
  const flag = db.select().from(capacityFlags).where(eq(capacityFlags.id, flagId)).get();
  if (!flag) return;
  const hoursFilled = Math.max(0, flag.hoursFilled - hours);
  const reactivate = flag.status === CapacityFlagStatus.FULFILLED && hoursFilled < flag.hoursRequested && flag.endsAt.getTime() > now.getTime();
  db.update(capacityFlags)
    .set({ hoursFilled, status: reactivate ? CapacityFlagStatus.ACTIVE : flag.status, closedAt: reactivate ? null : flag.closedAt, updatedAt: now })
    .where(eq(capacityFlags.id, flag.id))
    .run();
}

export function expireFlags(db: Db, now: Date): number {
  const due = db.select({ id: capacityFlags.id }).from(capacityFlags).where(and(eq(capacityFlags.status, CapacityFlagStatus.ACTIVE), lt(capacityFlags.endsAt, now))).all();
  for (const f of due) db.update(capacityFlags).set({ status: CapacityFlagStatus.EXPIRED, closedAt: now, updatedAt: now }).where(eq(capacityFlags.id, f.id)).run();
  return due.length;
}

export interface NetworkCapacityRow {
  jobRole: JobRole | 'ANY';
  surplusHoursRemaining: number;
  surplusOrgs: number;
  shortageHoursRemaining: number;
  shortageOrgs: number;
}

/** Aggregated live picture of supply and demand across the network, by role. */
export function networkCapacity(db: Db, now: Date, includeOrgs: boolean) {
  const active = db
    .select({ flag: capacityFlags, orgName: organisations.name })
    .from(capacityFlags)
    .innerJoin(organisations, eq(organisations.id, capacityFlags.orgId))
    .where(and(eq(capacityFlags.status, CapacityFlagStatus.ACTIVE), lte(capacityFlags.startsAt, now), gt(capacityFlags.endsAt, now)))
    .all();
  const byRole = new Map<string, NetworkCapacityRow & { surplusOrgIds: Set<string>; shortageOrgIds: Set<string> }>();
  for (const { flag } of active) {
    const key = flag.jobRole ?? 'ANY';
    const row = byRole.get(key) ?? { jobRole: key as JobRole | 'ANY', surplusHoursRemaining: 0, surplusOrgs: 0, shortageHoursRemaining: 0, shortageOrgs: 0, surplusOrgIds: new Set<string>(), shortageOrgIds: new Set<string>() };
    const remaining = Math.max(0, flag.hoursRequested - flag.hoursFilled);
    if (flag.kind === CapacityFlagKind.SURPLUS) {
      row.surplusHoursRemaining += remaining;
      row.surplusOrgIds.add(flag.orgId);
    } else {
      row.shortageHoursRemaining += remaining;
      row.shortageOrgIds.add(flag.orgId);
    }
    byRole.set(key, row);
  }
  const summary = [...byRole.values()].map(({ surplusOrgIds, shortageOrgIds, ...r }) => ({ ...r, surplusOrgs: surplusOrgIds.size, shortageOrgs: shortageOrgIds.size }));
  return {
    summary,
    flags: includeOrgs
      ? active.map(({ flag, orgName }) => ({ ...flag, orgName, hoursRemaining: Math.max(0, flag.hoursRequested - flag.hoursFilled) }))
      : undefined,
  };
}
