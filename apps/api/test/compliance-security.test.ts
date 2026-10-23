import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, addMinutes } from '@merge/shared';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations } from '../src/db/client.js';
import { notifications, users, workerDocuments } from '../src/db/schema.js';
import { LocalDiskStorage, setStorage } from '../src/lib/storage.js';
import { totpCode, verifyTotp } from '../src/lib/totp.js';

const T0 = new Date('2026-11-02T08:00:00Z');
let clock = T0;
const { db } = openDatabase(':memory:');
runMigrations(db);
const { app } = createApp({ db, now: () => clock, channels: [] });
const api = request(app);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const filesDir = mkdtempSync(join(tmpdir(), 'merge-files-'));
setStorage(new LocalDiskStorage(filesDir));
afterAll(() => rmSync(filesDir, { recursive: true, force: true }));

/** Enrol an authenticator for the signed-in user and return the secret. */
async function enrol(token: string): Promise<string> {
  const setup = await api.post('/api/v1/auth/2fa/setup').set(auth(token));
  expect(setup.status).toBe(200);
  expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
  const enable = await api.post('/api/v1/auth/2fa/enable').set(auth(token)).send({ code: totpCode(setup.body.secret, clock) });
  expect(enable.status).toBe(200);
  return setup.body.secret as string;
}

let agency = { token: '', orgId: '', userId: '', secret: '' };
let willow = { token: '', orgId: '', userId: '' }; // registered with CQC + MOU
let ashby = { token: '', orgId: '', userId: '' }; // registered without either

beforeAll(async () => {
  const boot = await api.post('/api/v1/auth/bootstrap').send({ organisation: { name: 'Merge Staffing', postcode: 'M1 4BT' }, admin: { email: 'owner@merge.example', password: 'Owner-Pass-2026', firstName: 'Priya', lastName: 'Shah' } });
  expect(boot.status).toBe(201);
  agency = { token: boot.body.token, orgId: boot.body.organisation.id, userId: boot.body.user.id, secret: '' };
  expect(boot.body.organisation.mouAcceptedAt).toBeTruthy();
});

