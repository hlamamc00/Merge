import {
  AgencyPosition,
  DispatchTier,
  OrgType,
  RelationshipKind,
  ShiftVisibility,
  roleCanCover,
  type JobRole,
  type OrgStatus,
} from '../enums.js';
import { distanceKm } from '../geo.js';
import { addMinutes, minDate, minutesBetween, rangesOverlap } from '../time.js';

/**
 * Platform-level dispatch settings. The agency that owns the platform controls these.
 */
export interface DispatchSettings {
  /** How long priority organisations have exclusive access before the next stage opens. */
  priorityWindowMinutes: number;
  /** Exclusive window for the agency's own bank when its position is FIRST or AFTER_PRIORITY. */
  agencyWindowMinutes: number;
  /** Where the agency's own worker bank sits in the release order. */
  agencyPosition: AgencyPosition;
  /** If the shift starts within this many minutes of publishing, every stage opens immediately. */
  urgentThresholdMinutes: number;
  /** No stage may open later than this many minutes before the shift starts. */
  minLeadBeforeStartMinutes: number;
  /** Treat the host's preferred partners as priority organisations even without a surplus flag. */
  preferredPartnersGetPriority: boolean;
}

export const DEFAULT_DISPATCH_SETTINGS: DispatchSettings = {
  priorityWindowMinutes: 120,
  agencyWindowMinutes: 60,
  agencyPosition: AgencyPosition.AFTER_PRIORITY,
  urgentThresholdMinutes: 12 * 60,
  minLeadBeforeStartMinutes: 60,
  preferredPartnersGetPriority: true,
};

export interface DispatchShiftInput {
  id: string;
  hostOrgId: string;
  jobRole: JobRole;
  startsAt: Date;
  endsAt: Date;
  publishedAt: Date;
  visibility: ShiftVisibility;
  sitePostcodeArea?: string | null;
  siteLat?: number | null;
  siteLng?: number | null;
  /** Host may shorten (or lengthen) the priority window for this shift. */
  priorityWindowMinutesOverride?: number | null;
}

export interface SurplusFlagInput {
  id: string;
  /** null = any role */
  jobRole?: JobRole | null;
  startsAt: Date;
  endsAt: Date;
  hoursRequested: number;
  hoursFilled: number;
  createdAt: Date;
  /** Restrict to shifts whose site is in one of these postcode areas (e.g. ["M", "SK"]). Empty/null = anywhere. */
  postcodeAreas?: string[] | null;
  /** Restrict to shifts within this distance of the organisation. null = anywhere. */
  radiusKm?: number | null;
}

export interface DispatchOrgInput {
  id: string;
  name?: string;
  type: OrgType;
  status: OrgStatus;
  lat?: number | null;
  lng?: number | null;
  /** This organisation's currently ACTIVE surplus flags. */
  surplusFlags: SurplusFlagInput[];
  /** How the host has marked this organisation. */
  hostRelationship?: RelationshipKind | null;
  /** How this organisation has marked the host. */
  orgRelationshipToHost?: RelationshipKind | null;
}

export interface DispatchEntry {
  orgId: string;
  tier: DispatchTier;
  opensAt: Date;
  /** 1-based order within the tier; used for notification ordering and fairness reporting. */
  rank: number;
  reason: string;
  matchedFlagId?: string;
  distanceKm?: number;
}

export interface DispatchExclusion {
  orgId: string;
  reason: string;
}

export interface DispatchStage {
  tier: DispatchTier;
  opensAt: Date;
}

export interface DispatchPlan {
  shiftId: string;
  publishedAt: Date;
  urgent: boolean;
  stages: DispatchStage[];
  entries: DispatchEntry[];
  excluded: DispatchExclusion[];
}

export interface FlagMatch {
  flag: SurplusFlagInput;
  distanceKm?: number;
}

/**
 * Decide whether a surplus flag applies to a shift.
 *   - the flag must have hours remaining
 *   - the flag's role (if any) must be allowed to cover the shift's role
 *   - the flag's period must overlap the shift
 *   - the flag's geography (postcode areas and/or radius) must include the site, when known
 */
export function matchSurplusFlag(
  shift: DispatchShiftInput,
  org: Pick<DispatchOrgInput, 'lat' | 'lng'>,
  flag: SurplusFlagInput,
): FlagMatch | null {
  if (flag.hoursFilled >= flag.hoursRequested) return null;
  if (flag.jobRole && !roleCanCover(flag.jobRole, shift.jobRole)) return null;
  if (!rangesOverlap(flag.startsAt, flag.endsAt, shift.startsAt, shift.endsAt)) return null;

  if (flag.postcodeAreas && flag.postcodeAreas.length > 0) {
    if (!shift.sitePostcodeArea) return null;
    const areas = flag.postcodeAreas.map((a) => a.toUpperCase());
    if (!areas.includes(shift.sitePostcodeArea.toUpperCase())) return null;
  }

  let distance: number | undefined;
  if (org.lat != null && org.lng != null && shift.siteLat != null && shift.siteLng != null) {
    distance = distanceKm(org.lat, org.lng, shift.siteLat, shift.siteLng);
    if (flag.radiusKm != null && distance > flag.radiusKm) return null;
  }
  return { flag, distanceKm: distance };
}

