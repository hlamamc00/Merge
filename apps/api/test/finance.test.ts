import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, addHours, addMinutes, requiredDocumentsForRole, type JobRole } from '@merge/shared';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations } from '../src/db/client.js';
import { platformSettings } from '../src/db/schema.js';
import { autoApproveStaleTimesheets, timesheetExceptions } from '../src/services/timesheets.js';

const T0 = new Date('2026-11-02T08:00:00Z');
let clock = T0;
const { db } = openDatabase(':memory:');
runMigrations(db);
const { app, deps } = createApp({ db, now: () => clock, channels: [] });
// The security build gates managers behind authenticator set-up by default; this suite is about money, not sign-in.
db.update(platformSettings).set({ twoFactorRequiredForManagers: false }).run();

const api = request(app);
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
  const approved = await api.patch(`/api/v1/organisations/${res.body.organisation.id}`).set(auth(agency.token)).send({ status: 'ACTIVE' });
  expect(approved.status).toBe(200);
  return { token: res.body.token, orgId: res.body.organisation.id, userId: res.body.user.id };
}

async function addWorker(s: Session, firstName: string, jobRole: JobRole, extra: Record<string, unknown> = {}) {
  const res = await api.post('/api/v1/workers').set(auth(s.token)).send({ firstName, lastName: 'Worker', jobRole, skills: ['MOVING_AND_HANDLING', 'DEMENTIA'], shareable: true, lat: 53.41, lng: -2.16, travelRadiusKm: 30, ...extra });
  expect(res.status).toBe(201);
  const worker = res.body as { id: string };
  for (const type of requiredDocumentsForRole(jobRole)) {
    const doc = await api.post(`/api/v1/workers/${worker.id}/documents`).set(auth(s.token)).send({ type, expiresAt: addDays(clock, 400).toISOString() });
    expect(doc.status).toBe(201);
    expect((await api.patch(`/api/v1/workers/${worker.id}/documents/${doc.body.id}`).set(auth(s.token)).send({ verified: true })).status).toBe(200);
  }
  return worker;
}

/** Post a shift, have `supplier` request a worker and the host confirm; returns the shift and the draft timesheet id. */
async function book(supplier: Session, workerId: string, startsAt: Date, hours: number, chargeRate: number, breakMinutes = 0) {
  const shift = await api.post('/api/v1/shifts').set(auth(oakwood.token)).send({ siteId: oakSite.id, jobRole: 'CARE_ASSISTANT', title: `Shift ${startsAt.toISOString().slice(0, 10)}`, startsAt: startsAt.toISOString(), endsAt: addHours(startsAt, hours).toISOString(), breakMinutes, chargeRate, requiredSkills: ['MOVING_AND_HANDLING'], publish: true });
  expect(shift.status).toBe(201);
  // No capacity flag: everyone opens at the network window.
  clock = addMinutes(clock, 181);
  const req = await api.post(`/api/v1/shifts/${shift.body.id}/requests`).set(auth(supplier.token)).send({ workerId });
  expect(req.status).toBe(201);
  if (req.body.assignment.status !== 'CONFIRMED') {
    const confirm = await api.post(`/api/v1/assignments/${req.body.assignment.id}/confirm`).set(auth(oakwood.token));
    expect(confirm.status).toBe(200);
  }
  const list = await api.get('/api/v1/timesheets?scope=receivable&status=DRAFT').set(auth(supplier.token));
  const ts = list.body.find((t: { shiftId: string }) => t.shiftId === shift.body.id);
  expect(ts).toBeTruthy();
  return { shiftId: shift.body.id as string, timesheetId: ts.id as string, startsAt, endsAt: addHours(startsAt, hours) };
}

let agency: Session;
let oakwood: Session; // host
let riverside: Session; // third-party supplier
let oakSite: { id: string };
let rivWorker: { id: string };
let bankWorker: { id: string };

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
  rivWorker = await addWorker(riverside, 'Aisha', 'CARE_ASSISTANT');
  bankWorker = await addWorker(agency, 'Dan', 'CARE_ASSISTANT', { hourlyPayRate: 13, contractedHoursPerWeek: 37.5 });
});

