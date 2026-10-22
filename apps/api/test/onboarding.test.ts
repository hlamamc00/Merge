import ExcelJS from 'exceljs';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, addHours } from '@merge/shared';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations } from '../src/db/client.js';
import { notificationPreferences, outboundMessages, platformSettings } from '../src/db/schema.js';
import { ensureSettings } from '../src/services/settings.js';
import { Notifier } from '../src/lib/notify.js';
import { drainOutbox, runDigest } from '../src/services/delivery.js';
import { silentChannels } from '../src/services/mail.js';

const T0 = new Date('2026-11-02T08:00:00Z');
let clock = T0;
const { db } = openDatabase(':memory:');
runMigrations(db);
const { app } = createApp({ db, now: () => clock, channels: [] });
const api = request(app);
// Two-factor set-up is exercised by the security suite; here managers act without it.
ensureSettings(db, T0);
db.update(platformSettings).set({ twoFactorRequiredForManagers: false }).run();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

let agencyToken = '';
let adminToken = '';
let managerToken = '';
let orgId = '';
const emails = () => db.select().from(outboundMessages).where(eq(outboundMessages.channel, 'EMAIL')).all();
const linkToken = (body: string, path: string) => body.match(new RegExp(`${path}/([A-Za-z0-9_-]+)`))?.[1] ?? '';

beforeAll(async () => {
  const boot = await api.post('/api/v1/auth/bootstrap').send({ organisation: { name: 'Merge Staffing', postcode: 'M1 4BT' }, admin: { email: 'owner@merge.example', password: 'Owner-Pass-2026', firstName: 'Priya', lastName: 'Shah' } });
  agencyToken = boot.body.token;
  const reg = await api.post('/api/v1/auth/register').send({ organisation: { name: 'Import Co', postcode: 'M20 2RN', lat: 53.41, lng: -2.23, cqcRegistrationNumber: '1-123456789' }, mouAccepted: true, admin: { email: 'admin@importco.example', password: 'Admin-Pass-2026', firstName: 'Grace', lastName: 'Okafor' } });
  expect(reg.status).toBe(201);
  adminToken = reg.body.token;
  orgId = reg.body.organisation.id;
  await api.patch(`/api/v1/organisations/${orgId}`).set(auth(agencyToken)).send({ status: 'ACTIVE' });
  await api.post(`/api/v1/organisations/${orgId}/sites`).set(auth(adminToken)).send({ name: 'Main home', postcode: 'M20 2RN', lat: 53.41, lng: -2.23 });
  const mgr = await api.post(`/api/v1/organisations/${orgId}/users`).set(auth(adminToken)).send({ email: 'rota@importco.example', password: 'Rota-Pass-2026', firstName: 'Liam', lastName: 'Hughes', role: 'ORG_MANAGER' });
  expect(mgr.status).toBe(201);
  managerToken = (await api.post('/api/v1/auth/login').send({ email: 'rota@importco.example', password: 'Rota-Pass-2026' })).body.token;
});

const CSV = [
  'firstName,lastName,email,phone,jobRole,skills,contractedHoursPerWeek,homeSite,shareable,verified,invite,DBS_reference,DBS_expiresAt,RIGHT_TO_WORK_reference,RIGHT_TO_WORK_expiresAt',
  'Aisha,Begum,aisha@importco.example,07700 900123,CARE_ASSISTANT,MOVING_AND_HANDLING;DEMENTIA,30,Main home,yes,yes,yes,DBS-1,2028-01-31,RTW-1,31/12/2027',
  '"Connor, Jr",Byrne,,,Senior carer,medication,24,,no,no,no,,,,',
  'Dr,Who,who@importco.example,,DOCTOR,,,,,,,,,,',
  'Nadia,Osei,nadia@importco.example,,CARE_ASSISTANT,,30,Nowhere House,,,yes,,,,',
].join('\n');

