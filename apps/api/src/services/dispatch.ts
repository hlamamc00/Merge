import { and, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  CapacityFlagKind,
  JOB_ROLE_LABELS,
  NotificationType,
  ShiftStatus,
  minDate,
  planDispatch,
  postcodeArea,
  type DispatchOrgInput,
  type DispatchPlan,
  type DispatchShiftInput,
  type DispatchTier,
  type RelationshipKind,
} from '@merge/shared';
import type { Db } from '../db/client.js';
import { capacityFlags, orgRelationships, organisations, shiftAccess, shifts, sites, type PlatformSettingsRow, type Shift, type Site } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import type { Notifier } from '../lib/notify.js';
import { dispatchSettingsFrom } from './settings.js';

/** Gather every organisation on the network with the data the engine needs to place it in a tier. */
export function loadDispatchOrgs(db: Db, hostOrgId: string, now: Date): DispatchOrgInput[] {
  const orgs = db.select().from(organisations).all();
  const flags = db
    .select()
    .from(capacityFlags)
    .where(and(eq(capacityFlags.kind, CapacityFlagKind.SURPLUS), eq(capacityFlags.status, 'ACTIVE'), gt(capacityFlags.endsAt, now)))
    .all();
  const rels = db.select().from(orgRelationships).all();

  return orgs.map((o) => {
    const hostRel = rels.find((r) => r.orgId === hostOrgId && r.otherOrgId === o.id);
    const orgRel = rels.find((r) => r.orgId === o.id && r.otherOrgId === hostOrgId);
    return {
      id: o.id,
      name: o.name,
      type: o.type,
      status: o.status,
      lat: o.lat,
      lng: o.lng,
      hostRelationship: (hostRel?.kind as RelationshipKind | undefined) ?? null,
      orgRelationshipToHost: (orgRel?.kind as RelationshipKind | undefined) ?? null,
      surplusFlags: flags
        .filter((f) => f.orgId === o.id)
        .map((f) => ({
          id: f.id,
          jobRole: f.jobRole,
          startsAt: f.startsAt,
          endsAt: f.endsAt,
          hoursRequested: f.hoursRequested,
          hoursFilled: f.hoursFilled,
          createdAt: f.createdAt,
          postcodeAreas: f.postcodeAreas,
          radiusKm: f.radiusKm,
        })),
    };
  });
}

export function toDispatchShift(shift: Shift, site: Site, publishedAt: Date): DispatchShiftInput {
  return {
    id: shift.id,
    hostOrgId: shift.hostOrgId,
    jobRole: shift.jobRole,
    startsAt: shift.startsAt,
    endsAt: shift.endsAt,
    publishedAt,
    visibility: shift.visibility,
    sitePostcodeArea: postcodeArea(site.postcode),
    siteLat: site.lat,
    siteLng: site.lng,
    priorityWindowMinutesOverride: shift.priorityWindowMinutesOverride,
  };
}

export function buildPlan(db: Db, settings: PlatformSettingsRow, shift: Shift, site: Site, publishedAt: Date, now: Date): DispatchPlan {
  const orgs = loadDispatchOrgs(db, shift.hostOrgId, now);
  return planDispatch(toDispatchShift(shift, site, publishedAt), orgs, dispatchSettingsFrom(settings));
}

/** Replace the persisted access rows for a shift with a fresh plan. */
export function persistPlan(db: Db, plan: DispatchPlan): void {
  db.delete(shiftAccess).where(eq(shiftAccess.shiftId, plan.shiftId)).run();
  if (plan.entries.length === 0) return;
  db.insert(shiftAccess)
    .values(
      plan.entries.map((e) => ({
        id: newId('acc'),
        shiftId: plan.shiftId,
        orgId: e.orgId,
        tier: e.tier,
        opensAt: e.opensAt,
        rank: e.rank,
        reason: e.reason,
        matchedFlagId: e.matchedFlagId ?? null,
        notifiedAt: null,
      })),
    )
    .run();
}

/**
 * Re-plan an open shift without ever making an organisation wait longer than it already was.
 * Used when a new surplus flag arrives: the flagging org is promoted into the priority tier
 * for shifts that are still open, while everyone else keeps their existing access time.
 */