describe('timesheet exceptions, bulk and auto approval', () => {
  let rivTs: string;
  let bankTs: string;

  it('flags late clock-ins and over-length timesheets on the list', async () => {
    const a = await book(riverside, rivWorker.id, addHours(T0, 72), 8, 18, 30);
    const b = await book(agency, bankWorker.id, addHours(T0, 96), 8, 22);
    rivTs = a.timesheetId;
    bankTs = b.timesheetId;
    clock = addDays(T0, 6);
    expect((await api.post(`/api/v1/timesheets/${rivTs}/clock-in`).set(auth(riverside.token)).send({ at: addMinutes(a.startsAt, 20).toISOString() })).status).toBe(200);
    expect((await api.post(`/api/v1/timesheets/${rivTs}/clock-out`).set(auth(riverside.token)).send({ at: addMinutes(a.endsAt, 20).toISOString(), breakMinutes: 30 })).status).toBe(200);
    expect((await api.post(`/api/v1/timesheets/${bankTs}/submit`).set(auth(agency.token)).send({ clockInAt: b.startsAt.toISOString(), clockOutAt: addHours(b.startsAt, 9).toISOString(), breakMinutes: 0 })).status).toBe(200);

    const list = await api.get('/api/v1/timesheets?scope=payable&status=SUBMITTED').set(auth(oakwood.token));
    expect(list.status).toBe(200);
    const byId = Object.fromEntries(list.body.map((t: { id: string; exceptions: string[] }) => [t.id, t.exceptions]));
    expect(byId[rivTs]).toEqual(['LATE_CLOCK_IN']);
    expect(byId[bankTs]).toEqual(['OVER_LENGTH']);

    expect(timesheetExceptions({ paidHours: 0, clockInAt: T0, clockOutAt: null, submittedAt: null, status: 'DRAFT' }, { startsAt: T0, endsAt: addHours(T0, 8), breakMinutes: 0 }, addDays(T0, 1))).toEqual(['MISSING_CLOCK_OUT']);
    expect(timesheetExceptions({ paidHours: 8, clockInAt: T0, clockOutAt: addHours(T0, 8), submittedAt: addDays(T0, 9), status: 'SUBMITTED' }, { startsAt: T0, endsAt: addHours(T0, 8), breakMinutes: 0 }, addDays(T0, 10))).toEqual(['SUBMITTED_LATE']);
  });

  it('bulk-approves what it can and reports the rest', async () => {
    const asSupplier = await api.post('/api/v1/timesheets/bulk-approve').set(auth(riverside.token)).send({ ids: [rivTs] });
    expect(asSupplier.status).toBe(200);
    expect(asSupplier.body.results[0]).toMatchObject({ id: rivTs, ok: false });

    const res = await api.post('/api/v1/timesheets/bulk-approve').set(auth(oakwood.token)).send({ ids: [rivTs, bankTs, 'ts_missing'] });
    expect(res.status).toBe(200);
    expect(res.body.approved).toBe(2);
    expect(res.body.failed).toBe(1);
    expect(res.body.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true, false]);

    const again = await api.post('/api/v1/timesheets/bulk-approve').set(auth(oakwood.token)).send({ ids: [rivTs] });
    expect(again.body.results[0]).toMatchObject({ ok: false, status: 'APPROVED' });
  });

  it('auto-approves submitted timesheets the host has ignored for 14 days', async () => {
    const c = await book(riverside, rivWorker.id, addDays(T0, 8), 8, 18);
    clock = addDays(T0, 9);
    expect((await api.post(`/api/v1/timesheets/${c.timesheetId}/submit`).set(auth(riverside.token)).send({ clockInAt: c.startsAt.toISOString(), clockOutAt: c.endsAt.toISOString(), breakMinutes: 0 })).status).toBe(200);
    expect(autoApproveStaleTimesheets(db, deps.notifier, addDays(clock, 13))).toHaveLength(0);
    const done = autoApproveStaleTimesheets(db, deps.notifier, addDays(clock, 14));
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ id: c.timesheetId, status: 'APPROVED', approvedByUserId: null });
    expect(done[0]!.notes).toContain('Auto-approved');
    const inbox = await api.get('/api/v1/notifications?unread=true').set(auth(oakwood.token));
    expect(inbox.body.notifications.some((n: { title: string }) => n.title === 'Timesheet auto-approved')).toBe(true);
  });
});

