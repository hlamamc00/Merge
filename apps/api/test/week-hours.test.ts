/**
 * Decision 8: a worker's contracted hours with their own employer count towards the 48h weekly limit
 * unless the employer records the real figure for the week, by hand or by naming the worker on a
 * surplus flag.
 */
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { addDays, addHours, requiredDocumentsForRole, type JobRole } from '@merge/shared';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations } from '../src/db/client.js';
import { platformSettings } from '../src/db/schema.js';

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
interface EligibleRow {
  id: string;
  eligible: boolean;
  blockers: { code: string; message: string }[];
  facts: { weeklyHoursAfter: number };
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

async function addWorker(s: Session, firstName: string, extra: Record<string, unknown> = {}, jobRole: JobRole = 'CARE_ASSISTANT') {
  const res = await api.post('/api/v1/workers').set(auth(s.token)).send({ firstName, lastName: 'Worker', jobRole, skills: ['MOVING_AND_HANDLING', 'DEMENTIA'], shareable: true, contractedHoursPerWeek: 37.5, lat: 53.41, lng: -2.16, travelRadiusKm: 40, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  for (const type of requiredDocumentsForRole(jobRole)) {
    const doc = await api.post(`/api/v1/workers/${res.body.id}/documents`).set(auth(s.token)).send({ type, expiresAt: addDays(clock, 400).toISOString() });
    expect(doc.status).toBe(201);
    expect((await api.patch(`/api/v1/workers/${res.body.id}/documents/${doc.body.id}`).set(auth(s.token)).send({ verified: true })).status).toBe(200);
  }
  return res.body as { id: string; orgId: string };
}

/** A published 12h shift (no break) starting at `startsAt`, opened to every organisation at once. */
async function twelveHourShift(startsAt: Date): Promise<string> {
  const res = await api.post('/api/v1/shifts').set(auth(oakwood.token)).send({ siteId: oakSite.id, jobRole: 'CARE_ASSISTANT', title: 'Long day', breakMinutes: 0, chargeRate: 20, publish: true, startsAt: startsAt.toISOString(), endsAt: addHours(startsAt, 12).toISOString() });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const esc = await api.post(`/api/v1/shifts/${res.body.id}/escalate`).set(auth(oakwood.token)).send({ openToAll: true });
  expect(esc.status, JSON.stringify(esc.body)).toBe(200);
  return res.body.id as string;
}

async function eligibility(s: Session, shiftId: string, workerId: string): Promise<EligibleRow> {
  const res = await api.get(`/api/v1/shifts/${shiftId}/eligible-workers`).set(auth(s.token));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const row = (res.body.workers as EligibleRow[]).find((w) => w.id === workerId);
  expect(row).toBeDefined();
  return row!;
}

const codes = (row: EligibleRow) => row.blockers.map((b) => b.code);

let agency: Session;
let oakwood: Session; // host
let riverside: Session; // supplier whose staff are on 37.5h contracts
let pennine: Session; // another supplier
let oakSite: { id: string };
let aisha: { id: string };
let bea: { id: string };
let cara: { id: string };
let sophie: { id: string };
let thisWeekShift: string; // Wed 4 Nov

beforeAll(async () => {
  const boot = await api.post('/api/v1/auth/bootstrap').send({
    organisation: { name: 'Merge Staffing', postcode: 'M1 4BT', lat: 53.4794, lng: -2.2453 },
    admin: { email: 'admin@merge.local', password: 'password123', firstName: 'Priya', lastName: 'Shah' },
  });
  expect(boot.status).toBe(201);
  agency = { token: boot.body.token, orgId: boot.body.organisation.id, userId: boot.body.user.id };
  oakwood = await register('Oakwood Care');
  riverside = await register('Riverside Living', { postcode: 'SK4 1AB', lat: 53.4106, lng: -2.1575 });
  pennine = await register('Pennine Nursing', { postcode: 'OL1 3DF', lat: 53.5409, lng: -2.1114 });
  const site = await api.post(`/api/v1/organisations/${oakwood.orgId}/sites`).set(auth(oakwood.token)).send({ name: 'Oakwood Manor', postcode: 'M20 2RN', lat: 53.4186, lng: -2.2311 });
  expect(site.status).toBe(201);
  oakSite = site.body;
  aisha = await addWorker(riverside, 'Aisha');
  bea = await addWorker(riverside, 'Bea');
  cara = await addWorker(riverside, 'Cara');
  sophie = await addWorker(pennine, 'Sophie');
  thisWeekShift = await twelveHourShift(new Date('2026-11-04T08:00:00Z'));
});

describe('contracted hours count by default (decision 8)', () => {
  it('blocks a full-time worker from a 12h shift and explains the split', async () => {
    const row = await eligibility(riverside, thisWeekShift, aisha.id);
    expect(row.eligible).toBe(false);
    expect(codes(row)).toEqual(['WEEKLY_HOURS_EXCEEDED']);
    expect(row.facts.weeklyHoursAfter).toBe(49.5);
    const blocker = row.blockers[0]!;
    expect(blocker.message).toContain('37.5h with their employer');
    expect(blocker.message).toContain('12h here');
    expect(blocker.message).toMatch(/record their actual hours/);
  });

  it('is lifted when the employer records the actual hours for that week, and returns when they reset it', async () => {
    const put = await api.put(`/api/v1/workers/${aisha.id}/weeks/2026-11-02`).set(auth(riverside.token)).send({ internalHours: 0, note: 'Not on the rota this week' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({ weekStart: '2026-11-02T00:00:00.000Z', internalHours: 0, contractedHoursPerWeek: 37.5, source: 'RECORDED', note: 'Not on the rota this week', sourceFlagId: null });
    const freed = await eligibility(riverside, thisWeekShift, aisha.id);
    expect(freed.eligible, JSON.stringify(freed.blockers)).toBe(true);
    expect(freed.facts.weeklyHoursAfter).toBe(12);

    // A partial figure still counts.
    const partial = await api.put(`/api/v1/workers/${aisha.id}/weeks/2026-11-02`).set(auth(riverside.token)).send({ internalHours: 30 });
    expect(partial.status).toBe(200);
    expect((await eligibility(riverside, thisWeekShift, aisha.id)).eligible).toBe(true);
    expect((await api.put(`/api/v1/workers/${aisha.id}/weeks/2026-11-02`).set(auth(riverside.token)).send({ internalHours: 36.5 })).status).toBe(200);
    expect(codes(await eligibility(riverside, thisWeekShift, aisha.id))).toEqual(['WEEKLY_HOURS_EXCEEDED']);

    expect((await api.delete(`/api/v1/workers/${aisha.id}/weeks/2026-11-02`).set(auth(riverside.token))).status).toBe(204);
    const back = await eligibility(riverside, thisWeekShift, aisha.id);
    expect(back.eligible).toBe(false);
    expect(back.facts.weeklyHoursAfter).toBe(49.5);
  });

  it('only accepts a Monday (Europe/London) as the week', async () => {
    for (const bad of ['2026-11-03', '2026-11-08', '2026-13-01', '2026-02-30', 'monday', '2026-11-2']) {
      const res = await api.put(`/api/v1/workers/${aisha.id}/weeks/${bad}`).set(auth(riverside.token)).send({ internalHours: 0 });
      expect(res.status, bad).toBe(422);
    }
    expect((await api.put(`/api/v1/workers/${aisha.id}/weeks/2026-11-02`).set(auth(riverside.token)).send({ internalHours: 200 })).status).toBe(400);
    // Another organisation's manager cannot touch the record.
    expect((await api.put(`/api/v1/workers/${aisha.id}/weeks/2026-11-02`).set(auth(pennine.token)).send({ internalHours: 0 })).status).toBe(403);
  });
});

describe('a surplus flag frees the staff it names', () => {
  let flagId: string;
  let insideShift: string; // Wed 11 Nov, inside the flag period
  let afterShift: string; // Wed 25 Nov, the week after the flag ends

  it('refuses staff of another organisation, and any staff on a shortage flag', async () => {
    const base = { jobRole: 'CARE_ASSISTANT', headcount: 1, hoursRequested: 80, startsAt: '2026-11-09T00:00:00Z', endsAt: '2026-11-21T00:00:00Z' };
    const foreign = await api.post('/api/v1/capacity/flags').set(auth(riverside.token)).send({ ...base, kind: 'SURPLUS', workerIds: [bea.id, sophie.id] });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toBe('Worker not found');
    const shortage = await api.post('/api/v1/capacity/flags').set(auth(riverside.token)).send({ ...base, kind: 'SHORTAGE', workerIds: [bea.id] });
    expect(shortage.status).toBe(422);
    // Nothing was written for Bea by the refused flags.
    const weeks = await api.get(`/api/v1/workers/${bea.id}/weeks?from=2026-11-09T00:00:00Z&to=2026-11-23T00:00:00Z`).set(auth(riverside.token));
    expect(weeks.status).toBe(200);
    expect(weeks.body.map((w: { source: string }) => w.source)).toEqual(['CONTRACT', 'CONTRACT']);
  });

  it('releases the named workers for every week of the flag', async () => {
    const res = await api.post('/api/v1/capacity/flags').set(auth(riverside.token)).send({ kind: 'SURPLUS', jobRole: 'CARE_ASSISTANT', headcount: 1, hoursRequested: 80, startsAt: '2026-11-09T00:00:00Z', endsAt: '2026-11-21T00:00:00Z', postcodeAreas: ['M', 'SK'], workerIds: [bea.id] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.workersReleased).toBe(1);
    expect(res.body.hoursRemaining).toBe(80);
    flagId = res.body.id;

    const weeks = await api.get(`/api/v1/workers/${bea.id}/weeks?from=2026-11-02T08:00:00Z&to=2026-11-30T00:00:00Z`).set(auth(riverside.token));
    expect(weeks.status).toBe(200);
    expect(weeks.body).toEqual([
      expect.objectContaining({ weekStart: '2026-11-02T00:00:00.000Z', internalHours: 37.5, source: 'CONTRACT', sourceFlagId: null }),
      expect.objectContaining({ weekStart: '2026-11-09T00:00:00.000Z', internalHours: 0, source: 'FLAG', sourceFlagId: flagId }),
      expect.objectContaining({ weekStart: '2026-11-16T00:00:00.000Z', internalHours: 0, source: 'FLAG', sourceFlagId: flagId }),
      expect.objectContaining({ weekStart: '2026-11-23T00:00:00.000Z', internalHours: 37.5, source: 'CONTRACT', sourceFlagId: null }),
    ]);
    const flags = await api.get('/api/v1/capacity/flags').set(auth(riverside.token));
    expect(flags.status).toBe(200);
    expect(flags.body.find((f: { id: string }) => f.id === flagId).releasedWorkers).toBe(1);

    insideShift = await twelveHourShift(new Date('2026-11-11T08:00:00Z'));
    afterShift = await twelveHourShift(new Date('2026-11-25T08:00:00Z'));
    expect((await eligibility(riverside, insideShift, bea.id)).eligible).toBe(true);
    expect(codes(await eligibility(riverside, afterShift, bea.id))).toEqual(['WEEKLY_HOURS_EXCEEDED']);
    // Cara was not named, so her contracted hours still count.
    expect(codes(await eligibility(riverside, insideShift, cara.id))).toEqual(['WEEKLY_HOURS_EXCEEDED']);
  });

  it('puts them back on their contracted hours when the flag is withdrawn', async () => {
    const res = await api.post(`/api/v1/capacity/flags/${flagId}/withdraw`).set(auth(riverside.token));
    expect(res.status).toBe(200);
    expect(codes(await eligibility(riverside, insideShift, bea.id))).toEqual(['WEEKLY_HOURS_EXCEEDED']);
    const weeks = await api.get(`/api/v1/workers/${bea.id}/weeks?from=2026-11-09T00:00:00Z&to=2026-11-23T00:00:00Z`).set(auth(riverside.token));
    expect(weeks.body.map((w: { source: string }) => w.source)).toEqual(['CONTRACT', 'CONTRACT']);
    expect((await api.get('/api/v1/capacity/flags').set(auth(riverside.token))).body.find((f: { id: string }) => f.id === flagId).releasedWorkers).toBe(0);
  });

  it('leaves a figure the employer recorded by hand alone when the flag is withdrawn', async () => {
    const flag = await api.post('/api/v1/capacity/flags').set(auth(riverside.token)).send({ kind: 'SURPLUS', hoursRequested: 40, startsAt: '2026-11-09T00:00:00Z', endsAt: '2026-11-14T00:00:00Z', workerIds: [cara.id], releasedHours: 16 });
    expect(flag.status).toBe(201);
    let week = (await api.get(`/api/v1/workers/${cara.id}/weeks?from=2026-11-09T00:00:00Z&to=2026-11-10T00:00:00Z`).set(auth(riverside.token))).body[0];
    expect(week).toMatchObject({ internalHours: 16, source: 'FLAG' });
    // The manager corrects the figure: the row now belongs to them, not the flag.
    expect((await api.put(`/api/v1/workers/${cara.id}/weeks/2026-11-09`).set(auth(riverside.token)).send({ internalHours: 8 })).status).toBe(200);
    expect((await api.post(`/api/v1/capacity/flags/${flag.body.id}/withdraw`).set(auth(riverside.token))).status).toBe(200);
    week = (await api.get(`/api/v1/workers/${cara.id}/weeks?from=2026-11-09T00:00:00Z&to=2026-11-10T00:00:00Z`).set(auth(riverside.token))).body[0];
    expect(week).toMatchObject({ internalHours: 8, source: 'RECORDED', sourceFlagId: null });
    expect((await api.delete(`/api/v1/workers/${cara.id}/weeks/2026-11-09`).set(auth(riverside.token))).status).toBe(204);
  });
});

describe('bulk recording', () => {
  it('updates several workers for one week', async () => {
    const res = await api.post('/api/v1/workers/week-hours').set(auth(riverside.token)).send({ weekStart: '2026-11-02', entries: [{ workerId: aisha.id, internalHours: 0 }, { workerId: cara.id, internalHours: 8 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ updated: 2 });
    expect((await eligibility(riverside, thisWeekShift, aisha.id)).eligible).toBe(true);
    const cw = await api.get(`/api/v1/workers/${cara.id}/weeks`).set(auth(riverside.token));
    expect(cw.status).toBe(200);
    expect(cw.body).toHaveLength(9); // this week and the eight after it
    expect(cw.body[0]).toMatchObject({ weekStart: '2026-11-02T00:00:00.000Z', internalHours: 8, source: 'RECORDED' });
    expect(cw.body[1]).toMatchObject({ weekStart: '2026-11-09T00:00:00.000Z', internalHours: 37.5, source: 'CONTRACT' });
  });

  it('rejects a foreign or unknown worker without writing anything', async () => {
    const foreign = await api.post('/api/v1/workers/week-hours').set(auth(riverside.token)).send({ weekStart: '2026-11-09', entries: [{ workerId: bea.id, internalHours: 0 }, { workerId: sophie.id, internalHours: 0 }] });
    expect(foreign.status).toBe(403);
    const unknown = await api.post('/api/v1/workers/week-hours').set(auth(riverside.token)).send({ weekStart: '2026-11-09', entries: [{ workerId: 'wrk_nope', internalHours: 0 }] });
    expect(unknown.status).toBe(404);
    const bw = await api.get(`/api/v1/workers/${bea.id}/weeks?from=2026-11-09T00:00:00Z&to=2026-11-10T00:00:00Z`).set(auth(riverside.token));
    expect(bw.body[0].source).toBe('CONTRACT');
    expect((await api.post('/api/v1/workers/week-hours').set(auth(riverside.token)).send({ weekStart: '2026-11-10', entries: [{ workerId: bea.id, internalHours: 0 }] })).status).toBe(422);
    expect((await api.post('/api/v1/workers/week-hours').set(auth(riverside.token)).send({ weekStart: '2026-11-09', entries: [] })).status).toBe(400);
  });

  it('lets the platform admin act for any organisation', async () => {
    const res = await api.post('/api/v1/workers/week-hours').set(auth(agency.token)).send({ weekStart: '2026-11-09', entries: [{ workerId: sophie.id, internalHours: 0 }, { workerId: bea.id, internalHours: 0 }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 2 });
  });
});
