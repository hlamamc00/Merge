/**
 * Phase 1b platform fixes: confirm-time eligibility re-check, worker-facing document expiry alerts,
 * surplus-flag expiry nudges (DSP-03) and the side effects of suspending an organisation (PLT-01).
 */
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { addDays, addHours, requiredDocumentsForRole, type DocumentType, type JobRole } from '@merge/shared';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations } from '../src/db/client.js';
import { auditLog, capacityFlags, platformSettings, shifts } from '../src/db/schema.js';

const T0 = new Date('2026-11-02T08:00:00Z'); // a Monday; London is on GMT in November
const clock = T0;
const { db } = openDatabase(':memory:');
runMigrations(db);
const { app } = createApp({ db, now: () => clock, channels: [] });
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
  userId: string | null;
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

async function addSite(s: Session, name: string): Promise<{ id: string }> {
  const res = await api.post(`/api/v1/organisations/${s.orgId}/sites`).set(auth(s.token)).send({ name, postcode: 'M20 2RN', lat: 53.4186, lng: -2.2311 });
  expect(res.status).toBe(201);
  return res.body;
}

/** A verified, shareable care assistant; `expiry` overrides the expiry date of named document types. */
async function addWorker(s: Session, firstName: string, extra: Record<string, unknown> = {}, expiry: Partial<Record<DocumentType, Date>> = {}, jobRole: JobRole = 'CARE_ASSISTANT') {
  const res = await api.post('/api/v1/workers').set(auth(s.token)).send({ firstName, lastName: 'Worker', jobRole, skills: ['MOVING_AND_HANDLING', 'DEMENTIA'], shareable: true, contractedHoursPerWeek: 0, maxHoursPerWeek: 48, lat: 53.41, lng: -2.16, travelRadiusKm: 40, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const docs: Record<string, string> = {};
  for (const type of requiredDocumentsForRole(jobRole)) {
    const doc = await api.post(`/api/v1/workers/${res.body.id}/documents`).set(auth(s.token)).send({ type, expiresAt: (expiry[type] ?? addDays(clock, 400)).toISOString() });
    expect(doc.status).toBe(201);
    expect((await api.patch(`/api/v1/workers/${res.body.id}/documents/${doc.body.id}`).set(auth(s.token)).send({ verified: true })).status).toBe(200);
    docs[type] = doc.body.id;
  }
  return { id: res.body.id as string, docs };
}

/** A published shift opened to every organisation at once, so suppliers can act without waiting for the staged windows. */
async function openShift(host: Session, siteId: string, body: Record<string, unknown>): Promise<string> {
  const res = await api.post('/api/v1/shifts').set(auth(host.token)).send({ siteId, jobRole: 'CARE_ASSISTANT', title: 'Shift', breakMinutes: 60, chargeRate: 20, publish: true, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const esc = await api.post(`/api/v1/shifts/${res.body.id}/escalate`).set(auth(host.token)).send({ openToAll: true });
  expect(esc.status, JSON.stringify(esc.body)).toBe(200);
  return res.body.id as string;
}

async function requestShift(supplier: Session, shiftId: string, workerId: string): Promise<string> {
  const res = await api.post(`/api/v1/shifts/${shiftId}/requests`).set(auth(supplier.token)).send({ workerId });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.assignment.id as string;
}

async function inbox(token: string): Promise<Notif[]> {
  const res = await api.get('/api/v1/notifications?unread=false&limit=200').set(auth(token));
  expect(res.status).toBe(200);
  return res.body.notifications as Notif[];
}

async function tick() {
  const res = await api.post('/api/v1/admin/scheduler/tick').set(auth(agency.token));
  expect(res.status).toBe(200);
  return res.body as { flagsExpired: number; documentAlerts: number };
}

const kindOf = (n: Notif) => (n.data as { kind?: string } | null)?.kind;

let agency: Session;
let oakwood: Session; // host
let riverside: Session; // supplier
let oakSite: { id: string };

beforeAll(async () => {
  const boot = await api.post('/api/v1/auth/bootstrap').send({
    organisation: { name: 'Merge Staffing', postcode: 'M1 4BT', lat: 53.4794, lng: -2.2453 },
    admin: { email: 'admin@merge.local', password: 'password123', firstName: 'Priya', lastName: 'Shah' },
  });
  expect(boot.status).toBe(201);
  agency = { token: boot.body.token, orgId: boot.body.organisation.id, userId: boot.body.user.id };
  oakwood = await register('Oakwood Care');
  riverside = await register('Riverside Living', { postcode: 'SK4 1AB', lat: 53.4106, lng: -2.1575 });
  oakSite = await addSite(oakwood, 'Oakwood Manor');
});

describe('eligibility is re-checked when a request is confirmed', () => {
  /** Five 12h shifts (11h paid) Tue–Sat of the week starting 2 Nov, plus one the week after. */
  const days = [3, 4, 5, 6, 7];
  const shiftIds: string[] = [];
  const assignmentIds: string[] = [];
  let nextWeekAssignment: string;
  let aisha: { id: string };

  beforeAll(async () => {
    aisha = await addWorker(riverside, 'Aisha');
    for (const day of days) {
      const startsAt = new Date(`2026-11-0${day}T08:00:00Z`);
      shiftIds.push(await openShift(oakwood, oakSite.id, { title: `Long day ${day}`, startsAt: startsAt.toISOString(), endsAt: addHours(startsAt, 12).toISOString() }));
    }
    const nextWeek = await openShift(oakwood, oakSite.id, { title: 'Next week', startsAt: '2026-11-10T08:00:00Z', endsAt: '2026-11-10T20:00:00Z' });
    // Requests are soft holds: nothing stops five of them being made for one worker in one week.
    for (const id of shiftIds) assignmentIds.push(await requestShift(riverside, id, aisha.id));
    nextWeekAssignment = await requestShift(riverside, nextWeek, aisha.id);
  });

  it('confirms the first four (44h) and refuses the fifth, which would break the 48h week', async () => {
    for (const id of assignmentIds.slice(0, 4)) {
      const res = await api.post(`/api/v1/assignments/${id}/confirm`).set(auth(oakwood.token));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe('CONFIRMED');
    }
    const fifth = await api.post(`/api/v1/assignments/${assignmentIds[4]}/confirm`).set(auth(oakwood.token));
    expect(fifth.status).toBe(409);
    expect(fifth.body.error).toMatch(/Aisha Worker is no longer eligible/);
    expect(fifth.body.details.code).toBe('NO_LONGER_ELIGIBLE');
    const codes = fifth.body.details.blockers.map((b: { code: string }) => b.code);
    expect(codes).toContain('WEEKLY_HOURS_EXCEEDED');
    expect(fifth.body.details.blockers[0].message).toMatch(/55\.0h this week \(limit 48h\)/);
  });

  it('declines that request, tells the supplier why and audits it; other pending requests are untouched', async () => {
    const declined = await api.get(`/api/v1/assignments/${assignmentIds[4]}`).set(auth(oakwood.token));
    expect(declined.body.status).toBe('DECLINED');
    expect(declined.body.note).toMatch(/^No longer eligible at confirmation: Would take the worker to 55\.0h/);
    // A second attempt is refused as already answered rather than re-evaluated.
    expect((await api.post(`/api/v1/assignments/${assignmentIds[4]}/confirm`).set(auth(oakwood.token))).status).toBe(409);
    const notices = (await inbox(riverside.token)).filter((n) => n.type === 'SHIFT_DECLINED' && kindOf(n) === 'no-longer-eligible');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toMatch(/55\.0h this week/);
    expect((notices[0]!.data as { assignmentId: string }).assignmentId).toBe(assignmentIds[4]);
    const audit = db.select().from(auditLog).where(and(eq(auditLog.entityType, 'shift_assignment'), eq(auditLog.entityId, assignmentIds[4]!), eq(auditLog.action, 'DECLINE'))).all();
    expect(audit).toHaveLength(1);
    expect((audit[0]!.data as { reason: string; blockers: { code: string }[] }).reason).toBe('NO_LONGER_ELIGIBLE');
    expect((audit[0]!.data as { blockers: { code: string }[] }).blockers[0]!.code).toBe('WEEKLY_HOURS_EXCEEDED');
    // The request for the following week is a different week: still pending, and still confirmable.
    expect((await api.get(`/api/v1/assignments/${nextWeekAssignment}`).set(auth(oakwood.token))).body.status).toBe('REQUESTED');
    expect((await api.post(`/api/v1/assignments/${nextWeekAssignment}/confirm`).set(auth(oakwood.token))).status).toBe(200);
    // The shift itself stays open for someone else.
    expect((await api.get(`/api/v1/shifts/${shiftIds[4]}`).set(auth(oakwood.token))).body.status).toBe('OPEN');
  });

  it('reports the refusal per row when confirming in bulk', async () => {
    const bea = await addWorker(riverside, 'Bea');
    const ids: string[] = [];
    for (const day of days) {
      const startsAt = new Date(`2026-11-0${day}T08:00:00Z`);
      const shiftId = await openShift(oakwood, oakSite.id, { title: `Second long day ${day}`, startsAt: startsAt.toISOString(), endsAt: addHours(startsAt, 12).toISOString() });
      ids.push(await requestShift(riverside, shiftId, bea.id));
    }
    const res = await api.post('/api/v1/assignments/bulk').set(auth(oakwood.token)).send({ ids, action: 'confirm' });
    expect(res.status).toBe(200);
    expect(res.body.results.slice(0, 4).map((r: { ok: boolean; status: string }) => [r.ok, r.status])).toEqual([[true, 'CONFIRMED'], [true, 'CONFIRMED'], [true, 'CONFIRMED'], [true, 'CONFIRMED']]);
    const last = res.body.results[4];
    expect(last.ok).toBe(false);
    expect(last.error).toMatch(/no longer eligible/);
    expect(last.details.code).toBe('NO_LONGER_ELIGIBLE');
    expect((await api.get(`/api/v1/assignments/${ids[4]}`).set(auth(oakwood.token))).body.status).toBe('DECLINED');
  });
});

describe('document expiry alerts reach the worker (CMP-02)', () => {
  let cara: { id: string; docs: Record<string, string> };
  let caraToken: string;
  let caraUserId: string;

  beforeAll(async () => {
    cara = await addWorker(riverside, 'Cara', {}, { DBS: addDays(clock, 10) });
    const login = await api.post(`/api/v1/workers/${cara.id}/login`).set(auth(riverside.token)).send({ email: 'cara@example.com', password: 'password123' });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    caraUserId = login.body.userId;
    const session = await api.post('/api/v1/auth/login').send({ email: 'cara@example.com', password: 'password123' });
    expect(session.status).toBe(200);
    caraToken = session.body.token;
  });

  it('sends the worker one alert addressed to them, and the employer its own copy', async () => {
    const t = await tick();
    expect(t.documentAlerts).toBeGreaterThanOrEqual(1);
    const mine = (await inbox(caraToken)).filter((n) => n.type === 'DOCUMENT_EXPIRING');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ userId: caraUserId, title: 'Your Enhanced DBS check expires in 10 day(s)' });
    expect(mine[0]!.body).toBe('Your Enhanced DBS check expires in 10 days. Upload the renewed certificate from My documents so you can keep taking shifts.');
    expect((mine[0]!.data as { documentId: string }).documentId).toBe(cara.docs.DBS);
    // The employer's copy is organisation-wide (no userId); the worker's copy is not shown to managers.
    const employers = (await inbox(riverside.token)).filter((n) => n.type === 'DOCUMENT_EXPIRING' && (n.data as { documentId: string }).documentId === cara.docs.DBS);
    expect(employers).toHaveLength(1);
    expect(employers[0]!.userId).toBeNull();
    expect(employers[0]!.title).toBe('Enhanced DBS check expiring for Cara Worker');
  });

  it('does not repeat it on the next tick of the same week', async () => {
    await tick();
    expect((await inbox(caraToken)).filter((n) => n.type === 'DOCUMENT_EXPIRING')).toHaveLength(1);
    expect((await inbox(riverside.token)).filter((n) => n.type === 'DOCUMENT_EXPIRING' && (n.data as { documentId: string }).documentId === cara.docs.DBS)).toHaveLength(1);
  });
});

describe('a lapsed surplus flag is pointed out (DSP-03)', () => {
  it('expires the flag on tick and sends the organisation one FLAG_EXPIRED notice', async () => {
    const res = await api.post('/api/v1/capacity/flags').set(auth(riverside.token)).send({ kind: 'SURPLUS', jobRole: 'CARE_ASSISTANT', headcount: 2, hoursRequested: 80, startsAt: clock.toISOString(), endsAt: addDays(clock, 1).toISOString() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const flagId = res.body.id as string;
    // The period is over: the flag ended yesterday.
    db.update(capacityFlags).set({ startsAt: addDays(clock, -8), endsAt: addDays(clock, -1) }).where(eq(capacityFlags.id, flagId)).run();
    const t = await tick();
    expect(t.flagsExpired).toBe(1);
    expect(db.select().from(capacityFlags).where(eq(capacityFlags.id, flagId)).get()!.status).toBe('EXPIRED');
    const notices = (await inbox(riverside.token)).filter((n) => n.type === 'FLAG_EXPIRED');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toBe('Your surplus flag has expired');
    expect(notices[0]!.body).toBe('Your Care assistant surplus flag ran out on 1 Nov 2026. Raise it again from Capacity flags if you still have spare staff; without an active flag you no longer get first access.');
    expect(notices[0]!.data).toEqual({ flagId, kind: 'SURPLUS', jobRole: 'CARE_ASSISTANT' });
    // Already expired: nothing more on the next tick.
    expect((await tick()).flagsExpired).toBe(0);
    expect((await inbox(riverside.token)).filter((n) => n.type === 'FLAG_EXPIRED')).toHaveLength(1);
  });
});

describe('suspending an organisation (PLT-01)', () => {
  let lakeside: Session; // host of one open shift, employer of a worker booked elsewhere
  let pennine: Session; // another supplier that can see Lakeside's shift
  let lakesideShift: string;
  let sophieRequest: string; // Pennine's pending request on Lakeside's shift
  let liamBooking: string; // Lakeside's worker confirmed at Oakwood

  beforeAll(async () => {
    lakeside = await register('Lakeside Lodge', { postcode: 'SK8 1AA', lat: 53.39, lng: -2.2 });
    pennine = await register('Pennine Nursing', { postcode: 'OL1 3DF', lat: 53.5409, lng: -2.1114 });
    const lakeSite = await addSite(lakeside, 'Lakeside House');
    const liam = await addWorker(lakeside, 'Liam');
    const sophie = await addWorker(pennine, 'Sophie');
    lakesideShift = await openShift(lakeside, lakeSite.id, { title: 'Lakeside night', startsAt: '2026-11-12T20:00:00Z', endsAt: '2026-11-13T08:00:00Z' });
    sophieRequest = await requestShift(pennine, lakesideShift, sophie.id);
    const oakShift = await openShift(oakwood, oakSite.id, { title: 'Oakwood day', startsAt: '2026-11-13T08:00:00Z', endsAt: '2026-11-13T20:00:00Z' });
    liamBooking = await requestShift(lakeside, oakShift, liam.id);
    expect((await api.post(`/api/v1/assignments/${liamBooking}/confirm`).set(auth(oakwood.token))).status).toBe(200);
  });

  it('shows the shift to the network beforehand', async () => {
    const board = await api.get('/api/v1/shifts?scope=available').set(auth(pennine.token));
    expect(board.status).toBe(200);
    expect(board.body.some((s: { id: string }) => s.id === lakesideShift)).toBe(true);
  });

  it('cancels its unstarted shifts, keeps its staff\'s bookings elsewhere and tells those hosts', async () => {
    const res = await api.patch(`/api/v1/organisations/${lakeside.orgId}`).set(auth(agency.token)).send({ status: 'SUSPENDED', suspendedReason: 'Two invoices overdue' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'SUSPENDED', suspendedReason: 'Two invoices overdue', effects: { shiftsCancelled: 1, bookingsHonoured: 1 } });

    const shift = db.select().from(shifts).where(eq(shifts.id, lakesideShift)).get()!;
    expect(shift.status).toBe('CANCELLED');
    expect(shift.cancellationReason).toMatch(/^Organisation suspended/);
    const board = await api.get('/api/v1/shifts?scope=available').set(auth(pennine.token));
    expect(board.body.some((s: { id: string }) => s.id === lakesideShift)).toBe(false);
    const sophie = await api.get(`/api/v1/assignments/${sophieRequest}`).set(auth(pennine.token));
    expect(sophie.body.status).toBe('CANCELLED');
    expect((await inbox(pennine.token)).some((n) => n.type === 'SHIFT_CANCELLED' && /Organisation suspended; it can no longer receive staff/.test(n.body))).toBe(true);

    const booking = await api.get(`/api/v1/assignments/${liamBooking}`).set(auth(oakwood.token));
    expect(booking.body.status).toBe('CONFIRMED');
    const notice = (await inbox(oakwood.token)).find((n) => n.type === 'SYSTEM' && kindOf(n) === 'supplier-suspended');
    expect(notice).toBeDefined();
    expect(notice!.body).toBe('Lakeside Lodge has been suspended from the network; your confirmed booking(s) with its staff on Fri 13 Nov stand. Contact the platform if you want them re-covered.');
    expect((notice!.data as { assignmentIds: string[] }).assignmentIds).toEqual([liamBooking]);

    const audit = db.select().from(auditLog).where(and(eq(auditLog.entityType, 'organisation'), eq(auditLog.entityId, lakeside.orgId), eq(auditLog.action, 'UPDATE'))).all();
    expect(audit.some((a) => (a.data as { shiftsCancelled?: number; bookingsHonoured?: number }).shiftsCancelled === 1 && (a.data as { bookingsHonoured?: number }).bookingsHonoured === 1)).toBe(true);
    // Its users are locked out.
    expect((await api.get('/api/v1/auth/me').set(auth(lakeside.token))).status).toBe(403);
  });

  it('does nothing more when suspended again, and reinstates cleanly', async () => {
    const again = await api.patch(`/api/v1/organisations/${lakeside.orgId}`).set(auth(agency.token)).send({ status: 'SUSPENDED' });
    expect(again.status).toBe(200);
    expect(again.body.effects).toBeUndefined();
    expect((await inbox(oakwood.token)).filter((n) => kindOf(n) === 'supplier-suspended')).toHaveLength(1);
    const back = await api.patch(`/api/v1/organisations/${lakeside.orgId}`).set(auth(agency.token)).send({ status: 'ACTIVE' });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ status: 'ACTIVE', suspendedReason: null });
    expect(back.body.effects).toBeUndefined();
    expect((await api.get('/api/v1/auth/me').set(auth(lakeside.token))).status).toBe(200);
    expect((await api.patch('/api/v1/organisations/org_nope').set(auth(agency.token)).send({ status: 'SUSPENDED' })).status).toBe(404);
  });
});