/** Pick the best matching flag for an org: the oldest one (first-come, first-served fairness). */
export function bestFlagMatch(shift: DispatchShiftInput, org: DispatchOrgInput): FlagMatch | null {
  const matches = org.surplusFlags
    .map((f) => matchSurplusFlag(shift, org, f))
    .filter((m): m is FlagMatch => m !== null)
    .sort((a, b) => a.flag.createdAt.getTime() - b.flag.createdAt.getTime());
  return matches[0] ?? null;
}

interface StageTimes {
  priority: Date;
  agency: Date;
  network: Date;
  urgent: boolean;
}

export function computeStageTimes(shift: DispatchShiftInput, settings: DispatchSettings): StageTimes {
  const t0 = shift.publishedAt;
  const lead = minutesBetween(t0, shift.startsAt);
  const urgent = lead <= settings.urgentThresholdMinutes;

  const priorityWindow = urgent ? 0 : Math.max(0, shift.priorityWindowMinutesOverride ?? settings.priorityWindowMinutes);
  const agencyWindow = urgent ? 0 : Math.max(0, settings.agencyWindowMinutes);

  let priority: Date;
  let agency: Date;
  let network: Date;
  switch (settings.agencyPosition) {
    case AgencyPosition.FIRST:
      agency = t0;
      priority = addMinutes(t0, agencyWindow);
      network = addMinutes(priority, priorityWindow);
      break;
    case AgencyPosition.WITH_PRIORITY:
      priority = t0;
      agency = t0;
      network = addMinutes(t0, priorityWindow);
      break;
    case AgencyPosition.WITH_NETWORK:
      priority = t0;
      network = addMinutes(t0, priorityWindow);
      agency = network;
      break;
    case AgencyPosition.LAST:
      priority = t0;
      network = addMinutes(t0, priorityWindow);
      agency = addMinutes(network, agencyWindow);
      break;
    case AgencyPosition.AFTER_PRIORITY:
    default:
      priority = t0;
      agency = addMinutes(t0, priorityWindow);
      network = addMinutes(agency, agencyWindow);
      break;
  }

  // Never let a stage open so late that nobody has time to react before the shift starts.
  const latest = addMinutes(shift.startsAt, -settings.minLeadBeforeStartMinutes);
  const clamp = (d: Date) => (latest.getTime() < t0.getTime() ? t0 : minDate(d, latest));
  return { priority: clamp(priority), agency: clamp(agency), network: clamp(network), urgent };
}

/**
 * Build the staged release plan for a shift: who gets to see and claim it, and from when.
 *
 * Tier order (default settings): organisations with a matching SURPLUS flag (and preferred partners)
 * → the agency's own bank → everyone else. Urgent shifts collapse all windows to "now".
 */
