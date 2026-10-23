/**
 * Workforce report for inspections (REP-01) and data-subject tooling (SEC-01):
 * export, erasure request and erasure that keeps financial and safety records.
 */
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { addDays, addHours, addMinutes, requiredDocumentsForRole, type JobRole } from '@merge/shared';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations } from '../src/db/client.js';
import { platformSettings, users, workerDocuments, workers } from '../src/db/schema.js';
import { documentStatusOnDay } from '../src/services/workforceReport.js';

const T0 = new Date('2026-11-02T08:00:00Z');
let clock = T0;
const { db } = openDatabase(':memory:');
runMigrations(db);
const { app } = createApp({ db, now: () => clock, channels: [] });
// Two-factor set-up (decision 16) is covered by the security suite.
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

async function addWorker(s: Session, firstName: string, jobRole: JobRole = 'CARE_ASSISTANT') {
  const res = await api.post('/api/v1/workers').set(auth(s.token)).send({ firstName, lastName: 'Worker', jobRole, skills: ['MOVING_AND_HANDLING', 'DEMENTIA'], shareable: true, lat: 53.41, lng: -2.16, travelRadiusKm: 40 });
  expect(res.status).toBe(201);
  for (const type of requiredDocumentsForRole(jobRole)) {
    const doc = await api.post(`/api/v1/workers/${res.body.id}/documents`).set(auth(s.token)).send({ type, reference: `${type}-ref`, expiresAt: addDays(clock, 400).toISOString() });
    expect(doc.status).toBe(201);
    expect((await api.patch(`/api/v1/workers/${res.body.id}/documents/${doc.body.id}`).set(auth(s.token)).send({ verified: true })).status).toBe(200);
  }
  return res.body as { id: string; orgId: string };
}

/** Post a shift at Oakwood Manor, have Riverside put the worker forward, confirm, and return the draft timesheet. */
async function book(workerId: string, startsAt: Date, hours = 8, breakMinutes = 30) {
  const shift = await api.post('/api/v1/shifts').set(auth(oakwood.token)).send({ siteId: oakSite.id, jobRole: 'CARE_ASSISTANT', title: `Shift ${startsAt.toISOString().slice(0, 10)}`, startsAt: startsAt.toISOString(), endsAt: addHours(startsAt, hours).toISOString(), breakMinutes, chargeRate: 20, publish: true });
  expect(shift.status, JSON.stringify(shift.body)).toBe(201);
  clock = addMinutes(clock, 181); // no capacity flags: everyone opens at the network window
  const req = await api.post(`/api/v1/shifts/${shift.body.id}/requests`).set(auth(riverside.token)).send({ workerId });
  expect(req.status, JSON.stringify(req.body)).toBe(201);
  if (req.body.assignment.status !== 'CONFIRMED') expect((await api.post(`/api/v1/assignments/${req.body.assignment.id}/confirm`).set(auth(oakwood.token))).status).toBe(200);
  const list = await api.get('/api/v1/timesheets?scope=receivable&status=DRAFT').set(auth(riverside.token));
  const ts = list.body.find((t: { shiftId: string }) => t.shiftId === shift.body.id);
  expect(ts).toBeTruthy();
  return { shiftId: shift.body.id as string, assignmentId: req.body.assignment.id as string, timesheetId: ts.id as string, startsAt, endsAt: addHours(startsAt, hours) };
}

async function complete(b: Awaited<ReturnType<typeof book>>) {
  expect((await api.post(`/api/v1/timesheets/${b.timesheetId}/submit`).set(auth(riverside.token)).send({ clockInAt: b.startsAt.toISOString(), clockOutAt: b.endsAt.toISOString(), breakMinutes: 30 })).status).toBe(200);
  const approved = await api.post(`/api/v1/timesheets/${b.timesheetId}/approve`).set(auth(oakwood.token));
  expect(approved.status).toBe(200);
  expect(approved.body.status).toBe('APPROVED');
}

async function inbox(s: Session): Promise<Notif[]> {
  const res = await api.get('/api/v1/notifications?unread=false').set(auth(s.token));
  expect(res.status).toBe(200);
  return res.body.notifications as Notif[];
}

async function workerLogin(s: Session, workerId: string, email: string): Promise<string> {
  expect((await api.post(`/api/v1/workers/${workerId}/login`).set(auth(s.token)).send({ email, password: 'password123' })).status).toBe(201);
  const session = await api.post('/api/v1/auth/login').send({ email, password: 'password123' });
  expect(session.status).toBe(200);
  return session.body.token as string;
}