describe('bulk import', () => {
  let jobId = '';

  it('serves a template and previews a CSV with row-level errors', async () => {
    const tpl = await api.get('/api/v1/onboarding/import/template.csv').set(auth(adminToken));
    expect(tpl.status).toBe(200);
    expect(tpl.headers['content-type']).toMatch(/text\/csv/);
    expect(tpl.text.split('\n')[0]).toContain('firstName');
    expect(tpl.text.split('\n')[0]).toContain('DBS_reference');

    const preview = await api.post('/api/v1/onboarding/import/preview').set(auth(managerToken)).send({ fileName: 'staff.csv', contentBase64: b64(CSV) });
    expect(preview.status).toBe(200);
    expect(preview.body.totalRows).toBe(4);
    expect(preview.body.validRows).toBe(2);
    expect(preview.body.invitable).toBe(1);
    expect(preview.body.errors.map((e: { row: number }) => e.row)).toEqual([4, 5]);
    expect(preview.body.errors[0].message).toMatch(/jobRole/);
    expect(preview.body.errors[1].message).toMatch(/not one of your sites/);
    expect(preview.body.sample[0]).toMatchObject({ name: 'Aisha Begum', jobRole: 'CARE_ASSISTANT', documents: 2, invite: true });
    expect(preview.body.sample[1]).toMatchObject({ name: 'Connor, Jr Byrne', jobRole: 'SENIOR_CARER' });
    jobId = preview.body.jobId;
  });

  it('applies the import, creating workers and documents and inviting by email', async () => {
    const before = emails().length;
    const res = await api.post(`/api/v1/onboarding/import/${jobId}/apply`).set(auth(managerToken)).send({ fileName: 'staff.csv', contentBase64: b64(CSV), invite: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 2, updated: 0, invited: 1, documents: 2, failed: 2 });
    const workers = (await api.get('/api/v1/workers').set(auth(adminToken))).body as Array<{ firstName: string; homeSiteId: string | null; skills: string[]; compliance: { items: Array<{ type: string; status: string }> } }>;
    const aisha = workers.find((w) => w.firstName === 'Aisha')!;
    expect(aisha.homeSiteId).not.toBeNull();
    expect(aisha.compliance.items.find((i) => i.type === 'DBS')!.status).toBe('VALID');
    expect(workers.find((w) => w.firstName === 'Connor, Jr')!.skills).toEqual(['MEDICATION']);
    const mails = emails().slice(before);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.toAddress).toBe('aisha@importco.example');
    expect(mails[0]!.body).toContain('/invite/');
    expect((await api.post(`/api/v1/onboarding/import/${jobId}/apply`).set(auth(managerToken)).send({ fileName: 'staff.csv', contentBase64: b64(CSV) })).status).toBe(409);
  });

  it('updates rather than duplicates on a second import of the same people', async () => {
    const preview = await api.post('/api/v1/onboarding/import/preview').set(auth(adminToken)).send({ fileName: 'staff.csv', contentBase64: b64(CSV) });
    const res = await api.post(`/api/v1/onboarding/import/${preview.body.jobId}/apply`).set(auth(adminToken)).send({ fileName: 'staff.csv', contentBase64: b64(CSV), invite: true });
    expect(res.body).toMatchObject({ created: 1, updated: 1, invited: 0 }); // Connor has no email so cannot be matched
    expect((await api.get('/api/v1/onboarding/import/jobs').set(auth(adminToken))).body).toHaveLength(2);
  });

  it('reads a spreadsheet as well as CSV', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Staff');
    ws.addRow(['First Name', 'Last Name', 'Email', 'Job Role', 'Skills', 'Home Site', 'Invite', 'DBS reference', 'DBS expiresAt']);
    ws.addRow(['Fatima', 'Hussain', 'fatima@importco.example', 'NURSE', 'MEDICATION;PEG_FEEDING', 'Main home', 'no', 'DBS-9', new Date('2028-06-30')]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const preview = await api.post('/api/v1/onboarding/import/preview').set(auth(adminToken)).send({ fileName: 'staff.xlsx', contentBase64: buf.toString('base64') });
    expect(preview.status).toBe(200);
    expect(preview.body.validRows).toBe(1);
    expect(preview.body.sample[0]).toMatchObject({ name: 'Fatima Hussain', jobRole: 'NURSE', documents: 1 });
  });

  it('rejects a file whose headers are not recognised', async () => {
    const res = await api.post('/api/v1/onboarding/import/preview').set(auth(adminToken)).send({ fileName: 'x.csv', contentBase64: b64('a,b,c\n1,2,3') });
    expect(res.status).toBe(400);
  });

  it('keeps other organisations out', async () => {
    const other = await api.post('/api/v1/auth/register').send({ organisation: { name: 'Other Co', postcode: 'M1 1AA', cqcRegistrationNumber: '1-999' }, mouAccepted: true, admin: { email: 'admin@other.example', password: 'Other-Pass-2026', firstName: 'O', lastName: 'C' } });
    const res = await api.post('/api/v1/onboarding/import/preview').set(auth(other.body.token)).send({ fileName: 'staff.csv', contentBase64: b64(CSV), orgId });
    expect(res.status).toBe(403);
  });
});

