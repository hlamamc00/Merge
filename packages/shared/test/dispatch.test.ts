import { describe, expect, it } from 'vitest';
import {
  AgencyPosition,
  DEFAULT_DISPATCH_SETTINGS,
  DispatchTier,
  OrgType,
  RelationshipKind,
  ShiftVisibility,
  accessForOrg,
  addHours,
  addMinutes,
  planDispatch,
  type DispatchOrgInput,
  type DispatchShiftInput,
  type SurplusFlagInput,
} from '../src/index.js';

const T0 = new Date('2026-11-02T08:00:00Z');

function shift(overrides: Partial<DispatchShiftInput> = {}): DispatchShiftInput {
  return {
    id: 'shift-1',
    hostOrgId: 'host',
    jobRole: 'CARE_ASSISTANT',
    startsAt: addHours(T0, 48),
    endsAt: addHours(T0, 56),
    publishedAt: T0,
    visibility: ShiftVisibility.NETWORK,
    sitePostcodeArea: 'M',
    siteLat: 53.48,
    siteLng: -2.24,
    ...overrides,
  };
}

function flag(overrides: Partial<SurplusFlagInput> = {}): SurplusFlagInput {
  return {
    id: 'flag-1',
    jobRole: 'CARE_ASSISTANT',
    startsAt: T0,
    endsAt: addHours(T0, 24 * 14),
    hoursRequested: 40,
    hoursFilled: 0,
    createdAt: addHours(T0, -5),
    ...overrides,
  };
}

function org(id: string, overrides: Partial<DispatchOrgInput> = {}): DispatchOrgInput {
  return { id, type: OrgType.PROVIDER, status: 'ACTIVE', surplusFlags: [], ...overrides };
}