describe('two-factor gate, enrolment and lockout', () => {
  it('blocks a manager without an authenticator from everything except /me and 2FA set-up', async () => {
    const blocked = await api.get('/api/v1/admin/settings').set(auth(agency.token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.details.code).toBe('TWO_FACTOR_REQUIRED');
    const me = await api.get('/api/v1/auth/me').set(auth(agency.token));
    expect(me.status).toBe(200);
    expect(me.body.security).toEqual({ twoFactorSetupRequired: true, passwordChangeRequired: false });
    expect(me.body.user.twoFactorEnabled).toBe(false);
    expect(me.body.user.passwordHash).toBeUndefined();
    expect(me.body.user.totpSecret).toBeUndefined();
  });

  it('enrols with a valid code and then opens the platform', async () => {
    const setup = await api.post('/api/v1/auth/2fa/setup').set(auth(agency.token));
    expect(setup.status).toBe(200);
    const wrong = await api.post('/api/v1/auth/2fa/enable').set(auth(agency.token)).send({ code: '000000' });
    expect(wrong.status).toBe(400);
    const ok = await api.post('/api/v1/auth/2fa/enable').set(auth(agency.token)).send({ code: totpCode(setup.body.secret, clock) });
    expect(ok.status).toBe(200);
    agency.secret = setup.body.secret;
    expect((await api.get('/api/v1/admin/settings').set(auth(agency.token))).status).toBe(200);
    const me = await api.get('/api/v1/auth/me').set(auth(agency.token));
    expect(me.body.security.twoFactorSetupRequired).toBe(false);
    expect(me.body.user.twoFactorEnabled).toBe(true);
  });

  it('turns login into a two-step challenge once enabled', async () => {
    const first = await api.post('/api/v1/auth/login').send({ email: 'owner@merge.example', password: 'Owner-Pass-2026' });
    expect(first.status).toBe(200);
    expect(first.body.twoFactorRequired).toBe(true);
    expect(first.body.token).toBeUndefined();
    // The challenge token is not a session token.
    expect((await api.get('/api/v1/auth/me').set(auth(first.body.challengeToken))).status).toBe(401);
    const bad = await api.post('/api/v1/auth/2fa/verify').send({ challengeToken: first.body.challengeToken, code: '123456' });
    expect(bad.status).toBe(401);
    // A code from the previous 30-second step is still accepted (clock drift).
    const good = await api.post('/api/v1/auth/2fa/verify').send({ challengeToken: first.body.challengeToken, code: totpCode(agency.secret, clock, -1) });
    expect(good.status).toBe(200);
    expect(good.body.token).toBeTruthy();
    expect((await api.get('/api/v1/admin/overview').set(auth(good.body.token))).status).toBe(200);
    expect(verifyTotp(agency.secret, totpCode(agency.secret, clock, 2), clock)).toBe(false);
  });

  it('locks the account after five wrong passwords and releases it after fifteen minutes', async () => {
    for (let i = 0; i < 4; i++) expect((await api.post('/api/v1/auth/login').send({ email: 'owner@merge.example', password: 'nope' })).status).toBe(401);
    expect((await api.post('/api/v1/auth/login').send({ email: 'owner@merge.example', password: 'nope' })).status).toBe(401);
    const locked = await api.post('/api/v1/auth/login').send({ email: 'owner@merge.example', password: 'Owner-Pass-2026' });
    expect(locked.status).toBe(423);
    clock = addMinutes(clock, 16);
    const again = await api.post('/api/v1/auth/login').send({ email: 'owner@merge.example', password: 'Owner-Pass-2026' });
    expect(again.status).toBe(200);
    expect(again.body.twoFactorRequired).toBe(true);
    const row = db.select({ failedLoginCount: users.failedLoginCount, lockedUntil: users.lockedUntil }).from(users).where(eq(users.id, agency.userId)).get();
    expect(row?.lockedUntil).toBeNull();
  });

  it('can be switched off by the platform and disabled per user with a code', async () => {
    const settings = await api.patch('/api/v1/admin/settings').set(auth(agency.token)).send({ twoFactorRequiredForManagers: false });
    expect(settings.status).toBe(200);
    expect(settings.body.twoFactorRequiredForManagers).toBe(false);
    expect((await api.post('/api/v1/auth/2fa/disable').set(auth(agency.token)).send({ code: '000000' })).status).toBe(400);
    expect((await api.post('/api/v1/auth/2fa/disable').set(auth(agency.token)).send({ code: totpCode(agency.secret, clock) })).status).toBe(200);
    const login = await api.post('/api/v1/auth/login').send({ email: 'owner@merge.example', password: 'Owner-Pass-2026' });
    expect(login.body.token).toBeTruthy();
    agency.token = login.body.token;
  });

  it('forces a temporary-password holder to change it first', async () => {
    db.update(users).set({ mustChangePassword: true }).where(eq(users.id, agency.userId)).run();
    const blocked = await api.get('/api/v1/admin/settings').set(auth(agency.token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.details.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await api.get('/api/v1/auth/me').set(auth(agency.token))).body.security.passwordChangeRequired).toBe(true);
    db.update(users).set({ mustChangePassword: false }).where(eq(users.id, agency.userId)).run();
    expect((await api.get('/api/v1/admin/settings').set(auth(agency.token))).status).toBe(200);
  });
});

describe('registration, the MOU and approval', () => {
  it('publishes the MOU without a login', async () => {
    const res = await api.get('/api/v1/organisations/mou');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('1.0');
    expect(res.body.sections.length).toBeGreaterThanOrEqual(5);
    expect(res.body.text).toContain('Care Quality Commission');
  });

  it('records CQC number and MOU acceptance at registration', async () => {
    const reg = await api.post('/api/v1/auth/register').send({ organisation: { name: 'Willow Care', postcode: 'M20 2RN', cqcRegistrationNumber: '1-100200300' }, mouAccepted: true, admin: { email: 'admin@willow.example', password: 'Willow-Pass-2026', firstName: 'Tom', lastName: 'Reed' } });
    expect(reg.status).toBe(201);
    expect(reg.body.organisation.status).toBe('PENDING');
    expect(reg.body.organisation.mouAcceptedAt).toBeTruthy();
    expect(reg.body.organisation.mouVersion).toBe('1.0');
    expect(reg.body.organisation.mouAcceptedByUserId).toBe(reg.body.user.id);
    willow = { token: reg.body.token, orgId: reg.body.organisation.id, userId: reg.body.user.id };

    const reg2 = await api.post('/api/v1/auth/register').send({ organisation: { name: 'Ashby Homes', postcode: 'SK4 1AB' }, admin: { email: 'admin@ashby.example', password: 'Ashby-Pass-2026', firstName: 'Una', lastName: 'Lee' } });
    expect(reg2.status).toBe(201);
    expect(reg2.body.organisation.mouAcceptedAt).toBeNull();
    ashby = { token: reg2.body.token, orgId: reg2.body.organisation.id, userId: reg2.body.user.id };
  });

  it('lists the approval queue with what is missing', async () => {
    const queue = await api.get('/api/v1/admin/organisations?status=PENDING').set(auth(agency.token));
    expect(queue.status).toBe(200);
    const w = queue.body.find((o: { id: string }) => o.id === willow.orgId);
    const a = queue.body.find((o: { id: string }) => o.id === ashby.orgId);
    expect(w.blockers).toEqual([]);
    expect(a.blockers).toHaveLength(2);
    expect(a.admin.email).toBe('admin@ashby.example');
    expect((await api.get('/api/v1/admin/organisations').set(auth(willow.token))).status).toBe(403);
  });

  it('approves a complete organisation and notifies it', async () => {
    const res = await api.post(`/api/v1/organisations/${willow.orgId}/approve`).set(auth(agency.token)).send({ note: 'CQC checked on the register' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACTIVE');
    const note = db.select().from(notifications).where(eq(notifications.orgId, willow.orgId)).all();
    expect(note.some((n) => n.title.includes('approved'))).toBe(true);
    expect((await api.post(`/api/v1/organisations/${willow.orgId}/approve`).set(auth(agency.token)).send({})).status).toBe(409);
    expect((await api.post(`/api/v1/organisations/${ashby.orgId}/approve`).set(auth(willow.token)).send({})).status).toBe(403);
  });

  it('refuses an incomplete organisation unless overridden, and audits the override', async () => {
    const refused = await api.post(`/api/v1/organisations/${ashby.orgId}/approve`).set(auth(agency.token)).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.details.blockers).toHaveLength(2);
    const status = await api.get(`/api/v1/organisations/${ashby.orgId}/approval`).set(auth(ashby.token));
    expect(status.body.blockers).toHaveLength(2);
    // Accepting the MOU after the event clears one blocker.
    expect((await api.post(`/api/v1/organisations/${ashby.orgId}/mou/accept`).set(auth(ashby.token))).status).toBe(200);
    expect((await api.get(`/api/v1/organisations/${ashby.orgId}/approval`).set(auth(ashby.token))).body.blockers).toHaveLength(1);
    const overridden = await api.post(`/api/v1/organisations/${ashby.orgId}/approve`).set(auth(agency.token)).send({ override: true, note: 'Regulator registration pending; evidence by email' });
    expect(overridden.status).toBe(200);
    const audit = await api.get(`/api/v1/admin/audit?entityType=organisation&entityId=${ashby.orgId}`).set(auth(agency.token));
    const entry = audit.body.find((a: { action: string; data: { override?: boolean } }) => a.action === 'APPROVE' && a.data?.override);
    expect(entry).toBeDefined();
    expect(entry.data.overriddenBlockers).toHaveLength(1);
    expect(entry.actor.email).toBe('owner@merge.example');
  });

  it('lets an admin set how unfilled shifts escalate', async () => {
    const res = await api.patch(`/api/v1/organisations/${willow.orgId}`).set(auth(willow.token)).send({ escalationMode: 'AUTO', escalationCeilingPct: 15 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ escalationMode: 'AUTO', escalationCeilingPct: 15 });
    expect((await api.patch(`/api/v1/organisations/${willow.orgId}`).set(auth(willow.token)).send({ status: 'SUSPENDED' })).status).toBe(403);
  });
});

describe('site scoping and home sites', () => {
  let siteA = '';
  let siteB = '';
  let manager = { token: '', userId: '' };
  let workerA = '';
  let workerB = '';
  let workerNone = '';

  beforeAll(async () => {
    siteA = (await api.post(`/api/v1/organisations/${willow.orgId}/sites`).set(auth(willow.token)).send({ name: 'Willow House', postcode: 'M20 2RN' })).body.id;
    siteB = (await api.post(`/api/v1/organisations/${willow.orgId}/sites`).set(auth(willow.token)).send({ name: 'Willow Lodge', postcode: 'M21 9AA' })).body.id;
    workerA = (await api.post('/api/v1/workers').set(auth(willow.token)).send({ firstName: 'Ann', lastName: 'A', jobRole: 'CARE_ASSISTANT', homeSiteId: siteA, hourlyPayRate: 13.5, notes: 'private' })).body.id;
    workerB = (await api.post('/api/v1/workers').set(auth(willow.token)).send({ firstName: 'Ben', lastName: 'B', jobRole: 'CARE_ASSISTANT', homeSiteId: siteB })).body.id;
    workerNone = (await api.post('/api/v1/workers').set(auth(willow.token)).send({ firstName: 'Cal', lastName: 'C', jobRole: 'CARE_ASSISTANT' })).body.id;
  });

  it('rejects a home site that belongs to another organisation or an admin limited to sites', async () => {
    expect((await api.post('/api/v1/workers').set(auth(ashby.token)).send({ firstName: 'X', lastName: 'Y', jobRole: 'CARE_ASSISTANT', homeSiteId: siteA })).status).toBe(404);
    expect((await api.post(`/api/v1/organisations/${willow.orgId}/users`).set(auth(willow.token)).send({ email: 'a@willow.example', password: 'Admin-Pass-2026', firstName: 'A', lastName: 'B', role: 'ORG_ADMIN', siteIds: [siteA] })).status).toBe(409);
    expect((await api.post(`/api/v1/organisations/${willow.orgId}/users`).set(auth(willow.token)).send({ email: 'a@willow.example', password: 'Admin-Pass-2026', firstName: 'A', lastName: 'B', role: 'ORG_MANAGER', siteIds: ['site_nope'] })).status).toBe(404);
  });

  it('limits a site manager to their site, unassigned workers included, without pay data', async () => {
    const created = await api.post(`/api/v1/organisations/${willow.orgId}/users`).set(auth(willow.token)).send({ email: 'house@willow.example', password: 'House-Pass-2026', firstName: 'Hana', lastName: 'House', role: 'ORG_MANAGER', siteIds: [siteA] });
    expect(created.status).toBe(201);
    expect(created.body.siteIds).toEqual([siteA]);
    const login = await api.post('/api/v1/auth/login').send({ email: 'house@willow.example', password: 'House-Pass-2026' });
    manager = { token: login.body.token, userId: created.body.id };

    const sites = await api.get(`/api/v1/organisations/${willow.orgId}/sites`).set(auth(manager.token));
    expect(sites.body.map((s: { id: string }) => s.id)).toEqual([siteA]);
    const list = await api.get('/api/v1/workers').set(auth(manager.token));
    expect(list.status).toBe(200);
    const ids = list.body.map((w: { id: string }) => w.id).sort();
    expect(ids).toEqual([workerA, workerNone].sort());
    const ann = list.body.find((w: { id: string }) => w.id === workerA);
    expect(ann.hourlyPayRate).toBeUndefined();
    expect(ann.notes).toBeUndefined();
    expect(ann.homeSiteName).toBe('Willow House');
    expect((await api.get(`/api/v1/workers/${workerB}`).set(auth(manager.token))).status).toBe(403);
    expect((await api.get(`/api/v1/workers/${workerA}`).set(auth(manager.token))).body.hourlyPayRate).toBeUndefined();
    expect((await api.get(`/api/v1/workers/${workerA}`).set(auth(willow.token))).body.hourlyPayRate).toBe(13.5);
    expect((await api.patch(`/api/v1/workers/${workerA}`).set(auth(manager.token)).send({ homeSiteId: siteB })).status).toBe(403);
    expect((await api.patch(`/api/v1/workers/${workerNone}`).set(auth(manager.token)).send({ homeSiteId: siteA })).status).toBe(200);
    expect((await api.post(`/api/v1/organisations/${willow.orgId}/sites`).set(auth(manager.token)).send({ name: 'New', postcode: 'M1 1AA' })).status).toBe(403);
    expect((await api.patch(`/api/v1/organisations/${willow.orgId}/sites/${siteB}`).set(auth(manager.token)).send({ name: 'Renamed' })).status).toBe(403);
    expect((await api.patch(`/api/v1/organisations/${willow.orgId}/sites/${siteA}`).set(auth(manager.token)).send({ accessNotes: 'Ring the bell' })).status).toBe(200);
    expect((await api.get('/api/v1/workers?siteId=' + siteA).set(auth(willow.token))).body).toHaveLength(2);
  });

  it('lifts the limit when the admin clears the site list', async () => {
    const res = await api.patch(`/api/v1/organisations/${willow.orgId}/users/${manager.userId}`).set(auth(willow.token)).send({ siteIds: null });
    expect(res.status).toBe(200);
    expect(res.body.siteIds).toBeNull();
    expect((await api.get('/api/v1/workers').set(auth(manager.token))).body).toHaveLength(3);
    await api.patch(`/api/v1/organisations/${willow.orgId}/users/${manager.userId}`).set(auth(willow.token)).send({ siteIds: [siteA] });
  });
});

describe('documents: self-upload, files, immutability and reports', () => {
  let workerId = '';
  let workerToken = '';
  let dbsId = '';
  let selfDocId = '';

  beforeAll(async () => {
    workerId = (await api.post('/api/v1/workers').set(auth(willow.token)).send({ firstName: 'Dee', lastName: 'Docs', jobRole: 'CARE_ASSISTANT' })).body.id;
    const login = await api.post(`/api/v1/workers/${workerId}/login`).set(auth(willow.token)).send({ email: 'dee@willow.example', password: 'Dee-Pass-2026' });
    expect(login.status).toBe(201);
    workerToken = (await api.post('/api/v1/auth/login').send({ email: 'dee@willow.example', password: 'Dee-Pass-2026' })).body.token;
    const dbs = await api.post(`/api/v1/workers/${workerId}/documents`).set(auth(willow.token)).send({ type: 'DBS', reference: '001234567890', expiresAt: addDays(clock, 400).toISOString() });
    dbsId = dbs.body.id;
    expect((await api.patch(`/api/v1/workers/${workerId}/documents/${dbsId}`).set(auth(willow.token)).send({ verified: true })).status).toBe(200);
  });

  it('lets the worker add their own document, unverified, and see it', async () => {
    const res = await api.post(`/api/v1/workers/${workerId}/documents`).set(auth(workerToken)).send({ type: 'SAFEGUARDING_TRAINING', expiresAt: addDays(clock, 20).toISOString() });
    expect(res.status).toBe(201);
    expect(res.body.verifiedAt).toBeNull();
    expect(res.body.uploadedByUserId).toBeTruthy();
    selfDocId = res.body.id;
    expect((await api.patch(`/api/v1/workers/${workerId}/documents/${selfDocId}`).set(auth(workerToken)).send({ verified: true })).status).toBe(403);
    const mine = await api.get('/api/v1/compliance/my-documents').set(auth(workerToken));
    expect(mine.status).toBe(200);
    expect(mine.body.documents).toHaveLength(2);
    expect((await api.get(`/api/v1/workers/${workerId}`).set(auth(ashby.token))).status).toBe(403);
  });

  it('stores and serves a scanned file for employer and worker only', async () => {
    const pdf = Buffer.from('%PDF-1.4\n%fake\n');
    const up = await api.post(`/api/v1/workers/${workerId}/documents/${dbsId}/file`).set(auth(workerToken)).attach('file', pdf, { filename: 'dbs.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    expect(up.body.hasFile).toBe(true);
    expect(up.body.fileName).toBe('dbs.pdf');
    expect(up.body.fileKey).toBeUndefined();
    const down = await api.get(`/api/v1/workers/${workerId}/documents/${dbsId}/file`).set(auth(willow.token));
    expect(down.status).toBe(200);
    expect(down.headers['content-type']).toContain('application/pdf');
    expect(Buffer.from(down.body as Buffer).toString()).toContain('%PDF-1.4');
    expect((await api.get(`/api/v1/workers/${workerId}/documents/${dbsId}/file`).set(auth(ashby.token))).status).toBe(403);
    expect((await api.post(`/api/v1/workers/${workerId}/documents/${dbsId}/file`).set(auth(willow.token)).attach('file', Buffer.from('x'), { filename: 'x.exe', contentType: 'application/octet-stream' })).status).toBe(415);
    expect((await api.post(`/api/v1/workers/${workerId}/documents/${dbsId}/file`).set(auth(willow.token)).attach('file', Buffer.alloc(10 * 1024 * 1024 + 1), { filename: 'big.png', contentType: 'image/png' })).status).toBe(413);
  });

  it('keeps a verified document immutable: corrections create a replacement', async () => {
    const res = await api.patch(`/api/v1/workers/${workerId}/documents/${dbsId}`).set(auth(willow.token)).send({ expiresAt: addDays(clock, 800).toISOString(), reference: '009876543210' });
    expect(res.status).toBe(200);
    expect(res.body.id).not.toBe(dbsId);
    expect(res.body.replacesDocumentId).toBe(dbsId);
    expect(res.body.verifiedAt).toBeNull();
    expect(res.body.hasFile).toBe(true); // the scan carries over
    const old = db.select().from(workerDocuments).where(eq(workerDocuments.id, dbsId)).get();
    expect(old?.supersededAt).toBeTruthy();
    expect(old?.reference).toBe('001234567890');
    const detail = await api.get(`/api/v1/workers/${workerId}`).set(auth(willow.token));
    // The replacement is unverified, so the DBS no longer counts until it is checked again.
    expect(detail.body.compliance.items.find((i: { type: string }) => i.type === 'DBS').status).toBe('PENDING_VERIFICATION');
    expect((await api.patch(`/api/v1/workers/${workerId}/documents/${dbsId}`).set(auth(willow.token)).send({ notes: 'late edit' })).status).toBe(409);
    expect((await api.delete(`/api/v1/workers/${workerId}/documents/${res.body.id}`).set(auth(willow.token))).status).toBe(204);
    expect((await api.patch(`/api/v1/workers/${workerId}/documents/${selfDocId}`).set(auth(willow.token)).send({ verified: true })).status).toBe(200);
    expect((await api.delete(`/api/v1/workers/${workerId}/documents/${selfDocId}`).set(auth(willow.token))).status).toBe(409);
    expect((await api.patch(`/api/v1/workers/${workerId}/documents/${selfDocId}`).set(auth(willow.token)).send({ notes: 'checked the certificate' })).body.id).toBe(selfDocId);
  });

  it('reports expiring documents, the verification queue and a summary', async () => {
    await api.post(`/api/v1/workers/${workerId}/documents`).set(auth(willow.token)).send({ type: 'RIGHT_TO_WORK', expiresAt: addDays(clock, 45).toISOString() });
    const expiring = await api.get('/api/v1/compliance/expiring?days=60').set(auth(willow.token));
    expect(expiring.status).toBe(200);
    expect(expiring.body.map((e: { document: { type: string } }) => e.document.type).sort()).toEqual(['RIGHT_TO_WORK', 'SAFEGUARDING_TRAINING']);
    expect(expiring.body[0].worker.firstName).toBe('Dee');
    expect(expiring.body[0].daysLeft).toBe(20);
    expect((await api.get('/api/v1/compliance/expiring?days=10').set(auth(willow.token))).body).toHaveLength(0);
    const queue = await api.get('/api/v1/compliance/verification-queue').set(auth(willow.token));
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0].document.type).toBe('RIGHT_TO_WORK');
    const summary = await api.get('/api/v1/compliance/summary').set(auth(willow.token));
    expect(summary.status).toBe(200);
    expect(summary.body.documents.awaitingVerification).toBe(1);
    expect(summary.body.workers.total).toBe(4);
    expect(summary.body.workers.nonCompliant).toBe(4);
    const bulk = await api.post('/api/v1/compliance/verify').set(auth(willow.token)).send({ documentIds: [queue.body[0].document.id, 'doc_missing'] });
    expect(bulk.status).toBe(200);
    expect(bulk.body.verified).toHaveLength(1);
    expect(bulk.body.skipped).toEqual([{ id: 'doc_missing', reason: 'not found' }]);
    expect((await api.post('/api/v1/compliance/verify').set(auth(ashby.token)).send({ documentIds: [queue.body[0].document.id] })).status).toBe(403);
    expect((await api.get('/api/v1/compliance/verification-queue').set(auth(willow.token))).body).toHaveLength(0);
    expect((await api.get('/api/v1/compliance/summary').set(auth(workerToken))).status).toBe(403);
  });
});

describe('host requirements', () => {
  let induction = '';
  let training = '';
  let workerId = '';

  it('lets a host define requirements and other managers read them', async () => {
    const t = await api.post('/api/v1/compliance/requirements').set(auth(ashby.token)).send({ name: 'PEG feeding training', description: 'Certificate within 2 years' });
    expect(t.status).toBe(201);
    training = t.body.id;
    const i = await api.post('/api/v1/compliance/requirements').set(auth(ashby.token)).send({ name: 'Ashby site induction', recordedByHost: true });
    induction = i.body.id;
    const seen = await api.get(`/api/v1/compliance/requirements?hostOrgId=${ashby.orgId}`).set(auth(willow.token));
    expect(seen.status).toBe(200);
    expect(seen.body.map((r: { name: string }) => r.name).sort()).toEqual(['Ashby site induction', 'PEG feeding training']);
    expect(seen.body[0].own).toBe(false);
    expect((await api.patch(`/api/v1/compliance/requirements/${training}`).set(auth(willow.token)).send({ name: 'x' })).status).toBe(403);
  });

  it('employers declare employer-type requirements; hosts record their own', async () => {
    workerId = (await api.get('/api/v1/workers').set(auth(willow.token))).body[0].id;
    const declared = await api.post(`/api/v1/compliance/requirements/${training}/workers`).set(auth(willow.token)).send({ workerId, expiresAt: addDays(clock, 300).toISOString() });
    expect(declared.status).toBe(201);
    expect(declared.body.name).toBe('PEG feeding training');
    expect((await api.post(`/api/v1/compliance/requirements/${induction}/workers`).set(auth(willow.token)).send({ workerId })).status).toBe(403);
    expect((await api.post(`/api/v1/compliance/requirements/${training}/workers`).set(auth(ashby.token)).send({ workerId })).status).toBe(403);
    expect((await api.post(`/api/v1/compliance/requirements/${induction}/workers`).set(auth(ashby.token)).send({ workerId })).status).toBe(201);
    const detail = await api.get(`/api/v1/workers/${workerId}`).set(auth(willow.token));
    expect(detail.body.hostRequirements).toHaveLength(2);
    expect(detail.body.hostRequirements.map((r: { hostName: string }) => r.hostName)).toEqual(['Ashby Homes', 'Ashby Homes']);
    const holders = await api.get(`/api/v1/compliance/requirements/${training}/workers`).set(auth(ashby.token));
    expect(holders.body).toHaveLength(1);
    expect(holders.body[0].orgName).toBe('Willow Care');
    // Re-declaring updates rather than duplicates.
    expect((await api.post(`/api/v1/compliance/requirements/${training}/workers`).set(auth(willow.token)).send({ workerId })).status).toBe(200);
    expect((await api.delete(`/api/v1/compliance/requirements/${training}/workers/${workerId}`).set(auth(willow.token))).status).toBe(204);
    expect((await api.get(`/api/v1/workers/${workerId}`).set(auth(willow.token))).body.hostRequirements).toHaveLength(1);
  });

  it('archives a requirement instead of deleting its history', async () => {
    expect((await api.delete(`/api/v1/compliance/requirements/${training}`).set(auth(ashby.token))).status).toBe(204);
    expect((await api.get(`/api/v1/compliance/requirements?hostOrgId=${ashby.orgId}`).set(auth(willow.token))).body).toHaveLength(1);
    expect((await api.get('/api/v1/compliance/requirements?includeArchived=true').set(auth(ashby.token))).body).toHaveLength(2);
    expect((await api.post(`/api/v1/compliance/requirements/${training}/workers`).set(auth(willow.token)).send({ workerId })).status).toBe(409);
  });
});

describe('audit by user', () => {
  it('filters the organisation and platform audit logs by actor', async () => {
    const org = await api.get(`/api/v1/organisations/${willow.orgId}/audit?userId=${willow.userId}`).set(auth(willow.token));
    expect(org.status).toBe(200);
    expect(org.body.length).toBeGreaterThan(0);
    expect(org.body.every((a: { actorUserId: string }) => a.actorUserId === willow.userId)).toBe(true);
    expect(org.body[0].actor.email).toBe('admin@willow.example');
    expect((await api.get(`/api/v1/organisations/${willow.orgId}/audit`).set(auth(ashby.token))).status).toBe(403);
    const platform = await api.get(`/api/v1/admin/audit?userId=${ashby.userId}&from=${T0.toISOString()}`).set(auth(agency.token));
    expect(platform.status).toBe(200);
    expect(platform.body.every((a: { actorUserId: string }) => a.actorUserId === ashby.userId)).toBe(true);
    const people = await api.get('/api/v1/admin/users?q=willow').set(auth(agency.token));
    expect(people.body.map((u: { email: string }) => u.email)).toContain('admin@willow.example');
  });
});