describe('invitations and passwords', () => {
  let inviteToken = '';
  let aishaToken = '';

  it('lets an invited worker choose a password and sign in', async () => {
    const mail = emails().find((m) => m.toAddress === 'aisha@importco.example')!;
    inviteToken = linkToken(mail.body, '/invite');
    expect(inviteToken.length).toBeGreaterThan(20);
    const info = await api.get(`/api/v1/onboarding/invitations/${inviteToken}`);
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ email: 'aisha@importco.example', organisationName: 'Import Co', role: 'WORKER' });
    expect((await api.post(`/api/v1/onboarding/invitations/${inviteToken}/accept`).send({ password: 'password123' })).status).toBe(400);
    expect((await api.post(`/api/v1/onboarding/invitations/${inviteToken}/accept`).send({ password: 'short' })).status).toBe(400);
    const accept = await api.post(`/api/v1/onboarding/invitations/${inviteToken}/accept`).send({ password: 'Aisha-Secure-2026' });
    expect(accept.status).toBe(200);
    aishaToken = accept.body.token;
    const me = await api.get('/api/v1/auth/me').set(auth(aishaToken));
    expect(me.status).toBe(200);
    expect(me.body.user.mustChangePassword).toBe(false);
    expect(me.body.worker.firstName).toBe('Aisha');
    expect((await api.get(`/api/v1/onboarding/invitations/${inviteToken}`)).status).toBe(410);
    expect((await api.get('/api/v1/onboarding/invitations/not-a-real-token')).status).toBe(404);
    expect((await api.post('/api/v1/auth/login').send({ email: 'aisha@importco.example', password: 'Aisha-Secure-2026' })).status).toBe(200);
  });

  it('resets a forgotten password through an emailed link, once', async () => {
    const before = emails().length;
    expect((await api.post('/api/v1/onboarding/forgot-password').send({ email: 'aisha@importco.example' })).status).toBe(200);
    expect((await api.post('/api/v1/onboarding/forgot-password').send({ email: 'nobody@importco.example' })).status).toBe(200);
    expect((await api.post('/api/v1/onboarding/forgot-password').send({ email: 'aisha@importco.example' })).status).toBe(200); // within 10 minutes: no second token
    const mails = emails().slice(before);
    expect(mails).toHaveLength(1);
    const token = linkToken(mails[0]!.body, '/reset-password');
    expect((await api.post('/api/v1/onboarding/reset-password').send({ token, password: 'aisha@importco.example' })).status).toBe(400);
    expect((await api.post('/api/v1/onboarding/reset-password').send({ token, password: 'New-Secret-2026' })).status).toBe(200);
    expect((await api.post('/api/v1/auth/login').send({ email: 'aisha@importco.example', password: 'New-Secret-2026' })).status).toBe(200);
    expect((await api.post('/api/v1/auth/login').send({ email: 'aisha@importco.example', password: 'Aisha-Secure-2026' })).status).toBe(401);
    expect((await api.post('/api/v1/onboarding/reset-password').send({ token, password: 'Another-Secret-2026' })).status).toBe(410);
    clock = addHours(T0, 2);
    await api.post('/api/v1/onboarding/forgot-password').send({ email: 'aisha@importco.example' });
    const expired = linkToken(emails().at(-1)!.body, '/reset-password');
    clock = addHours(T0, 4);
    expect((await api.post('/api/v1/onboarding/reset-password').send({ token: expired, password: 'Late-Secret-2026' })).status).toBe(410);
    clock = T0;
  });

  it('changes a password when the current one is right', async () => {
    const token = (await api.post('/api/v1/auth/login').send({ email: 'aisha@importco.example', password: 'New-Secret-2026' })).body.token;
    expect((await api.post('/api/v1/onboarding/change-password').set(auth(token)).send({ currentPassword: 'wrong', newPassword: 'Changed-Secret-2026' })).status).toBe(401);
    expect((await api.post('/api/v1/onboarding/change-password').set(auth(token)).send({ currentPassword: 'New-Secret-2026', newPassword: 'Changed-Secret-2026' })).status).toBe(200);
    expect((await api.post('/api/v1/auth/login').send({ email: 'aisha@importco.example', password: 'Changed-Secret-2026' })).status).toBe(200);
  });

  it('applies the role rules to invitations and lists and resends pending ones', async () => {
    expect((await api.post('/api/v1/onboarding/invitations').set(auth(managerToken)).send({ email: 'boss@importco.example', role: 'ORG_ADMIN', firstName: 'B', lastName: 'Oss' })).status).toBe(403);
    expect((await api.post('/api/v1/onboarding/invitations').set(auth(managerToken)).send({ email: 'w@importco.example', role: 'WORKER', firstName: 'W', lastName: 'Orker' })).status).toBe(400);
    const before = emails().length;
    const inv = await api.post('/api/v1/onboarding/invitations').set(auth(adminToken)).send({ email: 'deputy@importco.example', role: 'ORG_MANAGER', firstName: 'Dee', lastName: 'Puty', siteIds: [] });
    expect(inv.status).toBe(201);
    expect(emails().length).toBe(before + 1);
    expect(emails().at(-1)!.subject).toContain('Grace Okafor has invited you');
    expect((await api.post('/api/v1/onboarding/invitations').set(auth(adminToken)).send({ email: 'deputy@importco.example', role: 'ORG_MANAGER', firstName: 'Dee', lastName: 'Puty' })).status).toBe(409);
    const pending = await api.get('/api/v1/onboarding/invitations').set(auth(adminToken));
    expect(pending.body.map((p: { email: string }) => p.email)).toEqual(['deputy@importco.example']);
    const firstToken = linkToken(emails().at(-1)!.body, '/invite');
    expect((await api.post('/api/v1/onboarding/invitations/resend').set(auth(adminToken)).send({ userId: inv.body.userId })).status).toBe(200);
    expect((await api.get(`/api/v1/onboarding/invitations/${firstToken}`)).status).toBe(410); // old link revoked
    const secondToken = linkToken(emails().at(-1)!.body, '/invite');
    expect((await api.get(`/api/v1/onboarding/invitations/${secondToken}`)).status).toBe(200);
    // Until accepted, the invited manager cannot do anything useful (unusable random password).
    expect((await api.post('/api/v1/auth/login').send({ email: 'deputy@importco.example', password: 'anything-at-all' })).status).toBe(401);
  });
});

