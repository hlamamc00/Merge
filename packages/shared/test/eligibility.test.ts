import { describe, expect, it } from 'vitest';
import {
  addDays,
  addHours,
  complianceSummary,
  evaluateEligibility,
  requiredDocumentsForRole,
  startOfIsoWeek,
  type EligibilityShift,
  type EligibilityWorker,
  type ComplianceDocumentLike,
} from '../src/index.js';

const NOW = new Date('2026-11-01T09:00:00Z');
const START = new Date('2026-11-04T07:00:00Z'); // Wednesday

function validDocs(role: EligibilityShift['jobRole'] = 'CARE_ASSISTANT'): ComplianceDocumentLike[] {
  return requiredDocumentsForRole(role).map((type) => ({ type, expiresAt: addDays(NOW, 365), verifiedAt: addDays(NOW, -10) }));
}

function shift(overrides: Partial<EligibilityShift> = {}): EligibilityShift {
  return {
    id: 's1',
    hostOrgId: 'host',
    jobRole: 'CARE_ASSISTANT',
    startsAt: START,
    endsAt: addHours(START, 8),
    breakMinutes: 30,
    requiredSkills: ['MOVING_AND_HANDLING'],
    ...overrides,
  };
}

function worker(overrides: Partial<EligibilityWorker> = {}): EligibilityWorker {
  return {
    id: 'w1',
    orgId: 'supplier',
    jobRole: 'CARE_ASSISTANT',
    status: 'ACTIVE',
    shareable: true,
    skills: ['MOVING_AND_HANDLING', 'DEMENTIA'],
    documents: validDocs(),
    ...overrides,
  };
}

const openAccess = { open: true, opensAt: NOW, tier: 'PRIORITY' as const };

describe('evaluateEligibility', () => {
  it('passes a compliant, available worker', () => {
    const r = evaluateEligibility(shift(), worker(), { now: NOW, bookedShifts: [], access: openAccess });
    expect(r.eligible).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.facts.shiftHours).toBe(7.5);
  });

  it('blocks on the obvious things', () => {
    const r = evaluateEligibility(
      shift({ requiredSkills: ['PEG_FEEDING'] }),
      worker({ status: 'ON_LEAVE', shareable: false, jobRole: 'ANCILLARY', documents: [] }),
      { now: NOW, bookedShifts: [], access: { open: false } },
    );
    const codes = r.blockers.map((b) => b.code);
    expect(codes).toEqual(expect.arrayContaining(['WORKER_INACTIVE', 'WORKER_NOT_SHAREABLE', 'ROLE_MISMATCH', 'MISSING_SKILLS', 'NON_COMPLIANT', 'NO_ACCESS']));
  });

  it('blocks a worker from being traded back to their own organisation', () => {
    const r = evaluateEligibility(shift(), worker({ orgId: 'host' }), { now: NOW, bookedShifts: [], access: openAccess });
    expect(r.blockers.map((b) => b.code)).toContain('OWN_ORGANISATION');
  });

  it('blocks when the release stage has not opened yet', () => {
    const r = evaluateEligibility(shift(), worker(), { now: NOW, bookedShifts: [], access: { open: false, opensAt: addHours(NOW, 2), tier: 'NETWORK' } });
    expect(r.blockers.map((b) => b.code)).toEqual(['ACCESS_NOT_OPEN']);
  });

  it('enforces 11h rest and overlap', () => {
    const adjacent = { startsAt: addHours(START, -14), endsAt: addHours(START, -6) }; // only 6h gap
    const r1 = evaluateEligibility(shift(), worker(), { now: NOW, bookedShifts: [adjacent], access: openAccess });
    expect(r1.blockers.map((b) => b.code)).toEqual(['INSUFFICIENT_REST']);
    expect(r1.facts.restGapHours).toBe(6);

    const overlapping = { startsAt: addHours(START, 2), endsAt: addHours(START, 10) };
    const r2 = evaluateEligibility(shift(), worker(), { now: NOW, bookedShifts: [overlapping], access: openAccess });
    expect(r2.blockers.map((b) => b.code)).toEqual(['OVERLAPPING_SHIFT']);
  });

  it('counts a booking with identical times as an overlap (no silent self-exclusion)', () => {
    const twin = { startsAt: START, endsAt: addHours(START, 8), breakMinutes: 30 };
    const r = evaluateEligibility(shift(), worker({ maxHoursPerWeek: 10 }), { now: NOW, bookedShifts: [twin], access: openAccess });
    expect(r.eligible).toBe(false);
    expect(r.blockers.map((b) => b.code)).toEqual(['OVERLAPPING_SHIFT', 'WEEKLY_HOURS_EXCEEDED']);
    expect(r.facts.weeklyHoursAfter).toBe(15);
  });

  it('enforces the weekly hours cap, with an override for opted-out workers', () => {
    const monday = new Date('2026-11-02T07:00:00Z');
    const booked = [0, 1, 4, 5].map((d) => ({ startsAt: addDays(monday, d), endsAt: addHours(addDays(monday, d), 12), breakMinutes: 0 }));
    // 48h already booked this week; this 7.5h shift would exceed the cap.
    const r1 = evaluateEligibility(shift(), worker(), { now: NOW, bookedShifts: booked, access: openAccess });
    expect(r1.blockers.map((b) => b.code)).toEqual(['WEEKLY_HOURS_EXCEEDED']);

    const r2 = evaluateEligibility(shift(), worker({ optedOutOf48h: true }), { now: NOW, bookedShifts: booked, access: openAccess, allowHoursOverride: true });
    expect(r2.eligible).toBe(true);
    expect(r2.warnings.map((w) => w.code)).toContain('WEEKLY_HOURS_EXCEEDED');

    // Internal rota hours count too.
    const r3 = evaluateEligibility(shift(), worker({ internalHoursThisWeek: 44 }), { now: NOW, bookedShifts: [], access: openAccess });
    expect(r3.blockers.map((b) => b.code)).toEqual(['WEEKLY_HOURS_EXCEEDED']);
  });

  it('warns about long shifts, missing breaks, distance and expiring documents', () => {
    const docs = validDocs().map((d) => (d.type === 'DBS' ? { ...d, expiresAt: addDays(START, 10) } : d));
    const r = evaluateEligibility(
      shift({ endsAt: addHours(START, 13), breakMinutes: 0, siteLat: 53.48, siteLng: -2.24 }),
      worker({ documents: docs, lat: 53.0, lng: -1.5, travelRadiusKm: 20 }),
      { now: NOW, bookedShifts: [], access: openAccess },
    );
    expect(r.eligible).toBe(true);
    expect(r.warnings.map((w) => w.code).sort()).toEqual(['DOCUMENT_EXPIRING', 'INSUFFICIENT_BREAK', 'LONG_SHIFT', 'OUT_OF_TRAVEL_RANGE']);
  });

  it('judges compliance as of the shift date, not today', () => {
    const docs = validDocs().map((d) => (d.type === 'DBS' ? { ...d, expiresAt: addDays(NOW, 2) } : d));
    const r = evaluateEligibility(shift(), worker({ documents: docs }), { now: NOW, bookedShifts: [], access: openAccess });
    expect(r.blockers.map((b) => b.code)).toEqual(['NON_COMPLIANT']);
    expect(r.blockers[0]!.message).toMatch(/dbs expired/i);
  });
});