describe('settlement run, host invoices and remittances', () => {
  let hostInvoiceId: string;
  let remittanceId: string;
  let rivLineId: string;
  let rivLineTimesheetId: string;

  it('creates lines, one host invoice and one remittance, with the agency bank as an agency sale', async () => {
    clock = addDays(T0, 10);
    expect((await api.post('/api/v1/finance/run').set(auth(oakwood.token)).send({ periodStart: T0.toISOString(), periodEnd: addDays(T0, 7).toISOString() })).status).toBe(403);
    const run = await api.post('/api/v1/finance/run').set(auth(agency.token)).send({ periodStart: T0.toISOString(), periodEnd: addDays(T0, 7).toISOString() });
    expect(run.status).toBe(201);
    expect(run.body.lines).toHaveLength(2);
    const riv = run.body.lines.find((l: { supplierOrgId: string }) => l.supplierOrgId === riverside.orgId);
    const bank = run.body.lines.find((l: { supplierOrgId: string }) => l.supplierOrgId === agency.orgId);
    // Riverside: clocked in and out 20 minutes late, 8h less a 30 min break = 7.5h × £18 at an 8% platform fee.
    expect(riv).toMatchObject({ agencySale: false, totalHours: 7.5, subtotal: 135, platformFee: 10.8, supplierAmount: 124.2 });
    // Agency bank: 9h × £22, no platform fee, the whole charge is the agency's.
    expect(bank).toMatchObject({ agencySale: true, totalHours: 9, subtotal: 198, platformFee: 0, supplierAmount: 198 });
    rivLineId = riv.id;

    expect(run.body.hostInvoices).toHaveLength(1);
    const inv = run.body.hostInvoices[0];
    expect(inv).toMatchObject({ hostOrgId: oakwood.orgId, status: 'ISSUED', subtotal: 333, credits: 0, total: 333, number: 'MH-2026-00001' });
    expect(new Date(inv.dueAt)).toEqual(addDays(clock, 30));
    hostInvoiceId = inv.id;
    expect(riv.hostInvoiceId).toBe(hostInvoiceId);
    expect(bank.hostInvoiceId).toBe(hostInvoiceId);

    expect(run.body.remittances).toHaveLength(1);
    expect(run.body.remittances[0]).toMatchObject({ supplierOrgId: riverside.orgId, amount: 124.2, total: 124.2, number: 'MR-2026-00001', status: 'ISSUED' });
    remittanceId = run.body.remittances[0].id;
    expect(riv.remittanceId).toBe(remittanceId);
    expect(bank.remittanceId).toBeNull();

    // The legacy statement list still shows the lines.
    const legacy = await api.get('/api/v1/invoices?scope=payable').set(auth(oakwood.token));
    expect(legacy.body).toHaveLength(2);
  });

  it('shows each side its own documents with lines and lets them export CSV', async () => {
    const hostList = await api.get('/api/v1/finance/host-invoices').set(auth(oakwood.token));
    expect(hostList.body).toHaveLength(1);
    expect(hostList.body[0].hostName).toBe('Oakwood Care');
    expect((await api.get('/api/v1/finance/host-invoices').set(auth(riverside.token))).body).toHaveLength(0);
    expect((await api.get(`/api/v1/finance/host-invoices/${hostInvoiceId}`).set(auth(riverside.token))).status).toBe(403);

    const detail = await api.get(`/api/v1/finance/host-invoices/${hostInvoiceId}`).set(auth(oakwood.token));
    expect(detail.status).toBe(200);
    expect(detail.body.lines).toHaveLength(2);
    const rivLine = detail.body.lines.find((l: { id: string }) => l.id === rivLineId);
    expect(rivLine.supplierName).toBe('Riverside Living');
    expect(rivLine.timesheets).toHaveLength(1);
    expect(rivLine.timesheets[0]).toMatchObject({ siteName: 'Oakwood Manor', workerName: 'Aisha Worker', hostCost: 135 });
    rivLineTimesheetId = rivLine.timesheets[0].id;

    const csv = await api.get(`/api/v1/finance/host-invoices/${hostInvoiceId}/export.csv`).set(auth(oakwood.token));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const rows = csv.text.trim().split('\r\n');
    expect(rows[0]).toContain('Nominal code');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain('MH-2026-00001');
    expect(rows[1]).toContain('AW'); // worker initials, not names, on the host's accounting export

    const remList = await api.get('/api/v1/finance/remittances').set(auth(riverside.token));
    expect(remList.body).toHaveLength(1);
    expect((await api.get('/api/v1/finance/remittances').set(auth(oakwood.token))).body).toHaveLength(0);
    const rem = await api.get(`/api/v1/finance/remittances/${remittanceId}`).set(auth(riverside.token));
    expect(rem.body.lines).toHaveLength(1);
    expect(rem.body.lines[0].hostName).toBe('Oakwood Care');
    const remCsv = await api.get(`/api/v1/finance/remittances/${remittanceId}/export.csv`).set(auth(riverside.token));
    expect(remCsv.text.trim().split('\r\n')).toHaveLength(2);

    const all = await api.get('/api/v1/finance/export.csv?type=host-invoices').set(auth(agency.token));
    expect(all.status).toBe(200);
    expect(all.text).toContain('MH-2026-00001');
    expect((await api.get('/api/v1/finance/export.csv?type=lines').set(auth(oakwood.token))).status).toBe(403);
  });

  it('lets the host query a line and the platform decide the credit', async () => {
    const tooMuch = await api.post('/api/v1/finance/credits').set(auth(oakwood.token)).send({ invoiceId: rivLineId, timesheetId: rivLineTimesheetId, amount: 500, reason: 'Worker left early' });
    expect(tooMuch.status).toBe(422);
    expect((await api.post('/api/v1/finance/credits').set(auth(riverside.token)).send({ invoiceId: rivLineId, amount: 18, reason: 'nope' })).status).toBe(403);

    const req = await api.post('/api/v1/finance/credits').set(auth(oakwood.token)).send({ invoiceId: rivLineId, timesheetId: rivLineTimesheetId, amount: 18, reason: 'Worker left an hour early' });
    expect(req.status).toBe(201);
    expect(req.body).toMatchObject({ status: 'REQUESTED', hostOrgId: oakwood.orgId, supplierOrgId: riverside.orgId, amount: 18 });

    expect((await api.post(`/api/v1/finance/credits/${req.body.id}/approve`).set(auth(oakwood.token))).status).toBe(403);
    const queue = await api.get('/api/v1/finance/credits?scope=all&status=REQUESTED').set(auth(agency.token));
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0].lineNumber).toMatch(/^MRG-2026-/);
    const approved = await api.post(`/api/v1/finance/credits/${req.body.id}/approve`).set(auth(agency.token)).send({ note: 'Confirmed with the site' });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('APPROVED');
    expect((await api.post(`/api/v1/finance/credits/${req.body.id}/approve`).set(auth(agency.token))).status).toBe(409);

    const supplierView = await api.get('/api/v1/finance/credits?scope=receivable').set(auth(riverside.token));
    expect(supplierView.body).toHaveLength(1);
  });

  it('nets the approved credit off the next invoice and remittance pro rata', async () => {
    const d = await book(riverside, rivWorker.id, addDays(T0, 12), 8, 18);
    clock = addDays(T0, 13);
    expect((await api.post(`/api/v1/timesheets/${d.timesheetId}/submit`).set(auth(riverside.token)).send({ clockInAt: d.startsAt.toISOString(), clockOutAt: d.endsAt.toISOString(), breakMinutes: 0 })).status).toBe(200);
    expect((await api.post(`/api/v1/timesheets/${d.timesheetId}/approve`).set(auth(oakwood.token))).status).toBe(200);

    clock = addDays(T0, 24);
    const run = await api.post('/api/v1/finance/run').set(auth(agency.token)).send({ periodStart: addDays(T0, 7).toISOString(), periodEnd: addDays(T0, 14).toISOString() });
    expect(run.status).toBe(201);
    // Two riverside timesheets approved since the first run: the auto-approved one (8h) and this one (8h) = 16h × £18.
    expect(run.body.lines).toHaveLength(1);
    expect(run.body.lines[0]).toMatchObject({ subtotal: 288, platformFee: 23.04, supplierAmount: 264.96 });
    expect(run.body.hostInvoices[0]).toMatchObject({ number: 'MH-2026-00002', subtotal: 288, credits: 18, total: 270 });
    // Supplier share of the £18 credit at a 92% split: £16.56. The platform forgoes its £1.44.
    expect(run.body.remittances[0]).toMatchObject({ number: 'MR-2026-00002', amount: 264.96, credits: 16.56, total: 248.4 });

    const credit = (await api.get('/api/v1/finance/credits?scope=all').set(auth(agency.token))).body[0];
    expect(credit).toMatchObject({ status: 'APPLIED', appliedToHostInvoiceId: run.body.hostInvoices[0].id, appliedToRemittanceId: run.body.remittances[0].id });
    const detail = await api.get(`/api/v1/finance/host-invoices/${run.body.hostInvoices[0].id}`).set(auth(oakwood.token));
    expect(detail.body.appliedCredits).toHaveLength(1);

    // Settle the second invoice and remittance straight away so only the first one goes overdue below.
    expect((await api.post(`/api/v1/finance/host-invoices/${run.body.hostInvoices[0].id}/mark-paid`).set(auth(oakwood.token)).send({ reference: 'x' })).status).toBe(403);
    const paid = await api.post(`/api/v1/finance/host-invoices/${run.body.hostInvoices[0].id}/mark-paid`).set(auth(agency.token)).send({ reference: 'BACS 4471' });
    expect(paid.body).toMatchObject({ status: 'PAID', paymentReference: 'BACS 4471' });
    const remPaid = await api.post(`/api/v1/finance/remittances/${run.body.remittances[0].id}/mark-paid`).set(auth(agency.token)).send({ reference: 'BACS 4472' });
    expect(remPaid.body.status).toBe('PAID');
    expect((await api.post(`/api/v1/finance/remittances/${run.body.remittances[0].id}/mark-paid`).set(auth(agency.token)).send({})).status).toBe(409);
  });

  it('marks invoices overdue, reminds at 7 and 14 days, holds credit at 30 and releases it on payment', async () => {
    const dueAt = addDays(addDays(T0, 10), 30);
    clock = addDays(dueAt, 1);
    const first = await api.post('/api/v1/finance/jobs/run').set(auth(agency.token));
    expect(first.body).toMatchObject({ markedOverdue: 1, reminders: 0, holdsApplied: 0, holdsCleared: 0 });
    expect((await api.get('/api/v1/finance/host-invoices?status=OVERDUE').set(auth(oakwood.token))).body).toHaveLength(1);

    clock = addDays(dueAt, 7);
    expect((await api.post('/api/v1/finance/jobs/run').set(auth(agency.token))).body.reminders).toBe(1);
    expect((await api.post('/api/v1/finance/jobs/run').set(auth(agency.token))).body.reminders).toBe(0);
    clock = addDays(dueAt, 15);
    expect((await api.post('/api/v1/finance/jobs/run').set(auth(agency.token))).body.reminders).toBe(1);
    expect((await api.post('/api/v1/finance/jobs/run').set(auth(agency.token))).body.reminders).toBe(0);

    clock = addDays(dueAt, 30);
    const hold = await api.post('/api/v1/finance/jobs/run').set(auth(agency.token));
    expect(hold.body.holdsApplied).toBe(1);
    const summary = await api.get('/api/v1/finance/summary').set(auth(oakwood.token));
    expect(summary.body).toMatchObject({ creditHold: true, overdueCount: 1, overdue: 333 });
    const org = await api.get(`/api/v1/organisations/${oakwood.orgId}`).set(auth(oakwood.token));
    expect(org.body.creditHold).toBe(true);
    const agencyInbox = await api.get('/api/v1/notifications?unread=true').set(auth(agency.token));
    expect(agencyInbox.body.notifications.some((n: { title: string }) => n.title.startsWith('Credit hold applied'))).toBe(true);

    expect((await api.post(`/api/v1/finance/host-invoices/${hostInvoiceId}/mark-paid`).set(auth(agency.token)).send({ reference: 'BACS 9001' })).body.status).toBe('PAID');
    const cleared = await api.post('/api/v1/finance/jobs/run').set(auth(agency.token));
    expect(cleared.body.holdsCleared).toBe(1);
    expect((await api.get('/api/v1/finance/summary').set(auth(oakwood.token))).body.creditHold).toBe(false);
    // Lines under a paid invoice are paid too, so the legacy list agrees.
    const legacy = await api.get('/api/v1/invoices?scope=payable').set(auth(oakwood.token));
    expect(legacy.body.every((l: { status: string }) => l.status === 'PAID')).toBe(true);
  });
});