let agency: Session;
let oakwood: Session; // host
let riverside: Session; // employer of the lent workers
let oakSite: { id: string };
let farSite: { id: string };
let houseManager: string; // Oakwood manager limited to Oakwood Manor
let aisha: { id: string };
let bea: { id: string };
let shiftA: Awaited<ReturnType<typeof book>>;
let shiftB: Awaited<ReturnType<typeof book>>;

beforeAll(async () => {
  const boot = await api.post('/api/v1/auth/bootstrap').send({
    organisation: { name: 'Merge Staffing', postcode: 'M1 4BT', lat: 53.4794, lng: -2.2453 },
    admin: { email: 'admin@merge.local', password: 'password123', firstName: 'Priya', lastName: 'Shah' },
  });
  expect(boot.status).toBe(201);
  agency = { token: boot.body.token, orgId: boot.body.organisation.id, userId: boot.body.user.id };
  oakwood = await register('Oakwood Care');
  riverside = await register('Riverside Living', { postcode: 'SK4 1AB', lat: 53.4106, lng: -2.1575 });

  const site = await api.post(`/api/v1/organisations/${oakwood.orgId}/sites`).set(auth(oakwood.token)).send({ name: 'Oakwood Manor', postcode: 'M20 2RN', lat: 53.4186, lng: -2.2311 });
  expect(site.status).toBe(201);
  oakSite = site.body;
  const far = await api.post(`/api/v1/organisations/${oakwood.orgId}/sites`).set(auth(oakwood.token)).send({ name: 'Oakwood Lakes', postcode: 'BL1 1AA', lat: 53.58, lng: -2.43 });
  expect(far.status).toBe(201);
  farSite = far.body;
  const mgr = await api.post(`/api/v1/organisations/${oakwood.orgId}/users`).set(auth(oakwood.token)).send({ email: 'house@oakwood.example', password: 'House-Pass-2026', firstName: 'Hana', lastName: 'House', role: 'ORG_MANAGER', siteIds: [oakSite.id] });
  expect(mgr.status).toBe(201);
  houseManager = (await api.post('/api/v1/auth/login').send({ email: 'house@oakwood.example', password: 'House-Pass-2026' })).body.token;

  aisha = await addWorker(riverside, 'Aisha');
  bea = await addWorker(riverside, 'Bea');
  shiftA = await book(aisha.id, addDays(T0, 3));
  shiftB = await book(bea.id, addDays(T0, 4));
  clock = addDays(T0, 6);
  await complete(shiftA);
  await complete(shiftB);
  // Bea's DBS lapsed the day before her shift; nobody noticed until the inspection.
  const dbs = db.select().from(workerDocuments).where(and(eq(workerDocuments.workerId, bea.id), eq(workerDocuments.type, 'DBS'))).get()!;
  db.update(workerDocuments).set({ expiresAt: addDays(shiftB.startsAt, -1) }).where(eq(workerDocuments.id, dbs.id)).run();
});