export function planDispatch(
  shift: DispatchShiftInput,
  orgs: DispatchOrgInput[],
  settings: DispatchSettings = DEFAULT_DISPATCH_SETTINGS,
): DispatchPlan {
  const times = computeStageTimes(shift, settings);
  const priorityEntries: Array<Omit<DispatchEntry, 'rank'> & { sortKey: number; sortKey2: number }> = [];
  const agencyEntries: Array<Omit<DispatchEntry, 'rank'>> = [];
  const networkEntries: Array<Omit<DispatchEntry, 'rank'> & { sortKey: number }> = [];
  const excluded: DispatchExclusion[] = [];

  for (const org of orgs) {
    if (org.id === shift.hostOrgId) continue; // a host fills internally via its own rota, not the exchange
    if (org.status !== 'ACTIVE') {
      excluded.push({ orgId: org.id, reason: `Organisation is ${org.status.toLowerCase()}` });
      continue;
    }
    if (org.hostRelationship === RelationshipKind.BLOCKED) {
      excluded.push({ orgId: org.id, reason: 'Blocked by the host organisation' });
      continue;
    }
    if (org.orgRelationshipToHost === RelationshipKind.BLOCKED) {
      excluded.push({ orgId: org.id, reason: 'This organisation has blocked the host' });
      continue;
    }

    const isAgency = org.type === OrgType.AGENCY;
    const isPreferred = org.hostRelationship === RelationshipKind.PREFERRED;
    const flagMatch = bestFlagMatch(shift, org);
    const distance =
      flagMatch?.distanceKm ??
      (org.lat != null && org.lng != null && shift.siteLat != null && shift.siteLng != null
        ? distanceKm(org.lat, org.lng, shift.siteLat, shift.siteLng)
        : undefined);

    if (shift.visibility === ShiftVisibility.AGENCY_ONLY) {
      if (isAgency) {
        agencyEntries.push({ orgId: org.id, tier: DispatchTier.AGENCY, opensAt: shift.publishedAt, reason: 'Agency-only shift', distanceKm: distance });
      } else {
        excluded.push({ orgId: org.id, reason: 'Shift is restricted to the agency bank' });
      }
      continue;
    }

    if (shift.visibility === ShiftVisibility.PREFERRED_ONLY) {
      if (isPreferred) {
        priorityEntries.push({ orgId: org.id, tier: DispatchTier.PRIORITY, opensAt: shift.publishedAt, reason: 'Preferred partner (preferred-only shift)', sortKey: 1, sortKey2: 0, distanceKm: distance });
      } else {
        excluded.push({ orgId: org.id, reason: 'Shift is restricted to preferred partners' });
      }
      continue;
    }

    if (isAgency) {
      // The agency bank has its own stage, but a matching surplus flag never makes it wait longer than priority orgs.
      const opensAt = flagMatch ? minDate(times.agency, times.priority) : times.agency;
      agencyEntries.push({
        orgId: org.id,
        tier: DispatchTier.AGENCY,
        opensAt,
        reason: flagMatch ? `Agency bank with matching surplus flag (${describeFlag(flagMatch.flag)})` : `Agency bank (${settings.agencyPosition.toLowerCase().replace('_', ' ')})`,
        matchedFlagId: flagMatch?.flag.id,
        distanceKm: distance,
      });
      continue;
    }

    if (flagMatch) {
      priorityEntries.push({
        orgId: org.id,
        tier: DispatchTier.PRIORITY,
        opensAt: times.priority,
        reason: `Surplus flag: ${describeFlag(flagMatch.flag)}`,
        matchedFlagId: flagMatch.flag.id,
        distanceKm: distance,
        sortKey: 0,
        sortKey2: flagMatch.flag.createdAt.getTime(),
      });
      continue;
    }

    if (isPreferred && settings.preferredPartnersGetPriority) {
      priorityEntries.push({ orgId: org.id, tier: DispatchTier.PRIORITY, opensAt: times.priority, reason: 'Preferred partner', distanceKm: distance, sortKey: 1, sortKey2: 0 });
      continue;
    }

    if (shift.visibility === ShiftVisibility.PRIORITY_ONLY) {
      excluded.push({ orgId: org.id, reason: 'Shift is restricted to priority organisations' });
      continue;
    }

    networkEntries.push({ orgId: org.id, tier: DispatchTier.NETWORK, opensAt: times.network, reason: 'Network', distanceKm: distance, sortKey: distance ?? Number.MAX_SAFE_INTEGER });
  }

  // Flagged organisations first (oldest flag first = first-come, first-served), then preferred partners.
  priorityEntries.sort((a, b) => a.sortKey - b.sortKey || a.sortKey2 - b.sortKey2 || a.orgId.localeCompare(b.orgId));
  networkEntries.sort((a, b) => a.sortKey - b.sortKey || a.orgId.localeCompare(b.orgId));

  const entries: DispatchEntry[] = [
    ...priorityEntries.map(({ sortKey: _a, sortKey2: _b, ...e }, i) => ({ ...e, rank: i + 1 })),
    ...agencyEntries.map((e, i) => ({ ...e, rank: i + 1 })),
    ...networkEntries.map(({ sortKey: _a, ...e }, i) => ({ ...e, rank: i + 1 })),
  ];

  const stages: DispatchStage[] = [];
  if (priorityEntries.length > 0) stages.push({ tier: DispatchTier.PRIORITY, opensAt: priorityEntries[0]!.opensAt });
  if (agencyEntries.length > 0) stages.push({ tier: DispatchTier.AGENCY, opensAt: agencyEntries[0]!.opensAt });
  if (networkEntries.length > 0) stages.push({ tier: DispatchTier.NETWORK, opensAt: networkEntries[0]!.opensAt });
  stages.sort((a, b) => a.opensAt.getTime() - b.opensAt.getTime());

  return { shiftId: shift.id, publishedAt: shift.publishedAt, urgent: times.urgent, stages, entries, excluded };
}

function describeFlag(flag: SurplusFlagInput): string {
  const remaining = Math.max(0, flag.hoursRequested - flag.hoursFilled);
  const role = flag.jobRole ? flag.jobRole.toLowerCase().replace(/_/g, ' ') : 'any role';
  return `${remaining}h of ${flag.hoursRequested}h remaining, ${role}`;
}

/** Convenience: can `orgId` act on the shift at `now` according to the plan? */
export function accessForOrg(plan: DispatchPlan, orgId: string, now: Date): { open: boolean; opensAt?: Date; tier?: DispatchTier } {
  const entry = plan.entries.find((e) => e.orgId === orgId);
  if (!entry) return { open: false };
  return { open: entry.opensAt.getTime() <= now.getTime(), opensAt: entry.opensAt, tier: entry.tier };
}