describe('planDispatch', () => {
  it('releases flagged orgs first, then the agency bank, then the network (default settings)', () => {
    const plan = planDispatch(shift(), [
      org('host'),
      org('flagged', { surplusFlags: [flag()] }),
      org('agency', { type: OrgType.AGENCY }),
      org('plain'),
    ]);

    expect(plan.urgent).toBe(false);
    const byOrg = Object.fromEntries(plan.entries.map((e) => [e.orgId, e]));
    expect(byOrg.host).toBeUndefined();
    expect(byOrg.flagged!.tier).toBe(DispatchTier.PRIORITY);
    expect(byOrg.flagged!.opensAt).toEqual(T0);
    expect(byOrg.agency!.tier).toBe(DispatchTier.AGENCY);
    expect(byOrg.agency!.opensAt).toEqual(addMinutes(T0, 120));
    expect(byOrg.plain!.tier).toBe(DispatchTier.NETWORK);
    expect(byOrg.plain!.opensAt).toEqual(addMinutes(T0, 180));
    expect(plan.stages.map((s) => s.tier)).toEqual(['PRIORITY', 'AGENCY', 'NETWORK']);
  });

  it('orders flagged orgs by flag age so the earliest flag is notified first', () => {
    const plan = planDispatch(shift(), [
      org('late', { surplusFlags: [flag({ id: 'f-late', createdAt: addHours(T0, -1) })] }),
      org('early', { surplusFlags: [flag({ id: 'f-early', createdAt: addHours(T0, -10) })] }),
      org('preferred', { hostRelationship: RelationshipKind.PREFERRED }),
    ]);
    const priority = plan.entries.filter((e) => e.tier === DispatchTier.PRIORITY);
    expect(priority.map((e) => e.orgId)).toEqual(['early', 'late', 'preferred']);
    expect(priority.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(priority[0]!.matchedFlagId).toBe('f-early');
  });

  it('ignores flags that are fulfilled, expired, for the wrong role, or out of area', () => {
    const plan = planDispatch(shift(), [
      org('fulfilled', { surplusFlags: [flag({ hoursFilled: 40 })] }),
      org('expired', { surplusFlags: [flag({ startsAt: addHours(T0, -100), endsAt: addHours(T0, -50) })] }),
      org('wrong-role', { surplusFlags: [flag({ jobRole: 'ANCILLARY' })] }),
      org('wrong-area', { surplusFlags: [flag({ postcodeAreas: ['SW', 'SE'] })] }),
      org('right-area', { surplusFlags: [flag({ postcodeAreas: ['m'] })] }),
      org('too-far', { lat: 51.5, lng: -0.12, surplusFlags: [flag({ radiusKm: 30 })] }),
      org('near', { lat: 53.5, lng: -2.2, surplusFlags: [flag({ radiusKm: 30 })] }),
      org('senior-covers-ca', { surplusFlags: [flag({ jobRole: 'SENIOR_CARER' })] }),
      org('any-role', { surplusFlags: [flag({ jobRole: null })] }),
    ]);
    const tier = (id: string) => plan.entries.find((e) => e.orgId === id)!.tier;
    expect(tier('fulfilled')).toBe(DispatchTier.NETWORK);
    expect(tier('expired')).toBe(DispatchTier.NETWORK);
    expect(tier('wrong-role')).toBe(DispatchTier.NETWORK);
    expect(tier('wrong-area')).toBe(DispatchTier.NETWORK);
    expect(tier('right-area')).toBe(DispatchTier.PRIORITY);
    expect(tier('too-far')).toBe(DispatchTier.NETWORK);
    expect(tier('near')).toBe(DispatchTier.PRIORITY);
    expect(tier('senior-covers-ca')).toBe(DispatchTier.PRIORITY);
    expect(tier('any-role')).toBe(DispatchTier.PRIORITY);
  });

  it('collapses every window for urgent shifts', () => {
    const plan = planDispatch(shift({ startsAt: addHours(T0, 6), endsAt: addHours(T0, 14) }), [
      org('flagged', { surplusFlags: [flag()] }),
      org('agency', { type: OrgType.AGENCY }),
      org('plain'),
    ]);
    expect(plan.urgent).toBe(true);
    expect(plan.entries.every((e) => e.opensAt.getTime() === T0.getTime())).toBe(true);
  });

  it('never opens a stage later than the minimum lead time before the shift starts', () => {
    // 14h lead: not urgent, but 120 + 60 min windows would push the network stage to T0+3h which is fine;
    // a 20h priority override would push beyond startsAt-1h and must be clamped.
    const plan = planDispatch(
      shift({ startsAt: addHours(T0, 14), endsAt: addHours(T0, 22), priorityWindowMinutesOverride: 20 * 60 }),
      [org('flagged', { surplusFlags: [flag()] }), org('agency', { type: OrgType.AGENCY }), org('plain')],
    );
    const latest = addHours(T0, 13);
    for (const e of plan.entries) expect(e.opensAt.getTime()).toBeLessThanOrEqual(latest.getTime());
  });

  it('respects each agency position setting', () => {
    const orgs = [org('flagged', { surplusFlags: [flag()] }), org('agency', { type: OrgType.AGENCY }), org('plain')];
    const at = (position: AgencyPosition) => {
      const plan = planDispatch(shift(), orgs, { ...DEFAULT_DISPATCH_SETTINGS, agencyPosition: position });
      const m = (id: string) => plan.entries.find((e) => e.orgId === id)!.opensAt.getTime() - T0.getTime();
      return { flagged: m('flagged') / 60000, agency: m('agency') / 60000, plain: m('plain') / 60000 };
    };
    expect(at(AgencyPosition.FIRST)).toEqual({ agency: 0, flagged: 60, plain: 180 });
    expect(at(AgencyPosition.WITH_PRIORITY)).toEqual({ agency: 0, flagged: 0, plain: 120 });
    expect(at(AgencyPosition.AFTER_PRIORITY)).toEqual({ flagged: 0, agency: 120, plain: 180 });
    expect(at(AgencyPosition.WITH_NETWORK)).toEqual({ flagged: 0, agency: 120, plain: 120 });
    expect(at(AgencyPosition.LAST)).toEqual({ flagged: 0, plain: 120, agency: 180 });
  });

  it('lets an agency with its own surplus flag in with the priority tier', () => {
    const plan = planDispatch(shift(), [org('agency', { type: OrgType.AGENCY, surplusFlags: [flag()] })], {
      ...DEFAULT_DISPATCH_SETTINGS,
      agencyPosition: AgencyPosition.LAST,
    });
    expect(plan.entries[0]!.tier).toBe(DispatchTier.AGENCY);
    expect(plan.entries[0]!.opensAt).toEqual(T0);
  });

  it('excludes blocked and inactive organisations', () => {
    const plan = planDispatch(shift(), [
      org('blocked-by-host', { hostRelationship: RelationshipKind.BLOCKED, surplusFlags: [flag()] }),
      org('blocks-host', { orgRelationshipToHost: RelationshipKind.BLOCKED }),
      org('suspended', { status: 'SUSPENDED' }),
    ]);
    expect(plan.entries).toHaveLength(0);
    expect(plan.excluded.map((e) => e.orgId).sort()).toEqual(['blocked-by-host', 'blocks-host', 'suspended']);
  });

  it('honours restricted visibilities', () => {
    const orgs = [
      org('flagged', { surplusFlags: [flag()] }),
      org('preferred', { hostRelationship: RelationshipKind.PREFERRED }),
      org('agency', { type: OrgType.AGENCY }),
      org('plain'),
    ];
    const ids = (v: ShiftVisibility) => planDispatch(shift({ visibility: v }), orgs).entries.map((e) => e.orgId).sort();
    expect(ids(ShiftVisibility.PRIORITY_ONLY)).toEqual(['agency', 'flagged', 'preferred']);
    expect(ids(ShiftVisibility.PREFERRED_ONLY)).toEqual(['preferred']);
    expect(ids(ShiftVisibility.AGENCY_ONLY)).toEqual(['agency']);
  });

  it('answers access questions for a given moment', () => {
    const plan = planDispatch(shift(), [org('flagged', { surplusFlags: [flag()] }), org('plain')]);
    expect(accessForOrg(plan, 'flagged', T0).open).toBe(true);
    expect(accessForOrg(plan, 'plain', T0).open).toBe(false);
    expect(accessForOrg(plan, 'plain', addMinutes(T0, 181)).open).toBe(true);
    expect(accessForOrg(plan, 'unknown', T0)).toEqual({ open: false });
  });
});