describe('workforce report (REP-01)', () => {
  const range = { from: T0.toISOString(), to: addDays(T0, 10).toISOString() };

  it('lists who worked, for whom, with every check as it stood on the day', async () => {
    const res = await api.get('/api/v1/reports/workforce').set(auth(oakwood.token)).query(range);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    const a = res.body.rows.find((r: { shiftId: string }) => r.shiftId === shiftA.shiftId);
    expect(a).toMatchObject({ workerName: 'Aisha Worker', employerName: 'Riverside Living', employerOrgId: riverside.orgId, siteName: 'Oakwood Manor', shiftDate: '2026-11-05', attendance: 'COMPLETED', paidHours: 7.5, timesheetStatus: 'APPROVED', compliantOnDay: true });
    for (const type of requiredDocumentsForRole('CARE_ASSISTANT')) expect(a.documents[type]).toBe('VALID');
    expect(JSON.stringify(a)).not.toMatch(/DBS-ref|hourlyPayRate|chargeRate/);
    expect(res.body.summary).toEqual({ shifts: 2, workers: 2, employers: 1, nonCompliantOnDay: 1 });
  });

  it('shows a document that had expired by the shift date as EXPIRED', async () => {
    const res = await api.get('/api/v1/reports/workforce').set(auth(oakwood.token)).query({ ...range, siteId: oakSite.id });
    expect(res.status).toBe(200);
    const b = res.body.rows.find((r: { shiftId: string }) => r.shiftId === shiftB.shiftId);
    expect(b.documents.DBS).toBe('EXPIRED');
    expect(b.documents.RIGHT_TO_WORK).toBe('VALID');
    expect(b.compliantOnDay).toBe(false);
    // The same document was valid the day before it expired, and a later renewal does not count retrospectively.
    const day = shiftB.startsAt;
    const history = [{ type: 'DBS' as const, verifiedAt: T0, expiresAt: addDays(day, -1), supersededAt: null, createdAt: T0 }];
    expect(documentStatusOnDay(history, 'DBS', addDays(day, -2))).toBe('VALID');
    expect(documentStatusOnDay([...history, { type: 'DBS', verifiedAt: addDays(day, 1), expiresAt: null, supersededAt: null, createdAt: addDays(day, 1) }], 'DBS', day)).toBe('EXPIRED');
    expect(documentStatusOnDay([...history, { type: 'DBS', verifiedAt: null, expiresAt: null, supersededAt: null, createdAt: addDays(day, -1) }], 'DBS', day)).toBe('UNVERIFIED');
    expect(documentStatusOnDay(history, 'PHOTO_ID', day)).toBe('MISSING');
  });

  it('downloads as CSV with one column per document type', async () => {
    const res = await api.get('/api/v1/reports/workforce').set(auth(oakwood.token)).query({ ...range, format: 'csv', siteId: oakSite.id });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="workforce-oakwood-manor-2026-11-02-2026-11-12.csv"');
    const lines = res.text.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Date,Start,End,Site,Shift,Role,Worker,Employer,Attendance,Paid hours,Timesheet,Compliant on day,DBS,RIGHT_TO_WORK,PHOTO_ID,MANDATORY_TRAINING,MOVING_AND_HANDLING_TRAINING,SAFEGUARDING_TRAINING');
    expect(lines[1]).toMatch(/^2026-11-05,.*,Oakwood Manor,Shift 2026-11-05,CARE_ASSISTANT,Aisha Worker,Riverside Living,COMPLETED,7.5,APPROVED,yes,VALID,VALID/);
    expect(lines[2]).toMatch(/,no,EXPIRED,VALID/);
  });

  it('keeps a site-limited manager to their sites and other organisations out', async () => {
    expect((await api.get('/api/v1/reports/workforce').set(auth(houseManager)).query({ ...range, siteId: farSite.id })).status).toBe(403);
    const own = await api.get('/api/v1/reports/workforce').set(auth(houseManager)).query({ ...range, siteId: oakSite.id });
    expect(own.status).toBe(200);
    expect(own.body.rows).toHaveLength(2);
    const unscoped = await api.get('/api/v1/reports/workforce').set(auth(houseManager)).query(range);
    expect(unscoped.status).toBe(200);
    expect(unscoped.body.rows.every((r: { siteId: string }) => r.siteId === oakSite.id)).toBe(true);
    expect((await api.get('/api/v1/reports/workforce').set(auth(riverside.token)).query({ ...range, orgId: oakwood.orgId })).status).toBe(403);
    const admin = await api.get('/api/v1/reports/workforce').set(auth(agency.token)).query({ ...range, orgId: oakwood.orgId });
    expect(admin.status).toBe(200);
    expect(admin.body.rows).toHaveLength(2);
    expect((await api.get('/api/v1/reports/workforce').set(auth(agency.token)).query(range)).body.rows).toHaveLength(0); // the agency hosted nothing
  });
});

