/**
 * The weekly-hours check must count shifts already worked this week (COMPLETED), not only those
 * still CONFIRMED; otherwise a worker who finished three long days by Wednesday looks free for more.
 */
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { addDays, addHours, requiredDocumentsForRole } from '@merge/shared';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations } from '../src/db/client.js';
import { platformSettings, shiftAssignments, shifts } from '../src/db/schema.js';

const clock = new Date('2026-11-02T06:00:00Z'); // Monday morning, London on GMT
const { db } = openDatabase(':memory:');
runMigrations(db);
const { app } = createApp({ db, now: () => clock, channels: [] });
db.update(platformSettings).set({ twoFactorRequiredForManagers: false }).where(eq(platformSettings.id, 'default')).run();
const api = request(app);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

interface Session {
  token: string;
  orgId: string;
}

let agency: Session;
let oakwood: Session;
let riverside: Session;
let siteId: string;
let workerId: string;

async function register(name: string): Promise<Session> {
  const res = await api.post('/api/v1/auth/register').send({
    organisation: { name, postcode: 'M20 2RN', lat: 53.4186, lng: -2.2311 },
    admin: { email: `${name.toLowerCase().replace(/\s+/g, '')}@example.com`, password: 'password123', firstName: 'Admin', lastName: name },
  });
  expect(res.status).toBe(201);
  expect((await api.patch(`/api/v1/organisations/${res.body.organisation.id}`).set(auth(agency.token)).send({ status: 'ACTIVE' })).status).toBe(200);
  return { token: res.body.token, orgId: res.body.organisation.id };
}

async function twelveHourShift(startsAt: Date): Promise<string> {
  const res = await api.post('/api/v1/shifts').set(auth(oakwood.token)).send({ siteId, jobRole: 'CARE_ASSISTANT', title: 'Long day', breakMinutes: 0, chargeRate: 20, publish: true, startsAt: startsAt.toISOString(), endsAt: addHours(startsAt, 12).toISOString() });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect((await api.post(`/api/v1/shifts/${res.body.id}/escalate`).set(auth(oakwood.token)).send({ openToAll: true })).status).toBe(200);
  return res.body.id as string;
}

async function book(shiftId: string): Promise<string> {
  const req = await api.post(`/api/v1/shifts/${shiftId}/requests`).set(auth(riverside.token)).send({ workerId });
  expect(req.status, JSON.stringify(req.body)).toBe(201);
  const confirm = await api.post(`/api/v1/assignments/${req.body.assignment.id}/confirm`).set(auth(oakwood.token)).send({});
  expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);
  return req.body.assignment.id as string;
}

beforeAll(async () => {
  const boot = await api.post('/api/v1/auth/bootstrap').send({
    organisation: { name: 'Merge Staffing', postcode: 'M1 4BT', lat: 53.4794, lng: -2.2453 },
    admin: { email: 'admin@merge.local', password: 'password123', firstName: 'Priya', lastName: 'Shah' },
  });
  expect(boot.status).toBe(201);
  agency = { token: boot.body.token, orgId: boot.body.organisation.id };
  oakwood = await register('Oakwood Care');
  riverside = await register('Riverside Living');
  const site = await api.post(`/api/v1/organisations/${oakwood.orgId}/sites`).set(auth(oakwood.token)).send({ name: 'Oakwood Manor', postcode: 'M20 2RN', lat: 53.4186, lng: -2.2311 });
  expect(site.status).toBe(201);
  siteId = site.body.id;
  const worker = await api.post('/api/v1/workers').set(auth(riverside.token)).send({ firstName: 'Tariq', lastName: 'Wright', jobRole: 'CARE_ASSISTANT', skills: ['MOVING_AND_HANDLING', 'DEMENTIA'], shareable: true, contractedHoursPerWeek: 0, maxHoursPerWeek: 48, lat: 53.41, lng: -2.16, travelRadiusKm: 40 });
  expect(worker.status, JSON.stringify(worker.body)).toBe(201);
  workerId = worker.body.id;
  for (const type of requiredDocumentsForRole('CARE_ASSISTANT')) {
    const doc = await api.post(`/api/v1/workers/${workerId}/documents`).set(auth(riverside.token)).send({ type, expiresAt: addDays(clock, 400).toISOString() });
    expect(doc.status).toBe(201);
    expect((await api.patch(`/api/v1/workers/${workerId}/documents/${doc.body.id}`).set(auth(riverside.token)).send({ verified: true })).status).toBe(200);
  }
});

describe('shifts already worked this week count towards the 48-hour limit', () => {
  it('refuses a fifth long day once two of four bookings have been worked', async () => {
    const days = [3, 4, 5, 6].map((d) => new Date(`2026-11-0${d}T08:00:00Z`)); // Tue–Fri of the same ISO week
    const assignmentIds: string[] = [];
    for (const day of days) assignmentIds.push(await book(await twelveHourShift(day)));

    // Tuesday and Wednesday have been worked: the scheduler would move them to COMPLETED.
    const worked = assignmentIds.slice(0, 2);
    db.update(shiftAssignments).set({ status: 'COMPLETED' }).where(inArray(shiftAssignments.id, worked)).run();
    const workedShiftIds = db.select({ shiftId: shiftAssignments.shiftId }).from(shiftAssignments).where(inArray(shiftAssignments.id, worked)).all().map((r) => r.shiftId);
    db.update(shifts).set({ status: 'COMPLETED' }).where(inArray(shifts.id, workedShiftIds)).run();

    const saturday = await twelveHourShift(new Date('2026-11-07T08:00:00Z'));
    const list = await api.get(`/api/v1/shifts/${saturday}/eligible-workers`).set(auth(riverside.token));
    expect(list.status).toBe(200);
    const row = (list.body.workers as Array<{ id: string; eligible: boolean; blockers: { code: string }[]; facts: { weeklyHoursAfter: number } }>).find((w) => w.id === workerId)!;
    expect(row.eligible).toBe(false);
    expect(row.blockers.map((b) => b.code)).toContain('WEEKLY_HOURS_EXCEEDED');
    expect(row.facts.weeklyHoursAfter).toBe(60);

    const req = await api.post(`/api/v1/shifts/${saturday}/requests`).set(auth(riverside.token)).send({ workerId });
    expect(req.status).toBe(422);
  });

  it('still allows the next week', async () => {
    const monday = await twelveHourShift(new Date('2026-11-09T08:00:00Z'));
    const req = await api.post(`/api/v1/shifts/${monday}/requests`).set(auth(riverside.token)).send({ workerId });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
  });
});
