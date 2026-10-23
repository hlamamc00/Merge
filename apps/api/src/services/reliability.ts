/**
 * Decision 4: no-shows are the employer's disciplinary matter, but the platform counts them per employer
 * and removes priority access, then suspends, when they repeat inside the configured window.
 */
import { and, eq, gte, inArray } from 'drizzle-orm';
import { NotificationType, OrgType, addDays } from '@merge/shared';
import type { Db } from '../db/client.js';
import { organisations, shiftAssignments, shifts, type PlatformSettingsRow } from '../db/schema.js';
import type { Notifier } from '../lib/notify.js';

export interface Reliability {
  orgId: string;
  windowDays: number;
  noShows: number;
  lateCancellations: number;
  confirmedOrCompleted: number;
  /** 100 = spotless; each no-show costs 15 points, each late cancellation 5. */
  score: number;
  priorityPenaltyUntil: Date | null;
  status: string;
}

export function reliabilityFor(db: Db, settings: PlatformSettingsRow, orgId: string, now: Date): Reliability {
  const since = addDays(now, -settings.noShowWindowDays);
  const rows = db
    .select({ status: shiftAssignments.status, late: shiftAssignments.lateCancellation })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .where(and(eq(shiftAssignments.supplierOrgId, orgId), gte(shifts.startsAt, since), inArray(shiftAssignments.status, ['CONFIRMED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'])))
    .all();
  const noShows = rows.filter((r) => r.status === 'NO_SHOW').length;
  const lateCancellations = rows.filter((r) => r.status === 'CANCELLED' && r.late).length;
  const confirmedOrCompleted = rows.filter((r) => r.status === 'CONFIRMED' || r.status === 'COMPLETED').length;
  const org = db.select({ priorityPenaltyUntil: organisations.priorityPenaltyUntil, status: organisations.status }).from(organisations).where(eq(organisations.id, orgId)).get();
  return {
    orgId,
    windowDays: settings.noShowWindowDays,
    noShows,
    lateCancellations,
    confirmedOrCompleted,
    score: Math.max(0, 100 - noShows * 15 - lateCancellations * 5),
    priorityPenaltyUntil: org?.priorityPenaltyUntil ?? null,
    status: org?.status ?? 'UNKNOWN',
  };
}

export function platformOwnerOrgId(db: Db, settings: PlatformSettingsRow): string | null {
  if (settings.ownerOrgId) return settings.ownerOrgId;
  return db.select({ id: organisations.id }).from(organisations).where(eq(organisations.type, OrgType.AGENCY)).get()?.id ?? null;
}

/** Re-count after a no-show and apply the configured consequence. */
export function applyNoShowConsequences(db: Db, notifier: Notifier, settings: PlatformSettingsRow, supplierOrgId: string, now: Date): { noShows: number; penalised: boolean; suspended: boolean } {
  const r = reliabilityFor(db, settings, supplierOrgId, now);
  const org = db.select().from(organisations).where(eq(organisations.id, supplierOrgId)).get();
  if (!org) return { noShows: r.noShows, penalised: false, suspended: false };
  const owner = platformOwnerOrgId(db, settings);
  let penalised = false;
  let suspended = false;
  if (r.noShows >= settings.noShowSuspensionThreshold && org.status === 'ACTIVE' && org.type !== OrgType.AGENCY) {
    const reason = `${r.noShows} no-shows in ${settings.noShowWindowDays} days (threshold ${settings.noShowSuspensionThreshold})`;
    db.update(organisations).set({ status: 'SUSPENDED', suspendedReason: reason, updatedAt: now }).where(eq(organisations.id, org.id)).run();
    suspended = true;
    notifier.send({ orgId: org.id, type: NotificationType.SYSTEM, title: 'Your organisation has been suspended from the network', body: `${reason}. Contact the platform to discuss reinstatement; no-shows are a disciplinary matter for you as the employer.`, data: { kind: 'no-show-suspension', noShows: r.noShows } });
    if (owner) notifier.send({ orgId: owner, type: NotificationType.SYSTEM, title: `${org.name} suspended after repeated no-shows`, body: `${reason}. Review and reinstate from Platform admin when appropriate.`, data: { kind: 'no-show-suspension', orgId: org.id } });
  } else if (r.noShows >= settings.noShowPriorityPenaltyThreshold && (!org.priorityPenaltyUntil || org.priorityPenaltyUntil.getTime() < now.getTime())) {
    const until = addDays(now, settings.noShowPriorityPenaltyDays);
    db.update(organisations).set({ priorityPenaltyUntil: until, updatedAt: now }).where(eq(organisations.id, org.id)).run();
    penalised = true;
    notifier.send({ orgId: org.id, type: NotificationType.SYSTEM, title: 'Priority access removed after repeated no-shows', body: `${r.noShows} no-shows in the last ${settings.noShowWindowDays} days. Your surplus flags will not give you first access until ${until.toISOString().slice(0, 10)}. A further no-show may lead to suspension.`, data: { kind: 'no-show-penalty', until: until.toISOString() } });
    if (owner) notifier.send({ orgId: owner, type: NotificationType.SYSTEM, title: `${org.name} lost priority access after ${r.noShows} no-shows`, body: `Priority access suspended until ${until.toISOString().slice(0, 10)}.`, data: { kind: 'no-show-penalty', orgId: org.id } });
  }
  return { noShows: r.noShows, penalised, suspended };
}
