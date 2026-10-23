import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, addHours, addMinutes, requiredDocumentsForRole, type JobRole } from '@merge/shared';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations } from '../src/db/client.js';
import { platformSettings } from '../src/db/schema.js';

const T0 = new Date('2026-11-02T08:00:00Z');
let clock = T0;
const { db } = openDatabase(':memory:');
runMigrations(db);
const { app } = createApp({ db, now: () => clock, channels: [] });
// Two-factor enrolment is covered by compliance-security.test.ts; this suite exercises the rest of the platform without it.
db.update(platformSettings).set({ twoFactorRequiredForManagers: false }).where(eq(platformSettings.id, 'default')).run();

type Api = ReturnType<typeof request>;
const api: Api = request(app);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

interface Session {
  token: string;
  orgId: string;
  userId: string;
}

async function register(name: string, extra: Record<string, unknown> = {}): Promise<Session> {
  const res = await api.post('/api/v1/auth/register').send({
    organisation: { name, postcode: 'M20 2RN', lat: 53.4186, lng: -2.2311, ...extra },
    admin: { email: `${name.toLowerCase().replace(/\s+/g, '')}@example.com`, password: 'password123', firstName: 'Admin', lastName: name },
  });
  expect(res.status).toBe(201);
  expect(res.body.organisation.status).toBe('PENDING');
  const approved = await api.patch(`/api/v1/organisations/${res.body.organisation.id}`).set(auth(agency.token)).send({ status: 'ACTIVE' });
  expect(approved.status).toBe(200);
  return { token: res.body.token, orgId: res.body.organisation.id, userId: res.body.user.id };
}

async function addWorker(s: Session, firstName: string, jobRole: JobRole, opts: { compliant?: boolean; skills?: string[]; shareable?: boolean } = {}) {
  const res = await api.post('/api/v1/workers').set(auth(s.token)).send({ firstName, lastName: 'Worker', jobRole, skills: opts.skills ?? ['MOVING_AND_HANDLING', 'DEMENTIA'], shareable: opts.shareable ?? true, lat: 53.41, lng: -2.16, travelRadiusKm: 30 });
  expect(res.status).toBe(201);
  const worker = res.body;
  if (opts.compliant !== false) {
    for (const type of requiredDocumentsForRole(jobRole)) {
      const doc = await api.post(`/api/v1/workers/${worker.id}/documents`).set(auth(s.token)).send({ type, expiresAt: addDays(clock, 400).toISOString() });
      expect(doc.status).toBe(201);
      const verified = await api.patch(`/api/v1/workers/${worker.id}/documents/${doc.body.id}`).set(auth(s.token)).send({ verified: true });
      expect(verified.status).toBe(200);
    }
  }
  return worker as { id: string; orgId: string };
}

let agency: Session;
let oakwood: Session; // host
let riverside: Session; // surplus-flagged supplier
let pennine: Session; // plain network supplier
let oakSite: { id: string };
let rivWorker: { id: string };
let rivNonCompliant: { id: string };
let penWorker: { id: string };
let agencyWorker: { id: string };

beforeAll(async () => {
  const boot = await api.post('/api/v1/auth/bootstrap').send({
    organisation: { name: 'Merge Staffing', postcode: 'M1 4BT', lat: 53.4794, lng: -2.2453 },
    admin: { email: 'admin@merge.local', password: 'password123', firstName: 'Priya', lastName: 'Shah' },
  });
  expect(boot.status).toBe(201);
  agency = { token: boot.body.token, orgId: boot.body.organisation.id, userId: boot.body.user.id };
  expect((await api.post('/api/v1/auth/bootstrap').send({ organisation: { name: 'Second Agency' }, admin: { email: 'second@agency.co', password: 'password123', firstName: 'a', lastName: 'b' } })).status).toBe(409);

  oakwood = await register('Oakwood Care');
  riverside = await register('Riverside Living', { postcode: 'SK4 1AB', lat: 53.4106, lng: -2.1575, workerSelfServiceAllowed: true });
  pennine = await register('Pennine Nursing', { postcode: 'OL1 3DF', lat: 53.5409, lng: -2.1114 });

  const site = await api.post(`/api/v1/organisations/${oakwood.orgId}/sites`).set(auth(oakwood.token)).send({ name: 'Oakwood Manor', postcode: 'M20 2RN', lat: 53.4186, lng: -2.2311, accessNotes: 'Sign in at reception' });
  expect(site.status).toBe(201);
  oakSite = site.body;

  rivWorker = await addWorker(riverside, 'Aisha', 'CARE_ASSISTANT');
  rivNonCompliant = await addWorker(riverside, 'George', 'CARE_ASSISTANT', { compliant: false });
  penWorker = await addWorker(pennine, 'Sophie', 'CARE_ASSISTANT');
  agencyWorker = await addWorker(agency, 'Dan', 'CARE_ASSISTANT');
});