describe('delivery rules and preferences', () => {
  const notifier = new Notifier(db, [], () => clock);
  const to = (addr: string) => emails().filter((m) => m.toAddress === addr);

  it('emails managers immediately for important events and holds the rest for the digest', async () => {
    const before = to('rota@importco.example').length;
    notifier.send({ orgId, type: 'SHIFT_CONFIRMED', title: 'Confirmed: Aisha at Oakwood', body: 'Shift details', data: { shiftId: 'shf_none' } });
    expect(to('rota@importco.example').length).toBe(before + 1);
    expect(to('admin@importco.example').at(-1)!.subject).toBe('Confirmed: Aisha at Oakwood');
    notifier.send({ orgId, type: 'SHIFT_AVAILABLE', title: 'Network: shift at Oakwood', body: 'Open now', data: { shiftId: 'shf_none' } });
    expect(to('rota@importco.example').length).toBe(before + 1);
    notifier.send({ orgId, type: 'SHIFT_AVAILABLE', title: 'URGENT shift at Oakwood', body: 'Starts in 3 hours', data: { shiftId: 'shf_none', urgent: true } });
    expect(to('rota@importco.example').length).toBe(before + 2);
    // Workers with their own login are never emailed for organisation-wide notices.
    expect(to('aisha@importco.example').filter((m) => m.subject?.includes('Oakwood'))).toHaveLength(0);
  });

  it('sends one daily digest per user with a watermark', () => {
    clock = addHours(T0, 23); // 07:00 the next morning
    const queued = runDigest(db, clock);
    expect(queued).toBeGreaterThanOrEqual(2); // admin and manager both have unread digest-class items
    const digest = to('rota@importco.example').filter((m) => m.subject === 'Daily digest');
    expect(digest).toHaveLength(1);
    expect(digest[0]!.body).toContain('shift available');
    expect(runDigest(db, addHours(clock, 1))).toBe(0); // nothing new since the last digest
    clock = T0;
  });

  it('writes worker-facing copy with the shift details for a worker recipient', async () => {
    const site = (await api.get(`/api/v1/organisations/${orgId}/sites`).set(auth(adminToken))).body[0];
    const shift = await api.post('/api/v1/shifts').set(auth(adminToken)).send({ siteId: site.id, jobRole: 'CARE_ASSISTANT', title: 'Day shift', startsAt: addDays(T0, 3).toISOString(), endsAt: addHours(addDays(T0, 3), 8).toISOString(), chargeRate: 18 });
    expect(shift.status).toBe(201);
    const login = await api.post('/api/v1/auth/login').send({ email: 'aisha@importco.example', password: 'Changed-Secret-2026' });
    const aishaUser = (await api.get('/api/v1/auth/me').set(auth(login.body.token))).body.user;
    notifier.send({ orgId, userId: aishaUser.id, type: 'SHIFT_CONFIRMED', title: 'Confirmed: Aisha Begum at Import Co', body: 'Please share the site access notes with the worker.', data: { shiftId: shift.body.id } });
    const mail = to('aisha@importco.example').at(-1)!;
    expect(mail.subject).toMatch(/^You're booked: Care assistant at Main home/);
    expect(mail.body).toContain('You have been booked');
    expect(mail.body).not.toContain('share the site access notes');
    expect(mail.body).toContain(`/shifts/${shift.body.id}`);
  });

  it('respects quiet hours and drains the outbox through a channel', async () => {
    await api.put('/api/v1/notifications/preferences').set(auth(managerToken)).send({ quietHoursStart: 22, quietHoursEnd: 7, phone: '07700 900999', smsImmediate: ['SHIFT_CANCELLED'] });
    clock = new Date('2026-11-02T23:30:00Z'); // 23:30 London (GMT)
    notifier.send({ orgId, type: 'SHIFT_CANCELLED', title: 'Booking cancelled', body: 'Worker sick', data: {} });
    const held = to('rota@importco.example').at(-1)!;
    expect(held.createdAt.getTime()).toBe(new Date('2026-11-03T07:00:00Z').getTime());
    const sms = db.select().from(outboundMessages).where(eq(outboundMessages.channel, 'SMS')).all();
    expect(sms.at(-1)!.toAddress).toBe('07700 900999');
    const first = await drainOutbox(db, clock, silentChannels);
    expect(db.select().from(outboundMessages).where(eq(outboundMessages.id, held.id)).get()!.status).toBe('PENDING');
    expect(first.sent).toBeGreaterThan(0);
    const later = await drainOutbox(db, new Date('2026-11-03T07:00:00Z'), silentChannels);
    expect(later.sent).toBeGreaterThanOrEqual(1); // the held email, plus the digests queued for 07:00
    expect(db.select().from(outboundMessages).where(eq(outboundMessages.id, held.id)).get()!.status).toBe('SENT');
    clock = T0;
  });

  it('reads and writes preferences', async () => {
    const def = await api.get('/api/v1/notifications/preferences').set(auth(adminToken));
    expect(def.status).toBe(200);
    expect(def.body.isDefault).toBe(true);
    expect(def.body.emailImmediate).toContain('SHIFT_CONFIRMED');
    const put = await api.put('/api/v1/notifications/preferences').set(auth(adminToken)).send({ emailImmediate: ['SHIFT_AVAILABLE'], emailDigest: false, maxDistanceKm: 15 });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ isDefault: false, emailImmediate: ['SHIFT_AVAILABLE'], emailDigest: false, maxDistanceKm: 15 });
    expect(db.select().from(notificationPreferences).all().length).toBeGreaterThanOrEqual(2);
    expect((await api.put('/api/v1/notifications/preferences').set(auth(adminToken)).send({ emailImmediate: ['NOT_A_TYPE'] })).status).toBe(400);
  });
});
