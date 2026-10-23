/**
 * Area B: dispatch and trust. Floor rate, escalation, credit hold, soft request holds, no-show penalties,
 * bars and reports, leaver handling, bulk actions, recurring posting, and the board/worker view.
 */
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { addDays, addHours, requiredDocumentsForRole, type JobRole } from '@merge/shared';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations } from '../src/db/client.js';
import { hostRequirements, organisations, platformSettings, shiftAssignments, shifts, workerHostRequirements } from '../src/db/schema.js';
import { Notifier } from '../src/lib/notify.js';
import { cancelFutureBookingsForWorker } from '../src/services/assignments.js';
import { getSettings } from '../src/services/settings.js';

const T0 = new Date('2026-11-02T08:00:00Z');
let clock = T0;
const { db } = openDatabase(':memory:');
runMigrations(db);
const { app } = createApp({ db, now: () => clock, channels: [] });
// Two-factor set-up (decision 16) is covered by the security suite; this suite is about dispatch and trust.
db.update(platformSettings).set({ twoFactorRequiredForManagers: false }).where(eq(platformSettings.id, 'default')).run();
const api = request(app);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

interface Session {
  token: string;
  orgId: string;
  userId: string;
}
interface Notif {
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
}

async function register(name: string, extra: Record<string, unknown> = {}): Promise<Session> {
  const res = await api.post('/api/v1/auth/register').send({
    organisation: { name, postcode: 'M20 2RN', lat: 53.4186, lng: -2.2311, ...extra },
    admin: { email: `${name.toLowerCase().replace(/\s+/g, '')}@example.com`, password: 'password123', firstName: 'Admin', lastName: name },
  });
  expect(res.status).toBe(201);
  const approved = await api.patch(`/api/v1/organisations/${res.body.organisation.id}`).set(auth(agency.token)).send({ status: 'ACTIVE' });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  return { token: res.body.token, orgId: res.body.organisation.id, userId: res.body.user.id };
}

async function addWorker(s: Session, firstName: string, jobRole: JobRole = 'CARE_ASSISTANT', opts: { lat?: number; lng?: number } = {}) {
  const res = await api.post('/api/v1/workers').set(auth(s.token)).send({ firstName, lastName: 'Worker', jobRole, skills: ['MOVING_AND_HANDLING', 'DEMENTIA'], shareable: true, lat: opts.lat ?? 53.41, lng: opts.lng ?? -2.16, travelRadiusKm: 40 });
  expect(res.status).toBe(201);
  for (const type of requiredDocumentsForRole(jobRole)) {
    const doc = await api.post(`/api/v1/workers/${res.body.id}/documents`).set(auth(s.token)).send({ type, expiresAt: addDays(clock, 400).toISOString() });
    expect(doc.status).toBe(201);
    expect((await api.patch(`/api/v1/workers/${res.body.id}/documents/${doc.body.id}`).set(auth(s.token)).send({ verified: true })).status).toBe(200);
  }
  return res.body as { id: string; orgId: string };
}