describe('working-time weeks', () => {
  it('starts the week at Monday 00:00 Europe/London, not UTC, during British Summer Time', () => {
    // Mon 1 June 2026 00:30 BST is Sun 31 May 23:30Z; it belongs to the week starting 1 June.
    const bstMondayEarly = new Date('2026-05-31T23:30:00Z');
    expect(startOfIsoWeek(bstMondayEarly).toISOString()).toBe('2026-05-31T23:00:00.000Z');
    // In winter (GMT) local midnight and UTC midnight coincide.
    expect(startOfIsoWeek(new Date('2026-11-04T07:00:00Z')).toISOString()).toBe('2026-11-02T00:00:00.000Z');
    // Hours booked in the previous (BST) week must not count against a shift in the new week.
    const previousWeek = [0, 1, 2, 3].map((d) => ({ startsAt: addDays(new Date('2026-05-25T06:00:00Z'), d), endsAt: addHours(addDays(new Date('2026-05-25T06:00:00Z'), d), 11) }));
    const r = evaluateEligibility(shift({ startsAt: bstMondayEarly, endsAt: addHours(bstMondayEarly, 8) }), worker(), { now: new Date('2026-05-20T09:00:00Z'), bookedShifts: previousWeek, access: openAccess });
    expect(r.blockers.map((b) => b.code)).toEqual([]);
    expect(r.facts.weeklyHoursAfter).toBe(7.5);
  });
});

describe('complianceSummary', () => {
  it('requires NMC PIN for nurses and medication training for seniors', () => {
    expect(requiredDocumentsForRole('NURSE')).toContain('NMC_PIN');
    expect(requiredDocumentsForRole('SENIOR_CARER')).toContain('MEDICATION_TRAINING');
    expect(requiredDocumentsForRole('CARE_ASSISTANT')).not.toContain('MEDICATION_TRAINING');
  });

  it('treats unverified documents as blocking and reports expiring ones', () => {
    const docs = validDocs().map((d) =>
      d.type === 'RIGHT_TO_WORK' ? { ...d, verifiedAt: null } : d.type === 'DBS' ? { ...d, expiresAt: addDays(NOW, 20) } : d,
    );
    const s = complianceSummary(docs, 'CARE_ASSISTANT', NOW);
    expect(s.status).toBe('NON_COMPLIANT');
    expect(s.items.find((i) => i.type === 'RIGHT_TO_WORK')!.status).toBe('PENDING_VERIFICATION');
    expect(s.items.find((i) => i.type === 'DBS')!.status).toBe('EXPIRING');
  });

  it('uses the best document when a worker has several of one type', () => {
    const docs = [...validDocs(), { type: 'DBS' as const, expiresAt: addDays(NOW, -5), verifiedAt: addDays(NOW, -400) }];
    expect(complianceSummary(docs, 'CARE_ASSISTANT', NOW).status).toBe('COMPLIANT');
  });
});

describe('unavailability', () => {
  it('blocks when the shift overlaps a worker unavailability window', () => {
    const r = evaluateEligibility(shift(), worker({ unavailableWindows: [{ startsAt: addHours(START, -24), endsAt: addHours(START, 24) }] }), {
      now: NOW,
      bookedShifts: [],
      access: openAccess,
    });
    expect(r.blockers.map((b) => b.code)).toEqual(['WORKER_UNAVAILABLE']);
  });
});