describe('capacity flags and staged dispatch', () => {
  let shiftId: string;

  it('lets a provider raise a surplus flag', async () => {
    const res = await api.post('/api/v1/capacity/flags').set(auth(riverside.token)).send({ kind: 'SURPLUS', jobRole: 'CARE_ASSISTANT', headcount: 2, hoursRequested: 40, startsAt: clock.toISOString(), endsAt: addDays(clock, 14).toISOString(), postcodeAreas: ['M', 'SK'] });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.hoursRemaining).toBe(40);

    const network = await api.get('/api/v1/capacity/network').set(auth(pennine.token));
    expect(network.status).toBe(200);
    expect(network.body.summary).toEqual([{ jobRole: 'CARE_ASSISTANT', surplusHoursRemaining: 40, surplusOrgs: 1, shortageHoursRemaining: 0, shortageOrgs: 0 }]);
    expect(network.body.flags).toBeUndefined(); // providers do not see who flagged

    const adminView = await api.get('/api/v1/capacity/network').set(auth(agency.token));
    expect(adminView.body.flags).toHaveLength(1);
    expect(adminView.body.flags[0].orgName).toBe('Riverside Living');
  });

  it('publishes a shift with the flagged org first, agency second, network last', async () => {
    const res = await api.post('/api/v1/shifts').set(auth(oakwood.token)).send({
      siteId: oakSite.id,
      jobRole: 'CARE_ASSISTANT',
      title: 'Day shift – Maple unit',
      startsAt: addHours(clock, 72).toISOString(),
      endsAt: addHours(clock, 80).toISOString(),
      breakMinutes: 30,
      headcount: 2,
      requiredSkills: ['MOVING_AND_HANDLING', 'DEMENTIA'],
      chargeRate: 18,
      publish: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('OPEN');
    expect(res.body.urgent).toBe(false);
    expect(res.body.paidHours).toBe(7.5);
    shiftId = res.body.id;

    const plan = Object.fromEntries(res.body.plan.map((p: { orgId: string; tier: string; opensAt: string }) => [p.orgId, p]));
    expect(plan[riverside.orgId].tier).toBe('PRIORITY');
    expect(new Date(plan[riverside.orgId].opensAt)).toEqual(clock);
    expect(plan[agency.orgId].tier).toBe('AGENCY');
    expect(new Date(plan[agency.orgId].opensAt)).toEqual(addMinutes(clock, 120));
    expect(plan[pennine.orgId].tier).toBe('NETWORK');
    expect(new Date(plan[pennine.orgId].opensAt)).toEqual(addMinutes(clock, 180));
    expect(plan[oakwood.orgId]).toBeUndefined();
  });

  it('shows the shift to everyone with an access time, but only lets open tiers act', async () => {
    const riv = await api.get('/api/v1/shifts?scope=available').set(auth(riverside.token));
    expect(riv.body).toHaveLength(1);
    expect(riv.body[0].access).toMatchObject({ tier: 'PRIORITY', open: true });

    const pen = await api.get('/api/v1/shifts?scope=available').set(auth(pennine.token));
    expect(pen.body[0].access).toMatchObject({ tier: 'NETWORK', open: false });

    const tooEarly = await api.post(`/api/v1/shifts/${shiftId}/requests`).set(auth(pennine.token)).send({ workerId: penWorker.id });
    expect(tooEarly.status).toBe(422);
    expect(tooEarly.body.details.blockers.map((b: { code: string }) => b.code)).toEqual(['ACCESS_NOT_OPEN']);

    const notified = await api.get('/api/v1/notifications').set(auth(riverside.token));
    expect(notified.body.notifications.some((n: { type: string; data: { tier: string } }) => n.type === 'SHIFT_AVAILABLE' && n.data.tier === 'PRIORITY')).toBe(true);
    const penNotified = await api.get('/api/v1/notifications').set(auth(pennine.token));
    expect(penNotified.body.notifications.filter((n: { type: string }) => n.type === 'SHIFT_AVAILABLE')).toHaveLength(0);
  });

  it('refuses non-compliant workers and explains why', async () => {
    const res = await api.post(`/api/v1/shifts/${shiftId}/requests`).set(auth(riverside.token)).send({ workerId: rivNonCompliant.id });
    expect(res.status).toBe(422);
    expect(res.body.details.blockers.map((b: { code: string }) => b.code)).toEqual(['NON_COMPLIANT']);

    const eligible = await api.get(`/api/v1/shifts/${shiftId}/eligible-workers`).set(auth(riverside.token));
    expect(eligible.status).toBe(200);
    const byName = Object.fromEntries(eligible.body.workers.map((w: { firstName: string; eligible: boolean }) => [w.firstName, w.eligible]));
    expect(byName).toEqual({ Aisha: true, George: false });
  });

  it('lets the priority org request and the host confirm, consuming flag hours', async () => {
    const req = await api.post(`/api/v1/shifts/${shiftId}/requests`).set(auth(riverside.token)).send({ workerId: rivWorker.id });
    expect(req.status).toBe(201);
    expect(req.body.assignment.status).toBe('REQUESTED');
    expect(req.body.assignment.tierAtRequest).toBe('PRIORITY');

    const dup = await api.post(`/api/v1/shifts/${shiftId}/requests`).set(auth(riverside.token)).send({ workerId: rivWorker.id });
    expect(dup.status).toBe(409);

    const hostInbox = await api.get('/api/v1/notifications?unread=true').set(auth(oakwood.token));
    expect(hostInbox.body.notifications.some((n: { type: string }) => n.type === 'SHIFT_REQUEST')).toBe(true);

    const confirm = await api.post(`/api/v1/assignments/${req.body.assignment.id}/confirm`).set(auth(oakwood.token));
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe('CONFIRMED');

    const shift = await api.get(`/api/v1/shifts/${shiftId}`).set(auth(oakwood.token));
    expect(shift.body.filledCount).toBe(1);
    expect(shift.body.status).toBe('OPEN');
    expect(shift.body.assignments[0].worker.firstName).toBe('Aisha');

    const flags = await api.get('/api/v1/capacity/flags').set(auth(riverside.token));
    expect(flags.body[0].hoursFilled).toBe(7.5);
    expect(flags.body[0].hoursRemaining).toBe(32.5);

    const timesheets = await api.get('/api/v1/timesheets?scope=receivable').set(auth(riverside.token));
    expect(timesheets.body).toHaveLength(1);
    expect(timesheets.body[0].status).toBe('DRAFT');
  });

  it('opens the network tier when its window passes and notifies it', async () => {
    clock = addMinutes(T0, 181);
    const tick = await api.post('/api/v1/admin/scheduler/tick').set(auth(agency.token));
    expect(tick.status).toBe(200);
    expect(tick.body.stagesOpened).toBe(2); // agency + pennine

    const pen = await api.get('/api/v1/shifts?scope=available').set(auth(pennine.token));
    expect(pen.body[0].access.open).toBe(true);
    const penInbox = await api.get('/api/v1/notifications').set(auth(pennine.token));
    expect(penInbox.body.notifications.some((n: { type: string; data: { tier: string } }) => n.type === 'SHIFT_AVAILABLE' && n.data.tier === 'NETWORK')).toBe(true);

    const req = await api.post(`/api/v1/shifts/${shiftId}/requests`).set(auth(pennine.token)).send({ workerId: penWorker.id });
    expect(req.status).toBe(201);
    expect(req.body.assignment.tierAtRequest).toBe('NETWORK');

    // The host can also pull candidates directly now that two suppliers have access.
    const candidates = await api.get(`/api/v1/shifts/${shiftId}/candidates`).set(auth(oakwood.token));
    expect(candidates.status).toBe(200);
    expect(candidates.body.map((c: { firstName: string }) => c.firstName).sort()).toEqual(['Dan']); // Aisha and Sophie already have live assignments

    const confirm = await api.post(`/api/v1/assignments/${req.body.assignment.id}/confirm`).set(auth(oakwood.token));
    expect(confirm.body.status).toBe('CONFIRMED');
    const shift = await api.get(`/api/v1/shifts/${shiftId}`).set(auth(oakwood.token));
    expect(shift.body.status).toBe('FILLED');
    expect(shift.body.filledCount).toBe(2);
  });

  it('handles a late cancellation by the supplier and reopens the shift', async () => {
    clock = addHours(T0, 60); // 12h before start → late
    const supplied = await api.get('/api/v1/shifts?scope=supplied').set(auth(pennine.token));
    const assignmentId = supplied.body[0].assignment.id;
    const cancel = await api.post(`/api/v1/assignments/${assignmentId}/cancel`).set(auth(pennine.token)).send({ reason: 'Sickness' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('CANCELLED');
    expect(cancel.body.lateCancellation).toBe(true);

    const shift = await api.get(`/api/v1/shifts/${shiftId}`).set(auth(oakwood.token));
    expect(shift.body.status).toBe('OPEN');
    expect(shift.body.filledCount).toBe(1);

    const stats = await api.get(`/api/v1/organisations/${pennine.orgId}/stats`).set(auth(pennine.token));
    expect(stats.body.lateCancellations).toBe(1);
  });

  it('runs the shift, timesheet and settlement flow', async () => {
    clock = addHours(T0, 73); // shift in progress
    const tick = await api.post('/api/v1/admin/scheduler/tick').set(auth(agency.token));
    expect(tick.body.shifts.started).toBe(1);

    const ts = (await api.get('/api/v1/timesheets?scope=receivable').set(auth(riverside.token))).body[0];
    const clockIn = await api.post(`/api/v1/timesheets/${ts.id}/clock-in`).set(auth(riverside.token)).send({ at: addHours(T0, 72).toISOString() });
    expect(clockIn.status).toBe(200);
    clock = addHours(T0, 80.5);
    const clockOut = await api.post(`/api/v1/timesheets/${ts.id}/clock-out`).set(auth(riverside.token)).send({ at: addHours(T0, 80).toISOString(), breakMinutes: 30 });
    expect(clockOut.status).toBe(200);
    expect(clockOut.body).toMatchObject({ status: 'SUBMITTED', paidHours: 7.5, hostCost: 135, platformFee: 10.8, supplierAmount: 124.2 });

    const dispute = await api.post(`/api/v1/timesheets/${ts.id}/dispute`).set(auth(oakwood.token)).send({ reason: 'Left 30 minutes early' });
    expect(dispute.body.status).toBe('DISPUTED');
    const resubmit = await api.post(`/api/v1/timesheets/${ts.id}/submit`).set(auth(riverside.token)).send({ clockInAt: addHours(T0, 72).toISOString(), clockOutAt: addHours(T0, 79.5).toISOString(), breakMinutes: 30 });
    expect(resubmit.body).toMatchObject({ status: 'SUBMITTED', paidHours: 7 });
    const approve = await api.post(`/api/v1/timesheets/${ts.id}/approve`).set(auth(oakwood.token));
    expect(approve.body.status).toBe('APPROVED');

    const assignment = await api.get(`/api/v1/assignments/${ts.assignmentId}`).set(auth(oakwood.token));
    expect(assignment.body.status).toBe('COMPLETED');

    const rating = await api.post(`/api/v1/assignments/${ts.assignmentId}/rating`).set(auth(oakwood.token)).send({ score: 5, comment: 'Great with residents' });
    expect(rating.status).toBe(201);

    const invoices = await api.post('/api/v1/invoices/generate').set(auth(agency.token)).send({ periodStart: T0.toISOString(), periodEnd: addDays(T0, 7).toISOString() });
    expect(invoices.status).toBe(201);
    expect(invoices.body).toHaveLength(1);
    expect(invoices.body[0]).toMatchObject({ hostOrgId: oakwood.orgId, supplierOrgId: riverside.orgId, totalHours: 7, subtotal: 126, platformFee: 10.08, supplierAmount: 115.92, status: 'ISSUED' });

    const payable = await api.get('/api/v1/invoices?scope=payable').set(auth(oakwood.token));
    expect(payable.body).toHaveLength(1);
    const detail = await api.get(`/api/v1/invoices/${payable.body[0].id}`).set(auth(oakwood.token));
    expect(detail.body.lines).toHaveLength(1);
    expect((await api.get(`/api/v1/invoices/${payable.body[0].id}`).set(auth(pennine.token))).status).toBe(403);
  });
});

describe('other dispatch behaviours', () => {
  it('collapses windows for urgent shifts and lets the agency bank auto-book', async () => {
    const res = await api.post('/api/v1/shifts').set(auth(oakwood.token)).send({
      siteId: oakSite.id,
      jobRole: 'CARE_ASSISTANT',
      title: 'Urgent cover',
      startsAt: addHours(clock, 4).toISOString(),
      endsAt: addHours(clock, 12).toISOString(),
      chargeRate: 22,
      autoConfirm: true,
      publish: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.urgent).toBe(true);
    expect(res.body.plan.every((p: { opensAt: string }) => new Date(p.opensAt).getTime() === clock.getTime())).toBe(true);

    const booked = await api.post(`/api/v1/shifts/${res.body.id}/requests`).set(auth(agency.token)).send({ workerId: agencyWorker.id });
    expect(booked.status).toBe(201);
    expect(booked.body.assignment.status).toBe('CONFIRMED');
    expect(booked.body.shift.status).toBe('FILLED');
  });

  it('promotes an organisation onto already-open shifts when it raises a surplus flag', async () => {
    const shift = await api.post('/api/v1/shifts').set(auth(oakwood.token)).send({ siteId: oakSite.id, jobRole: 'CARE_ASSISTANT', title: 'Next week', startsAt: addDays(clock, 5).toISOString(), endsAt: addHours(addDays(clock, 5), 8).toISOString(), chargeRate: 18, publish: true });
    const before = await api.get(`/api/v1/shifts/${shift.body.id}`).set(auth(pennine.token));
    expect(before.body.access).toMatchObject({ tier: 'NETWORK', open: false });

    const flag = await api.post('/api/v1/capacity/flags').set(auth(pennine.token)).send({ kind: 'SURPLUS', hoursRequested: 20, startsAt: clock.toISOString(), endsAt: addDays(clock, 7).toISOString() });
    expect(flag.status).toBe(201);
    const after = await api.get(`/api/v1/shifts/${shift.body.id}`).set(auth(pennine.token));
    expect(after.body.access).toMatchObject({ tier: 'PRIORITY', open: true });
  });

  it('respects blocklists and restricted visibility', async () => {
    const block = await api.put(`/api/v1/organisations/${oakwood.orgId}/relationships/${pennine.orgId}`).set(auth(oakwood.token)).send({ kind: 'BLOCKED', note: 'Repeated late cancellations' });
    expect(block.status).toBe(200);
    const shift = await api.post('/api/v1/shifts').set(auth(oakwood.token)).send({ siteId: oakSite.id, jobRole: 'CARE_ASSISTANT', title: 'Agency only', startsAt: addDays(clock, 6).toISOString(), endsAt: addHours(addDays(clock, 6), 8).toISOString(), chargeRate: 18, visibility: 'AGENCY_ONLY', publish: true });
    expect(shift.body.plan.map((p: { orgId: string }) => p.orgId)).toEqual([agency.orgId]);
    expect((await api.get(`/api/v1/shifts/${shift.body.id}`).set(auth(pennine.token))).status).toBe(403);

    const preview = await api.post('/api/v1/shifts').set(auth(oakwood.token)).send({ siteId: oakSite.id, jobRole: 'CARE_ASSISTANT', title: 'Draft', startsAt: addDays(clock, 6).toISOString(), endsAt: addHours(addDays(clock, 6), 8).toISOString(), chargeRate: 18 });
    const plan = await api.get(`/api/v1/shifts/${preview.body.id}/dispatch-preview`).set(auth(oakwood.token));
    expect(plan.body.persisted).toBe(false);
    expect(plan.body.excluded.map((e: { orgId: string }) => e.orgId)).toContain(pennine.orgId);
    await api.delete(`/api/v1/organisations/${oakwood.orgId}/relationships/${pennine.orgId}`).set(auth(oakwood.token));
  });

  it('lets a worker with self-service pick a shift for themselves only', async () => {
    const login = await api.post(`/api/v1/workers/${rivWorker.id}/login`).set(auth(riverside.token)).send({ email: 'aisha@riverside.local', password: 'password123' });
    expect(login.status).toBe(201);
    const session = await api.post('/api/v1/auth/login').send({ email: 'aisha@riverside.local', password: 'password123' });
    expect(session.status).toBe(200);
    const token = session.body.token as string;

    const available = await api.get('/api/v1/shifts?scope=available').set(auth(token));
    expect(available.status).toBe(200);
    const open = available.body.find((s: { title: string }) => s.title === 'Next week');
    expect(open).toBeDefined();

    const forSomeoneElse = await api.post(`/api/v1/shifts/${open.id}/requests`).set(auth(token)).send({ workerId: rivNonCompliant.id });
    expect(forSomeoneElse.status).toBe(403);
    const self = await api.post(`/api/v1/shifts/${open.id}/requests`).set(auth(token)).send({});
    expect(self.status).toBe(201);
    expect(self.body.assignment.workerId).toBe(rivWorker.id);

    expect((await api.get('/api/v1/workers').set(auth(token))).status).toBe(403);
  });

  it('keeps organisations out of each other\'s private data', async () => {
    expect((await api.get(`/api/v1/workers/${rivWorker.id}`).set(auth(oakwood.token))).status).toBe(403);
    expect((await api.get(`/api/v1/organisations/${riverside.orgId}/users`).set(auth(oakwood.token))).status).toBe(403);
    expect((await api.get('/api/v1/admin/settings').set(auth(oakwood.token))).status).toBe(403);
    expect((await api.get(`/api/v1/capacity/flags?orgId=${riverside.orgId}`).set(auth(oakwood.token))).status).toBe(403);
    const admin = await api.patch('/api/v1/admin/settings').set(auth(agency.token)).send({ agencyPosition: 'FIRST', priorityWindowMinutes: 90 });
    expect(admin.status).toBe(200);
    expect(admin.body).toMatchObject({ agencyPosition: 'FIRST', priorityWindowMinutes: 90 });
    const overview = await api.get('/api/v1/admin/overview').set(auth(agency.token));
    expect(overview.status).toBe(200);
    expect(overview.body.organisations.total).toBe(4);
  });
});

describe('live flag state in access reasons', () => {
  it('reflects hours consumed since publication', async () => {
    // "Next week" was published when Riverside's flag had 32.5h left; Aisha then requested it.
    const posted = await api.get('/api/v1/shifts?scope=posted').set(auth(oakwood.token));
    const next = posted.body.find((s: { title: string }) => s.title === 'Next week');
    const before = await api.get(`/api/v1/shifts/${next.id}`).set(auth(oakwood.token));
    const pending = before.body.assignments.find((a: { status: string }) => a.status === 'REQUESTED');
    expect(before.body.plan.find((p: { orgId: string }) => p.orgId === riverside.orgId).reason).toBe('Surplus flag: 32.5h of 40h remaining, care assistant');

    const confirm = await api.post(`/api/v1/assignments/${pending.id}/confirm`).set(auth(oakwood.token));
    expect(confirm.status).toBe(200);

    const flags = await api.get('/api/v1/capacity/flags').set(auth(riverside.token));
    const rivFlag = flags.body.find((f: { kind: string; jobRole: string }) => f.kind === 'SURPLUS' && f.jobRole === 'CARE_ASSISTANT');
    expect(rivFlag.hoursRemaining).toBe(24.5);
    const after = await api.get(`/api/v1/shifts/${next.id}`).set(auth(oakwood.token));
    expect(after.body.plan.find((p: { orgId: string }) => p.orgId === riverside.orgId).reason).toBe('Surplus flag: 24.5h of 40h remaining, care assistant');
  });
});

describe('review regressions', () => {
  it('does not list another organisation\'s sites', async () => {
    expect((await api.get(`/api/v1/organisations/${oakwood.orgId}/sites`).set(auth(pennine.token))).status).toBe(403);
    expect((await api.get(`/api/v1/organisations/${oakwood.orgId}/sites`).set(auth(oakwood.token))).status).toBe(200);
    expect((await api.get(`/api/v1/organisations/${oakwood.orgId}/sites`).set(auth(agency.token))).status).toBe(200);
  });

  it('refuses to bind a login to another organisation\'s worker', async () => {
    const res = await api.post(`/api/v1/organisations/${oakwood.orgId}/users`).set(auth(oakwood.token)).send({ email: 'sneaky@oakwood.example', password: 'password123', firstName: 'S', lastName: 'Neaky', role: 'ORG_MANAGER', workerId: rivWorker.id });
    expect(res.status).toBe(404);
    const own = await api.post(`/api/v1/organisations/${riverside.orgId}/users`).set(auth(riverside.token)).send({ email: 'george@riverside.example', password: 'password123', firstName: 'George', lastName: 'Worker', role: 'WORKER', workerId: rivNonCompliant.id });
    expect(own.status).toBe(201);
    const w = await api.get(`/api/v1/workers/${rivNonCompliant.id}`).set(auth(riverside.token));
    expect(w.body.login.id).toBe(own.body.id);
  });

  it('keeps a worker login out of colleagues\' timesheets and assignments', async () => {
    const session = await api.post('/api/v1/auth/login').send({ email: 'george@riverside.example', password: 'password123' });
    const token = session.body.token as string;
    const list = await api.get('/api/v1/timesheets').set(auth(token));
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]); // George has no bookings; Aisha's timesheets stay hidden
    const aishaTs = (await api.get('/api/v1/timesheets?scope=receivable').set(auth(riverside.token))).body[0];
    expect((await api.get(`/api/v1/timesheets/${aishaTs.id}`).set(auth(token))).status).toBe(403);
    expect((await api.post(`/api/v1/timesheets/${aishaTs.id}/submit`).set(auth(token)).send({ clockInAt: T0.toISOString(), clockOutAt: addHours(T0, 12).toISOString(), breakMinutes: 0 })).status).toBe(403);
    expect((await api.get(`/api/v1/assignments/${aishaTs.assignmentId}`).set(auth(token))).status).toBe(403);
  });

  it('parses query booleans literally', async () => {
    const first = (await api.get('/api/v1/notifications').set(auth(oakwood.token))).body.notifications[0];
    expect((await api.post(`/api/v1/notifications/${first.id}/read`).set(auth(oakwood.token))).status).toBe(200);
    const all = await api.get('/api/v1/notifications?unread=false').set(auth(oakwood.token));
    const unreadOnly = await api.get('/api/v1/notifications?unread=true').set(auth(oakwood.token));
    expect(all.body.notifications.length).toBeGreaterThan(unreadOnly.body.notifications.length);
    expect(all.body.notifications.some((n: { id: string }) => n.id === first.id)).toBe(true);
    expect(unreadOnly.body.notifications.some((n: { id: string }) => n.id === first.id)).toBe(false);
    const upcoming = await api.get('/api/v1/shifts?scope=posted&includePast=false').set(auth(oakwood.token));
    const everything = await api.get('/api/v1/shifts?scope=posted&includePast=true').set(auth(oakwood.token));
    expect(upcoming.body.length).toBeLessThan(everything.body.length);
  });

  it('rejects a submitted timesheet when the booking is cancelled, so it can never be approved or invoiced', async () => {
    const res = await api.post('/api/v1/shifts').set(auth(oakwood.token)).send({ siteId: oakSite.id, jobRole: 'CARE_ASSISTANT', title: 'Cancel after submit', startsAt: addDays(clock, 8).toISOString(), endsAt: addHours(addDays(clock, 8), 8).toISOString(), chargeRate: 18, autoConfirm: true, priorityWindowMinutesOverride: 0, publish: true });
    // The agency now goes FIRST (changed by an earlier test); a zero priority window releases every tier at once anyway.
    expect(res.body.plan.every((p: { opensAt: string }) => new Date(p.opensAt).getTime() === clock.getTime())).toBe(true);
    const booked = await api.post(`/api/v1/shifts/${res.body.id}/requests`).set(auth(riverside.token)).send({ workerId: rivWorker.id });
    expect(booked.status).toBe(201);
    expect(booked.body.assignment.status).toBe('CONFIRMED');
    const ts = (await api.get('/api/v1/timesheets?scope=receivable&status=DRAFT').set(auth(riverside.token))).body.find((t: { assignmentId: string }) => t.assignmentId === booked.body.assignment.id);
    const submitted = await api.post(`/api/v1/timesheets/${ts.id}/submit`).set(auth(riverside.token)).send({ clockInAt: addDays(clock, 8).toISOString(), clockOutAt: addHours(addDays(clock, 8), 8).toISOString(), breakMinutes: 0 });
    expect(submitted.body.status).toBe('SUBMITTED');
    // Host cannot record times itself
    expect((await api.post(`/api/v1/timesheets/${ts.id}/clock-in`).set(auth(oakwood.token)).send({})).status).toBe(403);
    const cancel = await api.post(`/api/v1/assignments/${booked.body.assignment.id}/cancel`).set(auth(riverside.token)).send({ reason: 'Sick' });
    expect(cancel.status).toBe(200);
    const after = await api.get(`/api/v1/timesheets/${ts.id}`).set(auth(oakwood.token));
    expect(after.body.status).toBe('REJECTED');
    expect((await api.post(`/api/v1/timesheets/${ts.id}/approve`).set(auth(oakwood.token))).status).toBe(409);
    const assignment = await api.get(`/api/v1/assignments/${booked.body.assignment.id}`).set(auth(oakwood.token));
    expect(assignment.body.status).toBe('CANCELLED');
  });

  it('closes pending requests when a shift starts and blocks break edits after confirmations', async () => {
    const res = await api.post('/api/v1/shifts').set(auth(oakwood.token)).send({ siteId: oakSite.id, jobRole: 'CARE_ASSISTANT', title: 'Starts soon', startsAt: addHours(clock, 2).toISOString(), endsAt: addHours(clock, 10).toISOString(), breakMinutes: 30, headcount: 2, chargeRate: 18, publish: true });
    expect(res.body.urgent).toBe(true);
    const a = await api.post(`/api/v1/shifts/${res.body.id}/requests`).set(auth(riverside.token)).send({ workerId: rivWorker.id });
    expect(a.status).toBe(201);
    const confirm = await api.post(`/api/v1/assignments/${a.body.assignment.id}/confirm`).set(auth(oakwood.token));
    expect(confirm.body.status).toBe('CONFIRMED');
    expect((await api.patch(`/api/v1/shifts/${res.body.id}`).set(auth(oakwood.token)).send({ breakMinutes: 60 })).status).toBe(409);
    const b = await api.post(`/api/v1/shifts/${res.body.id}/requests`).set(auth(pennine.token)).send({ workerId: penWorker.id });
    expect(b.status).toBe(201);
    expect(b.body.assignment.status).toBe('REQUESTED');
    clock = addHours(clock, 2.1);
    await api.post('/api/v1/admin/scheduler/tick').set(auth(agency.token));
    const shift = await api.get(`/api/v1/shifts/${res.body.id}`).set(auth(oakwood.token));
    expect(shift.body.status).toBe('IN_PROGRESS');
    const pennineRow = shift.body.assignments.find((x: { id: string }) => x.id === b.body.assignment.id);
    expect(pennineRow.status).toBe('DECLINED');
    const penInbox = await api.get('/api/v1/notifications').set(auth(pennine.token));
    expect(penInbox.body.notifications.some((n: { type: string; data: { assignmentId: string } }) => n.type === 'SHIFT_DECLINED' && n.data.assignmentId === b.body.assignment.id)).toBe(true);
  });

  it('gives the platform admin oversight without pretending it is the host', async () => {
    const posted = await api.get('/api/v1/shifts?scope=all').set(auth(agency.token));
    const open = posted.body.find((s: { status: string; hostOrgId: string }) => s.status === 'OPEN' && s.hostOrgId === oakwood.orgId);
    const detail = await api.get(`/api/v1/shifts/${open.id}`).set(auth(agency.token));
    expect(detail.body.isHost).toBe(false);
    expect(detail.body.canManage).toBe(true);
    expect(detail.body.plan).toBeDefined();
    expect(detail.body.access).toBeDefined();
    const asGuest = await api.get(`/api/v1/shifts?scope=available`).set(auth(riverside.token));
    expect(asGuest.body.every((s: Record<string, unknown>) => !('createdByUserId' in s))).toBe(true);
  });
});

describe('walkthrough regressions', () => {
  it('ends a worker login when the worker is deactivated, and keeps colleagues\' records private', async () => {
    const colleague = await addWorker(riverside, 'Nadia', 'CARE_ASSISTANT');
    const login = await api.post(`/api/v1/workers/${colleague.id}/login`).set(auth(riverside.token)).send({ email: 'nadia@riverside.local', password: 'password123' });
    expect(login.status).toBe(201);
    const token = (await api.post('/api/v1/auth/login').send({ email: 'nadia@riverside.local', password: 'password123' })).body.token as string;
    expect((await api.get(`/api/v1/workers/${colleague.id}`).set(auth(token))).status).toBe(200);
    expect((await api.get(`/api/v1/workers/${rivWorker.id}`).set(auth(token))).status).toBe(403);
    expect((await api.post(`/api/v1/workers/${rivWorker.id}/unavailability`).set(auth(token)).send({ startsAt: clock.toISOString(), endsAt: addDays(clock, 1).toISOString() })).status).toBe(403);
    expect((await api.patch(`/api/v1/workers/${colleague.id}`).set(auth(riverside.token)).send({ status: 'INACTIVE' })).status).toBe(200);
    expect((await api.get('/api/v1/auth/me').set(auth(token))).status).toBe(401);
    expect((await api.post('/api/v1/auth/login').send({ email: 'nadia@riverside.local', password: 'password123' })).status).toBe(401);
  });

  it('keeps door codes private until a booking is confirmed and hides the charge rate from workers', async () => {
    const res = await api.post('/api/v1/shifts').set(auth(oakwood.token)).send({ siteId: oakSite.id, jobRole: 'CARE_ASSISTANT', title: 'Door code test', startsAt: addDays(clock, 9).toISOString(), endsAt: addHours(addDays(clock, 9), 8).toISOString(), chargeRate: 18, priorityWindowMinutesOverride: 0, publish: true });
    expect(res.status).toBe(201);
    const before = await api.get(`/api/v1/shifts/${res.body.id}`).set(auth(riverside.token));
    expect(before.body.site.accessNotes).toBeNull();
    const list = await api.get('/api/v1/shifts?scope=available').set(auth(riverside.token));
    expect(list.body.find((s: { id: string }) => s.id === res.body.id).site.accessNotes).toBeNull();
    const req = await api.post(`/api/v1/shifts/${res.body.id}/requests`).set(auth(riverside.token)).send({ workerId: rivWorker.id });
    expect(req.status).toBe(201);
    await api.post(`/api/v1/assignments/${req.body.assignment.id}/confirm`).set(auth(oakwood.token));
    const after = await api.get(`/api/v1/shifts/${res.body.id}`).set(auth(riverside.token));
    expect(after.body.site.accessNotes).toBe('Sign in at reception');
    const aisha = (await api.post('/api/v1/auth/login').send({ email: 'aisha@riverside.local', password: 'password123' })).body.token as string;
    const asWorker = await api.get(`/api/v1/shifts/${res.body.id}`).set(auth(aisha));
    expect(asWorker.status).toBe(200);
    expect(asWorker.body.chargeRate).toBeNull();
  });

  it('bills late-approved timesheets on the next statement run', async () => {
    // The June statement already ran; a timesheet for a May-period shift approved afterwards must not be lost.
    const pending = (await api.get('/api/v1/timesheets?scope=payable&status=SUBMITTED').set(auth(oakwood.token))).body as Array<{ id: string }>;
    const before = (await api.get('/api/v1/invoices?scope=all').set(auth(agency.token))).body.length;
    const gen = await api.post('/api/v1/invoices/generate').set(auth(agency.token)).send({ periodStart: addDays(T0, 60).toISOString(), periodEnd: addDays(T0, 90).toISOString() });
    expect(gen.status).toBe(201);
    // Nothing newly approved → nothing issued; now approve one old timesheet (if any) and run again.
    void pending;
    const all = (await api.get('/api/v1/timesheets?scope=all').set(auth(agency.token))).body as Array<{ id: string; status: string; hostOrgId: string }>;
    const approvedUnbilled = all.filter((t) => t.status === 'APPROVED');
    const after = (await api.get('/api/v1/invoices?scope=all').set(auth(agency.token))).body.length;
    expect(after).toBeGreaterThanOrEqual(before);
    // Direct check of the rule: every APPROVED timesheet whose shift started before periodEnd now carries an invoice id.
    const detailed = await Promise.all(approvedUnbilled.map((t) => api.get(`/api/v1/timesheets/${t.id}`).set(auth(agency.token))));
    for (const d of detailed) if (new Date(d.body.shift.startsAt) < addDays(T0, 90)) expect(d.body.invoiceId).not.toBeNull();
  });

  it('refuses publishing by an organisation awaiting approval and rejects empty updates', async () => {
    const reg = await api.post('/api/v1/auth/register').send({ organisation: { name: 'Newcomer Care', postcode: 'M1 1AA' }, admin: { email: 'new@newcomer.example', password: 'password123', firstName: 'N', lastName: 'C' } });
    expect(reg.body.organisation.status).toBe('PENDING');
    const site = await api.post(`/api/v1/organisations/${reg.body.organisation.id}/sites`).set(auth(reg.body.token)).send({ name: 'Newcomer House', postcode: 'M1 1AA' });
    const shift = await api.post('/api/v1/shifts').set(auth(reg.body.token)).send({ siteId: site.body.id, jobRole: 'CARE_ASSISTANT', title: 'Pending org shift', startsAt: addDays(clock, 3).toISOString(), endsAt: addHours(addDays(clock, 3), 8).toISOString(), chargeRate: 18, publish: true });
    expect(shift.status).toBe(403);
    expect((await api.get('/api/v1/shifts?scope=available').set(auth(reg.body.token))).body).toEqual([]);
    expect((await api.patch(`/api/v1/organisations/${oakwood.orgId}/sites/${oakSite.id}`).set(auth(oakwood.token)).send({ nonsense: true })).status).toBe(400);
  });
});