describe('data-subject tooling (SEC-01, decision 18)', () => {
  let aishaToken: string;
  let beaToken: string;

  beforeAll(async () => {
    aishaToken = await workerLogin(riverside, aisha.id, 'aisha@riverside.example');
    beaToken = await workerLogin(riverside, bea.id, 'bea@riverside.example');
  });

  it('exports everything held about the worker, without storage keys, to the worker and their employer only', async () => {
    const res = await api.get(`/api/v1/workers/${aisha.id}/export`).set(auth(aishaToken));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.worker).toMatchObject({ id: aisha.id, firstName: 'Aisha' });
    expect(res.body.login).toMatchObject({ email: 'aisha@riverside.example', twoFactorEnabled: false });
    expect(res.body.documents).toHaveLength(requiredDocumentsForRole('CARE_ASSISTANT').length);
    for (const d of res.body.documents) {
      expect(d).not.toHaveProperty('fileKey');
      expect(d.hasFile).toBe(false);
    }
    expect(res.body.assignments).toHaveLength(1);
    expect(res.body.assignments[0]).toMatchObject({ status: 'COMPLETED', shift: { id: shiftA.shiftId, hostOrgName: 'Oakwood Care', siteName: 'Oakwood Manor' } });
    expect(res.body.timesheets).toHaveLength(1);
    expect(res.body.timesheets[0]).toMatchObject({ status: 'APPROVED', paidHours: 7.5 });
    expect(res.body).toMatchObject({ consent: { consentToShareAt: null }, unavailability: [], weekHours: [], ratings: [], bars: [], reports: [] });

    expect((await api.get(`/api/v1/workers/${aisha.id}/export`).set(auth(beaToken))).status).toBe(403);
    expect((await api.get(`/api/v1/workers/${aisha.id}/export`).set(auth(oakwood.token))).status).toBe(403);
    expect((await api.get(`/api/v1/workers/${aisha.id}/export`).set(auth(riverside.token))).status).toBe(200);
    const download = await api.get(`/api/v1/workers/${aisha.id}/export?download=1`).set(auth(agency.token));
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toBe(`attachment; filename="worker-${aisha.id}.json"`);
  });

  it('lets the worker ask for erasure and tells the employer admins', async () => {
    expect((await api.post(`/api/v1/workers/${aisha.id}/erasure-request`).set(auth(riverside.token))).status).toBe(403);
    expect((await api.post(`/api/v1/workers/${aisha.id}/erasure-request`).set(auth(beaToken))).status).toBe(403);
    const res = await api.post(`/api/v1/workers/${aisha.id}/erasure-request`).set(auth(aishaToken));
    expect(res.status).toBe(202);
    expect(res.body.requestedAt).toBe(clock.toISOString());
    const note = (await inbox(riverside)).find((n) => n.data?.kind === 'erasure-request');
    expect(note).toBeDefined();
    expect(note!.type).toBe('SYSTEM');
    expect(note!.title).toBe('Aisha Worker asked for their personal data to be erased (GDPR)');
    expect(note!.data).toMatchObject({ workerId: aisha.id });
  });

  it('refuses to erase an active worker, then erases a leaver but keeps the timesheet', async () => {
    const reason = { reason: 'Left on 30 November; erasure requested' };
    const active = await api.post(`/api/v1/workers/${aisha.id}/erase`).set(auth(riverside.token)).send(reason);
    expect(active.status).toBe(409);
    expect((await api.patch(`/api/v1/workers/${aisha.id}`).set(auth(riverside.token)).send({ status: 'INACTIVE' })).status).toBe(200);
    expect((await api.post(`/api/v1/workers/${aisha.id}/erase`).set(auth(oakwood.token)).send(reason)).status).toBe(403);
    expect((await api.post(`/api/v1/workers/${aisha.id}/erase`).set(auth(riverside.token)).send({})).status).toBe(400);

    const res = await api.post(`/api/v1/workers/${aisha.id}/erase`).set(auth(riverside.token)).send(reason);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ erasedAt: clock.toISOString(), kept: ['timesheets', 'invoices', 'ratings', 'audit'] });

    const detail = await api.get(`/api/v1/workers/${aisha.id}`).set(auth(riverside.token));
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ firstName: 'Former', lastName: 'Worker', email: null, phone: null, postcode: null, skills: [], shareable: false, status: 'INACTIVE', erasedAt: clock.toISOString() });
    expect(detail.body.documents).toEqual([]);
    const row = db.select().from(workers).where(eq(workers.id, aisha.id)).get()!;
    const login = db.select().from(users).where(eq(users.id, row.userId!)).get()!;
    expect(login).toMatchObject({ status: 'DISABLED', email: `erased-${row.userId}@erased.invalid`, totpSecret: null, siteIds: null });
    expect((await api.get('/api/v1/auth/me').set(auth(aishaToken))).status).toBe(401);

    const sheets = await api.get('/api/v1/timesheets?scope=receivable').set(auth(riverside.token));
    expect(sheets.body.find((t: { id: string }) => t.id === shiftA.timesheetId)).toMatchObject({ status: 'APPROVED', paidHours: 7.5 });
    const list = await api.get('/api/v1/workers?status=INACTIVE').set(auth(riverside.token));
    expect(list.body.map((w: { id: string; firstName: string }) => [w.id, w.firstName])).toEqual([[aisha.id, 'Former']]);
    expect((await api.post(`/api/v1/workers/${aisha.id}/erase`).set(auth(riverside.token)).send(reason)).status).toBe(409);
  });
});