describe('reports', () => {
  it('reports host spend and supplier earnings', async () => {
    const q = `from=${T0.toISOString()}&to=${addDays(T0, 28).toISOString()}`;
    const bySupplier = await api.get(`/api/v1/finance/spend?${q}&groupBy=supplier`).set(auth(oakwood.token));
    expect(bySupplier.status).toBe(200);
    expect(bySupplier.body.rows.map((r: { label: string; amount: number }) => [r.label, r.amount])).toEqual([
      ['Merge Staffing', 198],
      ['Riverside Living', 423],
    ]);
    expect(bySupplier.body.totals).toEqual({ hours: 32.5, shifts: 4, amount: 621 });
    const byMonth = await api.get(`/api/v1/finance/spend?${q}&groupBy=month`).set(auth(oakwood.token));
    expect(byMonth.body.rows).toHaveLength(1);
    expect(byMonth.body.rows[0].key).toBe('2026-11');

    const earnings = await api.get(`/api/v1/finance/earnings?${q}&groupBy=host`).set(auth(riverside.token));
    expect(earnings.body.rows).toEqual([{ key: oakwood.orgId, label: 'Oakwood Care', hours: 23.5, shifts: 3, amount: 389.16 }]);
    // The agency's own bank earns the full charge.
    const bankEarnings = await api.get(`/api/v1/finance/earnings?${q}&groupBy=worker`).set(auth(agency.token));
    expect(bankEarnings.body.rows).toEqual([{ key: bankWorker.id, label: 'Dan Worker', hours: 9, shifts: 1, amount: 198 }]);
  });

  it('gives the agency a P&L and bank utilisation, and nobody else', async () => {
    const q = `from=${T0.toISOString()}&to=${addDays(T0, 28).toISOString()}`;
    expect((await api.get(`/api/v1/finance/agency/pnl?${q}`).set(auth(oakwood.token))).status).toBe(403);
    const pnl = await api.get(`/api/v1/finance/agency/pnl?${q}`).set(auth(agency.token));
    expect(pnl.status).toBe(200);
    expect(pnl.body.revenue).toEqual({ platformFees: 33.84, agencySales: 198, total: 231.84 });
    expect(pnl.body.costOfSales).toEqual({ bankWorkerPay: 117 }); // 9h × £13
    expect(pnl.body.grossMargin).toBe(114.84);
    expect(pnl.body.hours).toEqual({ thirdParty: 23.5, agencyBank: 9 });
    expect(pnl.body.byClient).toEqual([{ hostOrgId: oakwood.orgId, hostName: 'Oakwood Care', thirdPartyCharge: 423, platformFees: 33.84, agencySales: 198, agencyHours: 9, bankPay: 117, margin: 114.84 }]);

    const util = await api.get(`/api/v1/finance/agency/bank-utilisation?${q}`).set(auth(agency.token));
    expect(util.status).toBe(200);
    expect(util.body.weeks).toBe(4);
    expect(util.body.rows).toHaveLength(1);
    expect(util.body.rows[0]).toMatchObject({ name: 'Dan Worker', contractedHoursPerWeek: 37.5, hoursWorked: 9, shifts: 1, availableHours: 150, utilisationPct: 6 });
    expect(util.body.rows[0].lastShiftAt).toBe(addHours(T0, 104).toISOString());
    expect(util.body.rows[0].idleDays).toBeGreaterThan(30);
  });
});