async function postShift(s: Session, body: Record<string, unknown>) {
  const res = await api.post('/api/v1/shifts').set(auth(s.token)).send({ siteId: oakSite.id, jobRole: 'CARE_ASSISTANT', title: 'Shift', breakMinutes: 30, chargeRate: 20, publish: true, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; status: string; chargeRate: number; seriesId: string | null; plan: Array<{ orgId: string; tier: string; opensAt: string; reason: string }> };
}

async function inbox(s: Session): Promise<Notif[]> {
  const res = await api.get('/api/v1/notifications?unread=false').set(auth(s.token));
  expect(res.status).toBe(200);
  return res.body.notifications as Notif[];
}

const kindOf = (n: Notif) => (n.data as { kind?: string } | null)?.kind;

/** Open every tier at once so suppliers can act without waiting for the staged windows. */
async function openToAll(shiftId: string) {
  const res = await api.post(`/api/v1/shifts/${shiftId}/escalate`).set(auth(oakwood.token)).send({ openToAll: true });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

let agency: Session;
let oakwood: Session; // host
let riverside: Session; // surplus-flagged supplier with worker self-service
let pennine: Session; // plain network supplier
let oakSite: { id: string };
let farSite: { id: string };
let aisha: { id: string };
let bea: { id: string };
let cara: { id: string };
let dev: { id: string };
let sophie: { id: string };
let dan: { id: string };

beforeAll(async () => {
  const boot = await api.post('/api/v1/auth/bootstrap').send({
    organisation: { name: 'Merge Staffing', postcode: 'M1 4BT', lat: 53.4794, lng: -2.2453 },
    admin: { email: 'admin@merge.local', password: 'password123', firstName: 'Priya', lastName: 'Shah' },
  });
  expect(boot.status).toBe(201);
  agency = { token: boot.body.token, orgId: boot.body.organisation.id, userId: boot.body.user.id };
  oakwood = await register('Oakwood Care');
  riverside = await register('Riverside Living', { postcode: 'SK4 1AB', lat: 53.4106, lng: -2.1575, workerSelfServiceAllowed: true });
  pennine = await register('Pennine Nursing', { postcode: 'OL1 3DF', lat: 53.5409, lng: -2.1114 });

  const site = await api.post(`/api/v1/organisations/${oakwood.orgId}/sites`).set(auth(oakwood.token)).send({ name: 'Oakwood Manor', postcode: 'M20 2RN', lat: 53.4186, lng: -2.2311 });
  expect(site.status).toBe(201);
  oakSite = site.body;
  const far = await api.post(`/api/v1/organisations/${oakwood.orgId}/sites`).set(auth(oakwood.token)).send({ name: 'Oakwood Lakes', postcode: 'BL1 1AA', lat: 53.58, lng: -2.43 });
  expect(far.status).toBe(201);
  farSite = far.body;

  aisha = await addWorker(riverside, 'Aisha');
  bea = await addWorker(riverside, 'Bea');
  cara = await addWorker(riverside, 'Cara');
  dev = await addWorker(riverside, 'Dev');
  sophie = await addWorker(pennine, 'Sophie');
  dan = await addWorker(agency, 'Dan');

  const flag = await api.post('/api/v1/capacity/flags').set(auth(riverside.token)).send({ kind: 'SURPLUS', jobRole: 'CARE_ASSISTANT', headcount: 4, hoursRequested: 400, startsAt: clock.toISOString(), endsAt: addDays(clock, 60).toISOString(), postcodeAreas: ['M', 'SK', 'BL'] });
  expect(flag.status).toBe(201);
});

describe('floor rate (decision 3)', () => {
  it('publishes the floor and how it is worked out', async () => {
    const res = await api.get('/api/v1/shifts/floor-rate').set(auth(oakwood.token));
    expect(res.status).toBe(200);
    // 12.71 × 1.25 ÷ 0.92 = 17.27 → 17.30
    expect(res.body.floor).toBe(17.3);
    expect(res.body.basis).toMatchObject({ nationalMinimumWage: 12.71, employerOnCostPct: 25, platformFeePct: 8 });
  });

  it('refuses rates below the floor for everyone, platform admin included', async () => {
    const low = await api.post('/api/v1/shifts').set(auth(oakwood.token)).send({ siteId: oakSite.id, jobRole: 'CARE_ASSISTANT', title: 'Cheap', startsAt: addDays(clock, 3).toISOString(), endsAt: addHours(addDays(clock, 3), 8).toISOString(), chargeRate: 15 });
    expect(low.status).toBe(422);
    expect(low.body.details.floor).toBe(17.3);
    const admin = await api.post('/api/v1/shifts').set(auth(agency.token)).send({ hostOrgId: oakwood.orgId, siteId: oakSite.id, jobRole: 'CARE_ASSISTANT', title: 'Cheap', startsAt: addDays(clock, 3).toISOString(), endsAt: addHours(addDays(clock, 3), 8).toISOString(), chargeRate: 17.25 });
    expect(admin.status).toBe(422);
    const ok = await postShift(oakwood, { title: 'At the floor', startsAt: addDays(clock, 3).toISOString(), endsAt: addHours(addDays(clock, 3), 8).toISOString(), chargeRate: 17.3, publish: false });
    expect(ok.status).toBe('DRAFT');
    const edit = await api.patch(`/api/v1/shifts/${ok.id}`).set(auth(oakwood.token)).send({ chargeRate: 16 });
    expect(edit.status).toBe(422);
  });
});

describe('host requirements on a shift (decision 11)', () => {
  let reqId: string;
  let shiftId: string;

  it('only accepts requirement ids that belong to the host', async () => {
    reqId = 'hrq_test1';
    db.insert(hostRequirements).values({ id: reqId, hostOrgId: oakwood.orgId, name: 'Oakwood induction', description: null, recordedByHost: true, createdAt: clock }).run();
    const bad = await api.post('/api/v1/shifts').set(auth(oakwood.token)).send({ siteId: oakSite.id, jobRole: 'CARE_ASSISTANT', title: 'Induction needed', startsAt: addDays(clock, 4).toISOString(), endsAt: addHours(addDays(clock, 4), 8).toISOString(), chargeRate: 20, requiredHostRequirementIds: ['hrq_nope'] });
    expect(bad.status).toBe(422);
    const shift = await postShift(oakwood, { title: 'Induction needed', startsAt: addDays(clock, 4).toISOString(), endsAt: addHours(addDays(clock, 4), 8).toISOString(), requiredHostRequirementIds: [reqId] });
    shiftId = shift.id;
  });

  it('blocks workers without the requirement until it is recorded', async () => {
    const before = await api.get(`/api/v1/shifts/${shiftId}/eligible-workers`).set(auth(riverside.token));
    expect(before.status).toBe(200);
    const aishaRow = before.body.workers.find((w: { id: string }) => w.id === aisha.id);
    expect(aishaRow.eligible).toBe(false);
    expect(aishaRow.blockers.map((b: { code: string }) => b.code)).toContain('MISSING_HOST_REQUIREMENT');
    db.insert(workerHostRequirements).values({ id: 'whr_test1', workerId: aisha.id, requirementId: reqId, documentId: null, expiresAt: null, recordedByUserId: oakwood.userId, createdAt: clock }).run();
    const after = await api.get(`/api/v1/shifts/${shiftId}/eligible-workers`).set(auth(riverside.token));
    expect(after.body.workers.find((w: { id: string }) => w.id === aisha.id).eligible).toBe(true);
  });
});

describe('credit hold and suspension gates', () => {
  it('refuses to publish while the host is on credit hold, but keeps drafts', async () => {
    db.update(organisations).set({ creditHold: true }).where(eq(organisations.id, oakwood.orgId)).run();
    const blocked = await api.post('/api/v1/shifts').set(auth(oakwood.token)).send({ siteId: oakSite.id, jobRole: 'CARE_ASSISTANT', title: 'Held', startsAt: addDays(clock, 3).toISOString(), endsAt: addHours(addDays(clock, 3), 8).toISOString(), chargeRate: 20, publish: true });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatch(/overdue/);
    const draft = await postShift(oakwood, { title: 'Held draft', startsAt: addDays(clock, 3).toISOString(), endsAt: addHours(addDays(clock, 3), 8).toISOString(), publish: false });
    expect((await api.post(`/api/v1/shifts/${draft.id}/publish`).set(auth(oakwood.token))).status).toBe(403);
    db.update(organisations).set({ creditHold: false }).where(eq(organisations.id, oakwood.orgId)).run();
    expect((await api.post(`/api/v1/shifts/${draft.id}/publish`).set(auth(oakwood.token))).status).toBe(200);
  });
});

describe('soft request holds (decision 7)', () => {
  let s1: string;
  let s2: string;
  let a1: string;
  let a2: string;

  it('lets a worker be put forward for overlapping shifts, with a warning', async () => {
    s1 = (await postShift(oakwood, { title: 'Morning A', startsAt: addDays(clock, 3).toISOString(), endsAt: addHours(addDays(clock, 3), 8).toISOString() })).id;
    s2 = (await postShift(oakwood, { title: 'Morning B', siteId: farSite.id, startsAt: addHours(addDays(clock, 3), 2).toISOString(), endsAt: addHours(addDays(clock, 3), 10).toISOString() })).id;
    const r1 = await api.post(`/api/v1/shifts/${s1}/requests`).set(auth(riverside.token)).send({ workerId: aisha.id });
    expect(r1.status).toBe(201);
    expect(r1.body.warnings.map((w: { code: string }) => w.code)).not.toContain('PENDING_ELSEWHERE');
    a1 = r1.body.assignment.id;
    const r2 = await api.post(`/api/v1/shifts/${s2}/requests`).set(auth(riverside.token)).send({ workerId: aisha.id });
    expect(r2.status).toBe(201);
    expect(r2.body.warnings.map((w: { code: string }) => w.code)).toContain('PENDING_ELSEWHERE');
    a2 = r2.body.assignment.id;
  });

  it('withdraws the other holds when one is confirmed, and then blocks a double booking', async () => {
    expect((await api.post(`/api/v1/assignments/${a1}/confirm`).set(auth(oakwood.token))).status).toBe(200);
    const other = await api.get(`/api/v1/assignments/${a2}`).set(auth(oakwood.token));
    expect(other.body.status).toBe('WITHDRAWN');
    expect(other.body.note).toBe('Worker confirmed elsewhere');
    expect((await inbox(oakwood)).some((n) => kindOf(n) === 'confirmed-elsewhere')).toBe(true);
    const again = await api.post(`/api/v1/shifts/${s2}/requests`).set(auth(riverside.token)).send({ workerId: aisha.id });
    expect(again.status).toBe(422);
    expect(again.body.details.blockers.map((b: { code: string }) => b.code)).toContain('OVERLAPPING_SHIFT');
  });

  it('reminds the platform owner to chase a host that leaves a request unanswered', async () => {
    const s3 = (await postShift(oakwood, { title: 'Next week', startsAt: addDays(clock, 5).toISOString(), endsAt: addHours(addDays(clock, 5), 8).toISOString() })).id;
    expect((await api.post(`/api/v1/shifts/${s3}/requests`).set(auth(riverside.token)).send({ workerId: bea.id })).status).toBe(201);
    clock = addHours(clock, 13);
    const tick = await api.post('/api/v1/admin/scheduler/tick').set(auth(agency.token));
    expect(tick.status).toBe(200);
    expect(tick.body.operatorReminders).toBe(1);
    const reminders = (await inbox(agency)).filter((n) => kindOf(n) === 'request-reminder');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.title).toMatch(/Chase Oakwood Care/);
    expect((await api.post('/api/v1/admin/scheduler/tick').set(auth(agency.token))).body.operatorReminders).toBe(0);
  });
});

describe('escalation (decision 6)', () => {
  it('raises the rate step by step and opens every tier for AUTO hosts', async () => {
    db.update(organisations).set({ escalationMode: 'AUTO', escalationCeilingPct: 20 }).where(eq(organisations.id, oakwood.orgId)).run();
    const startsAt = addHours(clock, 50);
    const shift = await postShift(oakwood, { title: 'Auto escalated', startsAt: startsAt.toISOString(), endsAt: addHours(startsAt, 8).toISOString(), chargeRate: 20 });
    expect(shift.plan.find((p) => p.orgId === pennine.orgId)!.tier).toBe('NETWORK');
    const pennineBefore = await api.get(`/api/v1/shifts/${shift.id}`).set(auth(pennine.token));
    expect(pennineBefore.body.access.open).toBe(false);

    clock = addHours(startsAt, -47);
    const t1 = await api.post('/api/v1/admin/scheduler/tick').set(auth(agency.token));
    expect(t1.body.escalations.auto).toBeGreaterThanOrEqual(1);
    let detail = await api.get(`/api/v1/shifts/${shift.id}`).set(auth(oakwood.token));
    expect(detail.body.chargeRate).toBe(21.4);
    expect(detail.body.escalationStep).toBe(1);
    expect(detail.body.originalChargeRate).toBe(20);
    expect((await api.get(`/api/v1/shifts/${shift.id}`).set(auth(pennine.token))).body.access.open).toBe(true);
    expect((await inbox(oakwood)).some((n) => kindOf(n) === 'escalation' && (n.data as { shiftId: string }).shiftId === shift.id)).toBe(true);

    clock = addHours(startsAt, -23);
    await api.post('/api/v1/admin/scheduler/tick').set(auth(agency.token));
    detail = await api.get(`/api/v1/shifts/${shift.id}`).set(auth(oakwood.token));
    expect(detail.body.chargeRate).toBe(22.8);
    expect(detail.body.escalationStep).toBe(2);

    clock = addHours(startsAt, -11);
    await api.post('/api/v1/admin/scheduler/tick').set(auth(agency.token));
    detail = await api.get(`/api/v1/shifts/${shift.id}`).set(auth(oakwood.token));
    expect(detail.body.chargeRate).toBe(24); // 20 × 1.21 capped at the 20% ceiling
    expect(detail.body.escalation.history).toHaveLength(3);
    expect(detail.body.escalation.ceilingRate).toBe(24);
    // Idempotent: a further tick inside the same step does nothing.
    await api.post('/api/v1/admin/scheduler/tick').set(auth(agency.token));
    expect((await api.get(`/api/v1/shifts/${shift.id}`).set(auth(oakwood.token))).body.escalationStep).toBe(3);
  });

  it('prompts MANUAL hosts and lets them escalate by hand', async () => {
    db.update(organisations).set({ escalationMode: 'MANUAL' }).where(eq(organisations.id, oakwood.orgId)).run();
    const startsAt = addHours(clock, 40);
    const shift = await postShift(oakwood, { title: 'Manual', startsAt: startsAt.toISOString(), endsAt: addHours(startsAt, 8).toISOString(), chargeRate: 20 });
    const t = await api.post('/api/v1/admin/scheduler/tick').set(auth(agency.token));
    expect(t.body.escalations.prompted).toBeGreaterThanOrEqual(1);
    const prompt = (await inbox(oakwood)).find((n) => kindOf(n) === 'escalation-prompt' && (n.data as { shiftId: string }).shiftId === shift.id);
    expect(prompt).toBeDefined();
    expect((await api.get(`/api/v1/shifts/${shift.id}`).set(auth(oakwood.token))).body.chargeRate).toBe(20);

    const esc = await api.post(`/api/v1/shifts/${shift.id}/escalate`).set(auth(oakwood.token)).send({ raiseRatePct: 10, openToAll: true });
    expect(esc.status).toBe(200);
    expect(esc.body.newRate).toBe(22);
    expect(esc.body.opened).toBe(true);
    expect(esc.body.plan.every((p: { opensAt: string }) => new Date(p.opensAt).getTime() <= clock.getTime())).toBe(true);
    const detail = await api.get(`/api/v1/shifts/${shift.id}`).set(auth(oakwood.token));
    expect(detail.body.escalation.history.map((h: { mode: string }) => h.mode)).toEqual(['MANUAL']);
    expect((await api.post(`/api/v1/shifts/${shift.id}/escalate`).set(auth(riverside.token)).send({ openToAll: true })).status).toBe(403);
  });
});

describe('no-show penalties (decision 4)', () => {
  const noShowIds: string[] = [];

  async function bookAndNoShow(workerId: string, title: string) {
    const startsAt = addHours(clock, 2);
    const shift = await postShift(oakwood, { title, startsAt: startsAt.toISOString(), endsAt: addHours(startsAt, 6).toISOString() });
    const req = await api.post(`/api/v1/shifts/${shift.id}/requests`).set(auth(riverside.token)).send({ workerId });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    expect((await api.post(`/api/v1/assignments/${req.body.assignment.id}/confirm`).set(auth(oakwood.token))).status).toBe(200);
    clock = addHours(startsAt, 1);
    await api.post('/api/v1/admin/scheduler/tick').set(auth(agency.token));
    const ns = await api.post(`/api/v1/assignments/${req.body.assignment.id}/no-show`).set(auth(oakwood.token));
    expect(ns.status).toBe(200);
    noShowIds.push(req.body.assignment.id);
    return req.body.assignment.id as string;
  }

  it('removes priority access at the second no-show and tells both sides', async () => {
    await bookAndNoShow(cara.id, 'No-show one');
    expect((await api.get(`/api/v1/trust/reliability/${riverside.orgId}`).set(auth(oakwood.token))).body).toMatchObject({ noShows: 1, priorityPenaltyUntil: null });
    await bookAndNoShow(dev.id, 'No-show two');
    const rel = await api.get(`/api/v1/trust/reliability/${riverside.orgId}`).set(auth(oakwood.token));
    expect(rel.body.noShows).toBe(2);
    expect(rel.body.priorityPenaltyUntil).not.toBeNull();
    expect(rel.body.score).toBe(70);
    expect((await inbox(riverside)).some((n) => kindOf(n) === 'no-show-penalty')).toBe(true);
    expect((await inbox(agency)).some((n) => kindOf(n) === 'no-show-penalty')).toBe(true);

    // The surplus flag no longer buys first access: Riverside is in the network tier, and the plan says why.
    const draft = await postShift(oakwood, { title: 'After penalty', startsAt: addDays(clock, 2).toISOString(), endsAt: addHours(addDays(clock, 2), 8).toISOString(), publish: false });
    const preview = await api.get(`/api/v1/shifts/${draft.id}/dispatch-preview`).set(auth(oakwood.token));
    const riv = preview.body.entries.find((e: { orgId: string }) => e.orgId === riverside.orgId);
    expect(riv.tier).toBe('NETWORK');
    expect(riv.reason).toMatch(/priority access suspended/);
  });

  it('suspends the employer at the third no-show', async () => {
    await bookAndNoShow(bea.id, 'No-show three');
    const rel = await api.get(`/api/v1/trust/reliability/${riverside.orgId}`).set(auth(agency.token));
    expect(rel.body).toMatchObject({ noShows: 3, status: 'SUSPENDED' });
    const org = db.select().from(organisations).where(eq(organisations.id, riverside.orgId)).get()!;
    expect(org.suspendedReason).toMatch(/3 no-shows/);
    // A suspended organisation is locked out entirely (see the security suite), so it cannot even read its inbox.
    expect((await api.get('/api/v1/notifications').set(auth(riverside.token))).status).toBe(403);
    expect((await inbox(agency)).some((n) => kindOf(n) === 'no-show-suspension')).toBe(true);
    // Platform admin reinstates after speaking to the employer (modelled directly here).
    db.update(organisations).set({ status: 'ACTIVE', suspendedReason: null, priorityPenaltyUntil: null }).where(eq(organisations.id, riverside.orgId)).run();
    expect((await inbox(riverside)).some((n) => kindOf(n) === 'no-show-suspension')).toBe(true);
  });

  it('surfaces reliability and compliance on the candidate list', async () => {
    const startsAt = addDays(clock, 2);
    const shift = await postShift(oakwood, { title: 'Candidates', startsAt: startsAt.toISOString(), endsAt: addHours(startsAt, 8).toISOString() });
    await openToAll(shift.id);
    const cands = await api.get(`/api/v1/shifts/${shift.id}/candidates`).set(auth(oakwood.token));
    expect(cands.status).toBe(200);
    const sophieRow = cands.body.find((c: { id: string }) => c.id === sophie.id);
    expect(sophieRow.complianceStatus).toBe('COMPLIANT');
    expect(sophieRow.reliability).toMatchObject({ noShows: 0, score: 100 });
    const rivRow = cands.body.find((c: { orgId: string }) => c.orgId === riverside.orgId);
    expect(rivRow.reliability.noShows).toBe(3);
  });
});

describe('bars and reports (decision 14)', () => {
  let barId: string;
  let futureShift: string;
  let futureAssignment: string;

  it('bars a worker, releasing their future bookings without a late-cancellation penalty', async () => {
    const startsAt = addDays(clock, 3);
    futureShift = (await postShift(oakwood, { title: 'Future with Aisha', startsAt: startsAt.toISOString(), endsAt: addHours(startsAt, 8).toISOString() })).id;
    const req = await api.post(`/api/v1/shifts/${futureShift}/requests`).set(auth(riverside.token)).send({ workerId: aisha.id });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    futureAssignment = req.body.assignment.id;
    expect((await api.post(`/api/v1/assignments/${futureAssignment}/confirm`).set(auth(oakwood.token))).status).toBe(200);

    const stranger = await api.post('/api/v1/trust/bars').set(auth(pennine.token)).send({ workerId: aisha.id, reason: 'Never met' });
    expect(stranger.status).toBe(422);
    const bar = await api.post('/api/v1/trust/bars').set(auth(oakwood.token)).send({ workerId: aisha.id, reason: 'Repeated lateness on the Maple unit' });
    expect(bar.status).toBe(201);
    barId = bar.body.id;
    // Every future booking with this host goes, including the one confirmed in the soft-hold test.
    expect(bar.body.released.cancelled).toContain(futureAssignment);
    expect(bar.body.released.cancelled).toHaveLength(2);
    const cancelled = await api.get(`/api/v1/assignments/${futureAssignment}`).set(auth(riverside.token));
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(cancelled.body.lateCancellation).toBe(false);
    expect((await inbox(riverside)).some((n) => kindOf(n) === 'worker-bar')).toBe(true);
    expect((await api.post('/api/v1/trust/bars').set(auth(oakwood.token)).send({ workerId: aisha.id, reason: 'Again' })).status).toBe(409);
  });

  it('keeps the reason private unless shared, and blocks the worker from the host', async () => {
    const asHost = await api.get('/api/v1/trust/bars').set(auth(oakwood.token));
    expect(asHost.body).toHaveLength(1);
    expect(asHost.body[0].reason).toBe('Repeated lateness on the Maple unit');
    const asEmployer = await api.get('/api/v1/trust/bars').set(auth(riverside.token));
    expect(asEmployer.body).toHaveLength(1);
    expect(asEmployer.body[0]).toMatchObject({ reason: null, shared: false, role: 'employer', hostName: 'Oakwood Care' });
    expect((await api.get('/api/v1/trust/bars').set(auth(pennine.token))).body).toHaveLength(0);

    const elig = await api.get(`/api/v1/shifts/${futureShift}/eligible-workers`).set(auth(riverside.token));
    const row = elig.body.workers.find((w: { id: string }) => w.id === aisha.id);
    expect(row.eligible).toBe(false);
    expect(row.blockers.map((b: { code: string }) => b.code)).toContain('BARRED_BY_HOST');
  });

  it('lifts a bar', async () => {
    expect((await api.delete(`/api/v1/trust/bars/${barId}`).set(auth(riverside.token))).status).toBe(403);
    const lifted = await api.delete(`/api/v1/trust/bars/${barId}`).set(auth(oakwood.token));
    expect(lifted.status).toBe(200);
    expect(lifted.body.liftedAt).not.toBeNull();
    const elig = await api.get(`/api/v1/shifts/${futureShift}/eligible-workers`).set(auth(riverside.token));
    expect(elig.body.workers.find((w: { id: string }) => w.id === aisha.id).blockers.map((b: { code: string }) => b.code)).not.toContain('BARRED_BY_HOST');
    expect((await api.get('/api/v1/trust/bars').set(auth(oakwood.token))).body).toHaveLength(0);
  });

  it('routes a concern to the employer (and the platform for safeguarding) and tracks the response', async () => {
    const report = await api.post('/api/v1/trust/reports').set(auth(oakwood.token)).send({ workerId: cara.id, category: 'SAFEGUARDING', description: 'Left a resident unattended during personal care.' });
    expect(report.status).toBe(201);
    expect(report.body).toMatchObject({ status: 'OPEN', supplierOrgId: riverside.orgId, hostName: 'Oakwood Care' });
    expect((await inbox(riverside)).some((n) => kindOf(n) === 'worker-report')).toBe(true);
    expect((await inbox(agency)).some((n) => kindOf(n) === 'worker-report')).toBe(true);
    expect((await api.post('/api/v1/trust/reports').set(auth(oakwood.token)).send({ workerId: sophie.id, category: 'CONDUCT', description: 'Sophie has never worked for us.' })).status).toBe(422);

    const received = await api.get('/api/v1/trust/reports?scope=received').set(auth(riverside.token));
    expect(received.body).toHaveLength(1);
    expect((await api.get('/api/v1/trust/reports?scope=received').set(auth(pennine.token))).body).toHaveLength(0);
    expect((await api.get('/api/v1/trust/reports?scope=raised').set(auth(oakwood.token))).body).toHaveLength(1);

    expect((await api.post(`/api/v1/trust/reports/${report.body.id}/acknowledge`).set(auth(oakwood.token))).status).toBe(403);
    const ack = await api.post(`/api/v1/trust/reports/${report.body.id}/acknowledge`).set(auth(riverside.token));
    expect(ack.body.status).toBe('ACKNOWLEDGED');
    const closed = await api.post(`/api/v1/trust/reports/${report.body.id}/close`).set(auth(riverside.token)).send({ employerResponse: 'Investigated under our safeguarding policy; retraining completed.' });
    expect(closed.body).toMatchObject({ status: 'CLOSED', employerResponse: 'Investigated under our safeguarding policy; retraining completed.' });
    expect((await inbox(oakwood)).filter((n) => kindOf(n) === 'worker-report').length).toBeGreaterThanOrEqual(2);
  });
});

describe('leaver handling (WF-02)', () => {
  it('releases every future booking and request of a worker who leaves', async () => {
    const startsAt = addDays(clock, 4);
    const booked = await postShift(oakwood, { title: 'Dev booked', startsAt: startsAt.toISOString(), endsAt: addHours(startsAt, 8).toISOString() });
    const pending = await postShift(oakwood, { title: 'Dev pending', startsAt: addDays(startsAt, 1).toISOString(), endsAt: addHours(addDays(startsAt, 1), 8).toISOString() });
    const r1 = await api.post(`/api/v1/shifts/${booked.id}/requests`).set(auth(riverside.token)).send({ workerId: dev.id });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect((await api.post(`/api/v1/assignments/${r1.body.assignment.id}/confirm`).set(auth(oakwood.token))).status).toBe(200);
    const r2 = await api.post(`/api/v1/shifts/${pending.id}/requests`).set(auth(riverside.token)).send({ workerId: dev.id });
    expect(r2.status).toBe(201);

    const notifier = new Notifier(db, [], () => clock);
    const result = cancelFutureBookingsForWorker(db, notifier, getSettings(db), dev.id, { userId: riverside.userId, orgId: riverside.orgId }, 'Worker has left the organisation', clock);
    expect(result.cancelled).toEqual([r1.body.assignment.id]);
    expect(result.withdrawn).toEqual([r2.body.assignment.id]);
    expect(db.select().from(shiftAssignments).where(eq(shiftAssignments.id, r1.body.assignment.id)).get()!.status).toBe('CANCELLED');
    expect(db.select().from(shifts).where(eq(shifts.id, booked.id)).get()!.filledCount).toBe(0);
    expect((await inbox(oakwood)).some((n) => n.title.startsWith('Withdrawn: Dev pending'))).toBe(true);
  });
});

describe('bulk actions (DSP-02)', () => {
  it('confirms and declines many requests at once, reporting each outcome', async () => {
    const startsAt = addDays(clock, 6);
    const shift = await postShift(oakwood, { title: 'Big shift', headcount: 3, startsAt: startsAt.toISOString(), endsAt: addHours(startsAt, 8).toISOString() });
    await openToAll(shift.id);
    const ids: string[] = [];
    for (const [session, workerId] of [
      [riverside, aisha.id],
      [pennine, sophie.id],
      [agency, dan.id],
    ] as const) {
      const r = await api.post(`/api/v1/shifts/${shift.id}/requests`).set(auth(session.token)).send({ workerId });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      ids.push(r.body.assignment.id);
    }
    const confirm = await api.post('/api/v1/assignments/bulk').set(auth(oakwood.token)).send({ ids: [ids[0], ids[1], 'asg_missing'], action: 'confirm' });
    expect(confirm.status).toBe(200);
    expect(confirm.body.results).toEqual([
      { id: ids[0], ok: true, status: 'CONFIRMED' },
      { id: ids[1], ok: true, status: 'CONFIRMED' },
      { id: 'asg_missing', ok: false, error: 'Assignment not found' },
    ]);
    const decline = await api.post('/api/v1/assignments/bulk').set(auth(oakwood.token)).send({ ids: [ids[2], ids[0]], action: 'decline', reason: 'Enough cover now' });
    expect(decline.body.results[0]).toMatchObject({ id: ids[2], ok: true, status: 'DECLINED' });
    expect(decline.body.results[1].ok).toBe(false);
    expect((await api.post('/api/v1/assignments/bulk').set(auth(riverside.token)).send({ ids, action: 'confirm' })).body.results.every((r: { ok: boolean }) => !r.ok)).toBe(true);
  });
});

describe('recurring posting (PR-05)', () => {
  let seriesId: string;

  it('expands a weekly pattern into published shifts that share a series', async () => {
    const res = await api.post('/api/v1/shifts/series').set(auth(oakwood.token)).send({
      template: { siteId: oakSite.id, jobRole: 'CARE_ASSISTANT', title: 'Night – Maple', breakMinutes: 60, chargeRate: 21 },
      pattern: { startTime: '19:00', durationHours: 12, weekdays: [1, 3], from: '2026-11-16', to: '2026-11-29' },
      publish: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.count).toBe(4);
    seriesId = res.body.seriesId;
    expect(res.body.shifts.map((s: { startsAt: string }) => s.startsAt)).toEqual(['2026-11-16T19:00:00.000Z', '2026-11-18T19:00:00.000Z', '2026-11-23T19:00:00.000Z', '2026-11-25T19:00:00.000Z']);
    expect(res.body.shifts.every((s: { status: string; seriesId: string }) => s.status === 'OPEN' && s.seriesId === seriesId)).toBe(true);
    const listed = await api.get(`/api/v1/shifts?scope=posted&seriesId=${seriesId}`).set(auth(oakwood.token));
    expect(listed.body).toHaveLength(4);
    const detail = await api.get(`/api/v1/shifts/series/${seriesId}`).set(auth(oakwood.token));
    expect(detail.body.shifts).toHaveLength(4);
    expect((await api.get(`/api/v1/shifts/series/${seriesId}`).set(auth(pennine.token))).status).toBe(403);
  });

  it('refuses occurrences in the past or below the floor', async () => {
    const past = await api.post('/api/v1/shifts/series').set(auth(oakwood.token)).send({
      template: { siteId: oakSite.id, jobRole: 'CARE_ASSISTANT', title: 'Old', chargeRate: 21 },
      occurrences: [{ startsAt: addDays(clock, -1).toISOString(), endsAt: addHours(addDays(clock, -1), 8).toISOString() }],
    });
    expect(past.status).toBe(422);
    const cheap = await api.post('/api/v1/shifts/series').set(auth(oakwood.token)).send({
      template: { siteId: oakSite.id, jobRole: 'CARE_ASSISTANT', title: 'Cheap', chargeRate: 10 },
      pattern: { startTime: '07:00', durationHours: 8, weekdays: [2], from: '2026-12-01', to: '2026-12-15' },
    });
    expect(cheap.status).toBe(422);
  });

  it('copies a shift to a new date and cancels a whole series', async () => {
    const first = (await api.get(`/api/v1/shifts/series/${seriesId}`).set(auth(oakwood.token))).body.shifts[0];
    const copy = await api.post(`/api/v1/shifts/${first.id}/copy`).set(auth(oakwood.token)).send({ startsAt: '2026-12-07T19:00:00.000Z', endsAt: '2026-12-08T07:00:00.000Z', publish: true });
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ title: 'Night – Maple', chargeRate: 21, status: 'OPEN', seriesId: null });
    const cancelled = await api.post(`/api/v1/shifts/series/${seriesId}/cancel`).set(auth(oakwood.token)).send({ reason: 'Unit closing for refurbishment' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.cancelled).toHaveLength(4);
    expect(cancelled.body.shifts.every((s: { status: string }) => s.status === 'CANCELLED')).toBe(true);
  });
});

describe('board and worker view', () => {
  let workerToken: string;
  let near: string;
  let far: string;

  it('sorts and filters the board by distance and rate, and tells a worker what they can take', async () => {
    const login = await api.post(`/api/v1/workers/${aisha.id}/login`).set(auth(riverside.token)).send({ email: 'aisha@riverside.local', password: 'password123' });
    expect(login.status).toBe(201);
    const session = await api.post('/api/v1/auth/login').send({ email: 'aisha@riverside.local', password: 'password123' });
    expect(session.status).toBe(200);
    workerToken = session.body.token;

    const startsAt = addDays(clock, 8);
    near = (await postShift(oakwood, { title: 'Near board', startsAt: startsAt.toISOString(), endsAt: addHours(startsAt, 8).toISOString(), chargeRate: 19 })).id;
    far = (await postShift(oakwood, { title: 'Far board', siteId: farSite.id, startsAt: addHours(startsAt, 10).toISOString(), endsAt: addHours(startsAt, 18).toISOString(), chargeRate: 25 })).id;
    await openToAll(near);
    await openToAll(far);

    const byDistance = await api.get('/api/v1/shifts?scope=available&sort=distance').set(auth(workerToken));
    expect(byDistance.status).toBe(200);
    const rows = byDistance.body as Array<{ id: string; distanceKm: number; eligible: boolean; blockers: unknown[]; chargeRate: number | null }>;
    expect(rows.every((r) => typeof r.distanceKm === 'number' && typeof r.eligible === 'boolean' && Array.isArray(r.blockers))).toBe(true);
    expect(rows.every((r) => r.chargeRate === null)).toBe(true);
    const nearRow = rows.find((r) => r.id === near)!;
    const farRow = rows.find((r) => r.id === far)!;
    expect(nearRow.distanceKm).toBeLessThan(farRow.distanceKm);
    expect(rows.indexOf(nearRow)).toBeLessThan(rows.indexOf(farRow));
    expect(nearRow.eligible).toBe(true);

    const close = await api.get('/api/v1/shifts?scope=available&nearKm=10').set(auth(workerToken));
    expect(close.body.some((r: { id: string }) => r.id === near)).toBe(true);
    expect(close.body.some((r: { id: string }) => r.id === far)).toBe(false);

    const byRate = await api.get('/api/v1/shifts?scope=available&sort=rate').set(auth(pennine.token));
    const rates = byRate.body.map((r: { chargeRate: number }) => r.chargeRate);
    expect([...rates].sort((a, b) => b - a)).toEqual(rates);
    expect(byRate.body.find((r: { id: string }) => r.id === far).distanceKm).toBeGreaterThan(0);
    expect(byRate.body[0].eligible).toBeUndefined();
  });

  it('shows the worker their own eligibility on the shift page, and the host compliance on each booking', async () => {
    const mine = await api.get(`/api/v1/shifts/${near}`).set(auth(workerToken));
    expect(mine.status).toBe(200);
    expect(mine.body.myEligibility.eligible).toBe(true);
    expect(mine.body.distanceKm).toBeGreaterThan(0);
    expect(mine.body.chargeRate).toBeNull();

    const req = await api.post(`/api/v1/shifts/${near}/requests`).set(auth(workerToken)).send({});
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    const host = await api.get(`/api/v1/shifts/${near}`).set(auth(oakwood.token));
    expect(host.body.assignments[0].complianceStatus).toBe('COMPLIANT');
    expect(host.body.floor).toBe(17.3);
    expect(host.body.escalation).toMatchObject({ mode: 'MANUAL', originalChargeRate: 19 });
    const posted = await api.get('/api/v1/shifts?scope=posted').set(auth(oakwood.token));
    expect(posted.body.find((s: { id: string }) => s.id === near)).toHaveProperty('escalationDue');
  });
});