export function replanOpenShiftsForOrg(db: Db, settings: PlatformSettingsRow, orgId: string, now: Date): number {
  const open = db
    .select({ shift: shifts, site: sites })
    .from(shifts)
    .innerJoin(sites, eq(sites.id, shifts.siteId))
    .where(and(eq(shifts.status, ShiftStatus.OPEN), gt(shifts.startsAt, now)))
    .all();
  let changed = 0;
  for (const { shift, site } of open) {
    if (shift.hostOrgId === orgId) continue;
    const plan = buildPlan(db, settings, shift, site, shift.publishedAt ?? now, now);
    const entry = plan.entries.find((e) => e.orgId === orgId);
    if (!entry) continue;
    const existing = db.select().from(shiftAccess).where(and(eq(shiftAccess.shiftId, shift.id), eq(shiftAccess.orgId, orgId))).get();
    const opensAt = existing ? minDate(existing.opensAt, entry.opensAt) : entry.opensAt;
    if (existing && existing.opensAt.getTime() === opensAt.getTime() && existing.tier === entry.tier) continue;
    if (existing) {
      db.update(shiftAccess)
        .set({ tier: entry.tier, opensAt, rank: entry.rank, reason: entry.reason, matchedFlagId: entry.matchedFlagId ?? null })
        .where(eq(shiftAccess.id, existing.id))
        .run();
    } else {
      db.insert(shiftAccess)
        .values({ id: newId('acc'), shiftId: shift.id, orgId, tier: entry.tier, opensAt, rank: entry.rank, reason: entry.reason, matchedFlagId: entry.matchedFlagId ?? null, notifiedAt: null })
        .run();
    }
    changed++;
  }
  return changed;
}

export interface AccessInfo {
  open: boolean;
  opensAt?: Date;
  tier?: DispatchTier;
  reason?: string;
  matchedFlagId?: string | null;
}

export function accessFor(db: Db, shiftId: string, orgId: string, now: Date): AccessInfo {
  const row = db.select().from(shiftAccess).where(and(eq(shiftAccess.shiftId, shiftId), eq(shiftAccess.orgId, orgId))).get();
  if (!row) return { open: false };
  return { open: row.opensAt.getTime() <= now.getTime(), opensAt: row.opensAt, tier: row.tier, reason: row.reason, matchedFlagId: row.matchedFlagId };
}

/**
 * Notify organisations whose access stage has just opened. Runs on publish and from the scheduler.
 * Returns the number of organisations notified.
 */
export function notifyDueAccess(db: Db, notifier: Notifier, now: Date): number {
  const due = db
    .select({ access: shiftAccess, shift: shifts, site: sites })
    .from(shiftAccess)
    .innerJoin(shifts, eq(shifts.id, shiftAccess.shiftId))
    .innerJoin(sites, eq(sites.id, shifts.siteId))
    .where(and(lte(shiftAccess.opensAt, now), isNull(shiftAccess.notifiedAt), eq(shifts.status, ShiftStatus.OPEN), gt(shifts.startsAt, now)))
    .all();
  if (due.length === 0) return 0;
  for (const { access, shift, site } of due) {
    const tierLabel = access.tier === 'PRIORITY' ? 'Priority access' : access.tier === 'AGENCY' ? 'Agency bank access' : 'Now open to the network';
    notifier.send({
      orgId: access.orgId,
      type: NotificationType.SHIFT_AVAILABLE,
      title: `${tierLabel}: ${JOB_ROLE_LABELS[shift.jobRole]} shift at ${site.name}`,
      body: `${shift.title} · ${shift.startsAt.toISOString()} – ${shift.endsAt.toISOString()} · £${shift.chargeRate.toFixed(2)}/h · ${shift.headcount - shift.filledCount} place(s) left${access.tier === 'PRIORITY' ? ` · ${access.reason}` : ''}`,
      data: { shiftId: shift.id, tier: access.tier, rank: access.rank, urgent: shift.urgent },
    });
  }
  db.update(shiftAccess)
    .set({ notifiedAt: now })
    .where(inArray(shiftAccess.id, due.map((d) => d.access.id)))
    .run();
  return due.length;
}

/** Full plan for display (host, admin): rows with organisation names. */
export function planForShift(db: Db, shiftId: string) {
  return db
    .select({
      orgId: shiftAccess.orgId,
      orgName: organisations.name,
      orgType: organisations.type,
      tier: shiftAccess.tier,
      opensAt: shiftAccess.opensAt,
      rank: shiftAccess.rank,
      reason: shiftAccess.reason,
      matchedFlagId: shiftAccess.matchedFlagId,
      notifiedAt: shiftAccess.notifiedAt,
    })
    .from(shiftAccess)
    .innerJoin(organisations, eq(organisations.id, shiftAccess.orgId))
    .where(eq(shiftAccess.shiftId, shiftId))
    .orderBy(shiftAccess.opensAt, sql`case ${shiftAccess.tier} when 'PRIORITY' then 0 when 'AGENCY' then 1 else 2 end`, shiftAccess.rank)
    .all();
}
