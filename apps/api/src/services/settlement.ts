/**
 * Settlement (decisions 1, 2 and 5): hosts pay the platform one invoice per period covering every
 * supplier; the platform pays each supplier one remittance; supply from the platform owner's own bank is
 * the agency's own sale; credits raised after a host query net off the next invoice and remittance.
 */
import { and, desc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { NotificationType, TimesheetStatus, round2 } from '@merge/shared';
import type { Db } from '../db/client.js';
import {
  credits,
  hostInvoices,
  invoices,
  organisations,
  remittances,
  shiftAssignments,
  shifts,
  sites,
  timesheets,
  workers,
  type Credit,
  type HostInvoice,
  type Invoice,
  type PlatformSettingsRow,
  type Remittance,
} from '../db/schema.js';
import { conflict, notFound, unprocessable } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import type { Notifier } from '../lib/notify.js';
import { generateInvoices } from './invoices.js';

const DAY = 86_400_000;
/** VAT treatment of platform fees and staff supply is a decision for the operator's accountant; 0 until then. */
export const VAT_PCT = 0;
export const PAYMENT_TERMS_DAYS = 30;
export const REMINDER_DAYS = [7, 14] as const;
export const CREDIT_HOLD_AFTER_DAYS = 30;

export interface SettlementRun {
  lines: Invoice[];
  hostInvoices: HostInvoice[];
  remittances: Remittance[];
}

function nextNumber(db: Db, prefix: 'MH' | 'MR', now: Date): string {
  const table = prefix === 'MH' ? hostInvoices : remittances;
  const count = (db.select({ c: sql<number>`count(*)` }).from(table).get()?.c ?? 0) + 1;
  return `${prefix}-${now.getUTCFullYear()}-${String(count).padStart(5, '0')}`;
}

function orgName(db: Db, id: string): string {
  return db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, id)).get()?.name ?? 'Organisation';
}

/**
 * The monthly run. Returns the settlement lines, host invoices and remittances it created.
 * Credits approved before the run are applied: the host side to the host's invoice, the supplier side
 * (pro rata to the line's split, the platform forgoing its fee share) to the supplier's remittance.
 */
export function runSettlement(db: Db, notifier: Notifier, settings: PlatformSettingsRow, input: { periodStart: Date; periodEnd: Date }, now: Date): SettlementRun {
  if (input.periodEnd <= input.periodStart) throw unprocessable('periodEnd must be after periodStart');
  const lines = generateInvoices(db, notifier, input, now, { ownerOrgId: settings.ownerOrgId, notify: false });

  // Credits awaiting application.
  const pendingCredits = db.select().from(credits).where(eq(credits.status, 'APPROVED')).all();
  const lineById = new Map<string, Invoice>();
  for (const c of pendingCredits) {
    if (!lineById.has(c.invoiceId)) {
      const l = db.select().from(invoices).where(eq(invoices.id, c.invoiceId)).get();
      if (l) lineById.set(c.invoiceId, l);
    }
  }
  const supplierShare = (c: Credit): number => {
    const line = lineById.get(c.invoiceId);
    if (!line || line.subtotal <= 0) return c.amount;
    return round2(c.amount * (line.supplierAmount / line.subtotal));
  };

  // Host invoices: one per host and currency.
  const byHost = new Map<string, Invoice[]>();
  for (const l of lines) byHost.set(`${l.hostOrgId}|${l.currency}`, [...(byHost.get(`${l.hostOrgId}|${l.currency}`) ?? []), l]);
  const createdHostInvoices: HostInvoice[] = [];
  for (const [key, group] of byHost) {
    const [hostOrgId, currency] = key.split('|') as [string, string];
    const subtotal = round2(group.reduce((s, l) => s + l.subtotal, 0));
    const hostCredits = pendingCredits.filter((c) => c.hostOrgId === hostOrgId && !c.appliedToHostInvoiceId);
    const creditTotal = round2(hostCredits.reduce((s, c) => s + c.amount, 0));
    const id = newId('hinv');
    db.insert(hostInvoices)
      .values({ id, number: nextNumber(db, 'MH', now), hostOrgId, periodStart: input.periodStart, periodEnd: input.periodEnd, status: 'ISSUED', currency, subtotal, credits: creditTotal, total: round2(subtotal - creditTotal), dueAt: new Date(now.getTime() + PAYMENT_TERMS_DAYS * DAY), issuedAt: now, createdAt: now })
      .run();
    db.update(invoices).set({ hostInvoiceId: id }).where(inArray(invoices.id, group.map((l) => l.id))).run();
    for (const c of hostCredits) db.update(credits).set({ appliedToHostInvoiceId: id }).where(eq(credits.id, c.id)).run();
    const inv = db.select().from(hostInvoices).where(eq(hostInvoices.id, id)).get()!;
    createdHostInvoices.push(inv);
    notifier.send({
      orgId: hostOrgId,
      type: NotificationType.INVOICE_ISSUED,
      title: `Invoice ${inv.number} issued: £${inv.total.toFixed(2)}`,
      body: `${group.length} supplier line(s) for the period to ${input.periodEnd.toISOString().slice(0, 10)}${creditTotal ? `, less £${creditTotal.toFixed(2)} credits` : ''}. Due ${inv.dueAt.toISOString().slice(0, 10)}.`,
      data: { hostInvoiceId: id },
    });
  }

  // Remittances: one per supplier and currency, excluding the agency's own sales.
  const bySupplier = new Map<string, Invoice[]>();
  for (const l of lines) {
    if (l.agencySale) continue;
    bySupplier.set(`${l.supplierOrgId}|${l.currency}`, [...(bySupplier.get(`${l.supplierOrgId}|${l.currency}`) ?? []), l]);
  }
  const createdRemittances: Remittance[] = [];
  for (const [key, group] of bySupplier) {
    const [supplierOrgId, currency] = key.split('|') as [string, string];
    const amount = round2(group.reduce((s, l) => s + l.supplierAmount, 0));
    const supplierCredits = pendingCredits.filter((c) => c.supplierOrgId === supplierOrgId && !c.appliedToRemittanceId && !lineById.get(c.invoiceId)?.agencySale);
    const creditTotal = round2(supplierCredits.reduce((s, c) => s + supplierShare(c), 0));
    const id = newId('rem');
    db.insert(remittances)
      .values({ id, number: nextNumber(db, 'MR', now), supplierOrgId, periodStart: input.periodStart, periodEnd: input.periodEnd, status: 'ISSUED', currency, amount, credits: creditTotal, total: round2(amount - creditTotal), issuedAt: now, createdAt: now })
      .run();
    db.update(invoices).set({ remittanceId: id }).where(inArray(invoices.id, group.map((l) => l.id))).run();
    for (const c of supplierCredits) db.update(credits).set({ appliedToRemittanceId: id }).where(eq(credits.id, c.id)).run();
    const rem = db.select().from(remittances).where(eq(remittances.id, id)).get()!;
    createdRemittances.push(rem);
    notifier.send({
      orgId: supplierOrgId,
      type: NotificationType.INVOICE_ISSUED,
      title: `Remittance ${rem.number}: £${rem.total.toFixed(2)} due to you`,
      body: `For ${group.reduce((s, l) => s + l.totalHours, 0)}h supplied across ${group.length} host(s) in the period to ${input.periodEnd.toISOString().slice(0, 10)}${creditTotal ? `, less £${creditTotal.toFixed(2)} credits` : ''}.`,
      data: { remittanceId: id },
    });
  }

  // A credit is fully applied once both sides are settled (the supplier side of an agency sale has no remittance).
  for (const c of pendingCredits) {
    const fresh = db.select().from(credits).where(eq(credits.id, c.id)).get()!;
    const supplierDone = !!fresh.appliedToRemittanceId || !!lineById.get(c.invoiceId)?.agencySale;
    if (fresh.appliedToHostInvoiceId && supplierDone) db.update(credits).set({ status: 'APPLIED' }).where(eq(credits.id, c.id)).run();
  }

  // Re-read the lines so the response carries the invoice and remittance ids just stamped on them.
  return { lines: lines.map((l) => db.select().from(invoices).where(eq(invoices.id, l.id)).get()!), hostInvoices: createdHostInvoices, remittances: createdRemittances };
}

// ---------- Credits (decision 5) ----------

export function requestCredit(db: Db, notifier: Notifier, settings: PlatformSettingsRow, input: { invoiceId: string; timesheetId?: string | null; amount: number; reason: string; requestedByUserId: string; hostOrgId: string }, now: Date): Credit {
  const line = db.select().from(invoices).where(eq(invoices.id, input.invoiceId)).get();
  if (!line) throw notFound('Statement line');
  if (line.hostOrgId !== input.hostOrgId) throw conflict('That statement line is not yours');
  if (input.timesheetId) {
    const ts = db.select({ invoiceId: timesheets.invoiceId, hostCost: timesheets.hostCost }).from(timesheets).where(eq(timesheets.id, input.timesheetId)).get();
    if (!ts || ts.invoiceId !== line.id) throw conflict('That timesheet is not on this statement line');
    if (input.amount > ts.hostCost + 0.005) throw unprocessable(`Credit cannot exceed the timesheet's charge of £${ts.hostCost.toFixed(2)}`);
  }
  const already = db.select({ amount: credits.amount }).from(credits).where(and(eq(credits.invoiceId, line.id), inArray(credits.status, ['REQUESTED', 'APPROVED', 'APPLIED']))).all().reduce((s, c) => s + c.amount, 0);
  if (input.amount <= 0 || input.amount + already > line.subtotal + 0.005) throw unprocessable(`Credits on this line cannot exceed its £${line.subtotal.toFixed(2)} charge (already £${already.toFixed(2)})`);
  const id = newId('crd');
  db.insert(credits).values({ id, invoiceId: line.id, timesheetId: input.timesheetId ?? null, hostOrgId: line.hostOrgId, supplierOrgId: line.supplierOrgId, amount: round2(input.amount), reason: input.reason, status: 'REQUESTED', requestedByUserId: input.requestedByUserId, createdAt: now }).run();
  if (settings.ownerOrgId) {
    notifier.send({ orgId: settings.ownerOrgId, type: NotificationType.SYSTEM, title: `Credit requested: £${input.amount.toFixed(2)} on ${line.number}`, body: `${orgName(db, line.hostOrgId)}: ${input.reason}`, data: { creditId: id, invoiceId: line.id } });
  }
  return db.select().from(credits).where(eq(credits.id, id)).get()!;
}

export function decideCredit(db: Db, notifier: Notifier, creditId: string, decision: 'APPROVED' | 'REJECTED', decidedByUserId: string, note: string | null, now: Date): Credit {
  const c = db.select().from(credits).where(eq(credits.id, creditId)).get();
  if (!c) throw notFound('Credit');
  if (c.status !== 'REQUESTED') throw conflict(`Credit is already ${c.status.toLowerCase()}`);
  db.update(credits).set({ status: decision, decidedByUserId, decidedAt: now, reason: note ? `${c.reason} — ${decision === 'APPROVED' ? 'approved' : 'rejected'}: ${note}` : c.reason }).where(eq(credits.id, c.id)).run();
  const line = db.select().from(invoices).where(eq(invoices.id, c.invoiceId)).get()!;
  notifier.send({ orgId: c.hostOrgId, type: NotificationType.INVOICE_ISSUED, title: `Credit ${decision === 'APPROVED' ? 'approved' : 'rejected'}: £${c.amount.toFixed(2)} on ${line.number}`, body: decision === 'APPROVED' ? 'It will be deducted from your next invoice.' : (note ?? 'The platform did not uphold the query.'), data: { creditId: c.id } });
  if (decision === 'APPROVED' && !line.agencySale) {
    notifier.send({ orgId: c.supplierOrgId, type: NotificationType.INVOICE_ISSUED, title: `Credit applied against ${line.number}`, body: `${orgName(db, c.hostOrgId)} queried a line: £${c.amount.toFixed(2)} credit (${c.reason}). Your share will be deducted from your next remittance.`, data: { creditId: c.id } });
  }
  return db.select().from(credits).where(eq(credits.id, c.id)).get()!;
}

// ---------- Overdue handling and credit hold (decision 1) ----------

export interface FinanceJobsResult {
  markedOverdue: number;
  reminders: number;
  holdsApplied: number;
  holdsCleared: number;
}

export function runFinanceJobs(db: Db, notifier: Notifier, settings: PlatformSettingsRow, now: Date): FinanceJobsResult {
  const result: FinanceJobsResult = { markedOverdue: 0, reminders: 0, holdsApplied: 0, holdsCleared: 0 };
  const due = db.select().from(hostInvoices).where(and(eq(hostInvoices.status, 'ISSUED'), lt(hostInvoices.dueAt, now))).all();
  for (const inv of due) {
    db.update(hostInvoices).set({ status: 'OVERDUE' }).where(eq(hostInvoices.id, inv.id)).run();
    notifier.send({ orgId: inv.hostOrgId, type: NotificationType.INVOICE_ISSUED, title: `Invoice ${inv.number} is overdue`, body: `£${inv.total.toFixed(2)} was due on ${inv.dueAt.toISOString().slice(0, 10)}.`, data: { hostInvoiceId: inv.id } });
    result.markedOverdue++;
  }
  const overdue = db.select().from(hostInvoices).where(eq(hostInvoices.status, 'OVERDUE')).all();
  const hostsToHold = new Set<string>();
  for (const inv of overdue) {
    const daysOverdue = Math.floor((now.getTime() - inv.dueAt.getTime()) / DAY);
    for (const d of REMINDER_DAYS) {
      const threshold = new Date(inv.dueAt.getTime() + d * DAY);
      if (daysOverdue >= d && (!inv.remindedAt || inv.remindedAt < threshold)) {
        notifier.send({ orgId: inv.hostOrgId, type: NotificationType.INVOICE_ISSUED, title: `Reminder: invoice ${inv.number} is ${daysOverdue} days overdue`, body: `£${inv.total.toFixed(2)} remains unpaid. Posting will be paused at ${CREDIT_HOLD_AFTER_DAYS} days overdue.`, data: { hostInvoiceId: inv.id } });
        db.update(hostInvoices).set({ remindedAt: now }).where(eq(hostInvoices.id, inv.id)).run();
        inv.remindedAt = now;
        result.reminders++;
        break;
      }
    }
    if (daysOverdue >= CREDIT_HOLD_AFTER_DAYS) hostsToHold.add(inv.hostOrgId);
  }
  for (const hostOrgId of hostsToHold) {
    const org = db.select({ creditHold: organisations.creditHold, name: organisations.name }).from(organisations).where(eq(organisations.id, hostOrgId)).get();
    if (!org || org.creditHold) continue;
    db.update(organisations).set({ creditHold: true, updatedAt: now }).where(eq(organisations.id, hostOrgId)).run();
    notifier.send({ orgId: hostOrgId, type: NotificationType.SYSTEM, title: 'Posting paused: invoices more than 30 days overdue', body: 'New shifts cannot be published until the overdue invoices are paid. Existing bookings are unaffected.', data: { creditHold: true } });
    if (settings.ownerOrgId) notifier.send({ orgId: settings.ownerOrgId, type: NotificationType.SYSTEM, title: `Credit hold applied: ${org.name}`, body: 'Invoices more than 30 days overdue.', data: { orgId: hostOrgId } });
    result.holdsApplied++;
  }
  // Clear holds once nothing is overdue.
  const held = db.select({ id: organisations.id, name: organisations.name }).from(organisations).where(eq(organisations.creditHold, true)).all();
  for (const org of held) {
    if (hostsToHold.has(org.id)) continue;
    const stillOverdue = db.select({ id: hostInvoices.id }).from(hostInvoices).where(and(eq(hostInvoices.hostOrgId, org.id), eq(hostInvoices.status, 'OVERDUE'))).get();
    if (stillOverdue) continue;
    db.update(organisations).set({ creditHold: false, updatedAt: now }).where(eq(organisations.id, org.id)).run();
    notifier.send({ orgId: org.id, type: NotificationType.SYSTEM, title: 'Posting resumed', body: 'Your overdue invoices are settled; you can publish shifts again.', data: { creditHold: false } });
    result.holdsCleared++;
  }
  return result;
}

export function markHostInvoicePaid(db: Db, notifier: Notifier, id: string, reference: string | null, now: Date): HostInvoice {
  const inv = db.select().from(hostInvoices).where(eq(hostInvoices.id, id)).get();
  if (!inv) throw notFound('Invoice');
  if (inv.status === 'PAID' || inv.status === 'VOID') throw conflict(`Invoice is ${inv.status.toLowerCase()}`);
  db.update(hostInvoices).set({ status: 'PAID', paidAt: now, paymentReference: reference }).where(eq(hostInvoices.id, id)).run();
  db.update(invoices).set({ status: 'PAID', paidAt: now }).where(and(eq(invoices.hostInvoiceId, id), eq(invoices.status, 'ISSUED'))).run();
  notifier.send({ orgId: inv.hostOrgId, type: NotificationType.INVOICE_ISSUED, title: `Payment received for ${inv.number}`, body: `£${inv.total.toFixed(2)}${reference ? ` · ref ${reference}` : ''}. Thank you.`, data: { hostInvoiceId: id } });
  return db.select().from(hostInvoices).where(eq(hostInvoices.id, id)).get()!;
}

export function markRemittancePaid(db: Db, notifier: Notifier, id: string, reference: string | null, now: Date): Remittance {
  const rem = db.select().from(remittances).where(eq(remittances.id, id)).get();
  if (!rem) throw notFound('Remittance');
  if (rem.status !== 'ISSUED') throw conflict(`Remittance is ${rem.status.toLowerCase()}`);
  db.update(remittances).set({ status: 'PAID', paidAt: now, paymentReference: reference }).where(eq(remittances.id, id)).run();
  notifier.send({ orgId: rem.supplierOrgId, type: NotificationType.INVOICE_ISSUED, title: `Remittance ${rem.number} paid`, body: `£${rem.total.toFixed(2)} sent${reference ? ` · ref ${reference}` : ''}.`, data: { remittanceId: id } });
  return db.select().from(remittances).where(eq(remittances.id, id)).get()!;
}

// ---------- Detail, exports and reports ----------

export interface LineDetail {
  timesheet: typeof timesheets.$inferSelect;
  shiftTitle: string;
  shiftStartsAt: Date;
  shiftEndsAt: Date;
  siteName: string;
  workerInitials: string;
  workerName: string;
  supplierName: string;
  hostName: string;
}

export function lineDetails(db: Db, invoiceId: string): LineDetail[] {
  const names = orgNames(db);
  return db
    .select({ timesheet: timesheets, shift: shifts, site: sites, worker: workers })
    .from(timesheets)
    .innerJoin(shifts, eq(shifts.id, timesheets.shiftId))
    .innerJoin(sites, eq(sites.id, shifts.siteId))
    .innerJoin(workers, eq(workers.id, timesheets.workerId))
    .where(eq(timesheets.invoiceId, invoiceId))
    .orderBy(shifts.startsAt)
    .all()
    .map(({ timesheet, shift, site, worker }) => ({
      timesheet,
      shiftTitle: shift.title,
      shiftStartsAt: shift.startsAt,
      shiftEndsAt: shift.endsAt,
      siteName: site.name,
      workerInitials: `${worker.firstName[0] ?? ''}${worker.lastName[0] ?? ''}`.toUpperCase(),
      workerName: `${worker.firstName} ${worker.lastName}`,
      supplierName: names[timesheet.supplierOrgId] ?? '',
      hostName: names[timesheet.hostOrgId] ?? '',
    }));
}

export function orgNames(db: Db): Record<string, string> {
  return Object.fromEntries(db.select({ id: organisations.id, name: organisations.name }).from(organisations).all().map((o) => [o.id, o.name]));
}

export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

const NOMINAL_CODE_AGENCY_STAFF = '7005'; // placeholder: the accountant assigns real nominal codes

/** Sage-style rows for one host invoice: one row per settlement line's timesheet. */
export function hostInvoiceCsv(db: Db, inv: HostInvoice): string {
  const lines = db.select().from(invoices).where(eq(invoices.hostInvoiceId, inv.id)).all();
  const rows: Array<Array<string | number | null>> = [['Invoice', 'Date', 'Due', 'Supplier', 'Worker', 'Site', 'Shift', 'Shift date', 'Hours', 'Rate', 'Net', 'VAT %', 'VAT', 'Gross', 'Nominal code', 'Line ref']];
  for (const l of lines) {
    for (const d of lineDetails(db, l.id)) {
      const net = d.timesheet.hostCost;
      const vat = round2((net * VAT_PCT) / 100);
      rows.push([inv.number, inv.issuedAt.toISOString().slice(0, 10), inv.dueAt.toISOString().slice(0, 10), d.supplierName, d.workerInitials, d.siteName, d.shiftTitle, d.shiftStartsAt.toISOString().slice(0, 10), d.timesheet.paidHours, d.timesheet.chargeRate, net, VAT_PCT, vat, round2(net + vat), NOMINAL_CODE_AGENCY_STAFF, l.number]);
    }
  }
  if (inv.credits) rows.push([inv.number, inv.issuedAt.toISOString().slice(0, 10), inv.dueAt.toISOString().slice(0, 10), 'Credits', '', '', 'Credits applied', '', '', '', -inv.credits, VAT_PCT, 0, -inv.credits, NOMINAL_CODE_AGENCY_STAFF, '']);
  return toCsv(rows);
}

export function remittanceCsv(db: Db, rem: Remittance): string {
  const lines = db.select().from(invoices).where(eq(invoices.remittanceId, rem.id)).all();
  const rows: Array<Array<string | number | null>> = [['Remittance', 'Date', 'Host', 'Worker', 'Site', 'Shift', 'Shift date', 'Hours', 'Charge', 'Platform fee', 'Amount to you', 'Line ref']];
  for (const l of lines) {
    for (const d of lineDetails(db, l.id)) {
      rows.push([rem.number, rem.issuedAt.toISOString().slice(0, 10), d.hostName, d.workerName, d.siteName, d.shiftTitle, d.shiftStartsAt.toISOString().slice(0, 10), d.timesheet.paidHours, d.timesheet.hostCost, d.timesheet.platformFee, d.timesheet.supplierAmount, l.number]);
    }
  }
  if (rem.credits) rows.push([rem.number, rem.issuedAt.toISOString().slice(0, 10), '', '', '', 'Credits applied', '', '', '', '', -rem.credits, '']);
  return toCsv(rows);
}

export function networkExportCsv(db: Db, type: 'lines' | 'host-invoices' | 'remittances', from: Date, to: Date): string {
  const names = orgNames(db);
  if (type === 'host-invoices') {
    const rows = db.select().from(hostInvoices).where(and(gte(hostInvoices.issuedAt, from), lte(hostInvoices.issuedAt, to))).orderBy(hostInvoices.issuedAt).all();
    return toCsv([['Invoice', 'Host', 'Issued', 'Due', 'Status', 'Subtotal', 'Credits', 'Total', 'Paid', 'Reference'], ...rows.map((r) => [r.number, names[r.hostOrgId] ?? '', r.issuedAt.toISOString().slice(0, 10), r.dueAt.toISOString().slice(0, 10), r.status, r.subtotal, r.credits, r.total, r.paidAt?.toISOString().slice(0, 10) ?? '', r.paymentReference ?? ''])]);
  }
  if (type === 'remittances') {
    const rows = db.select().from(remittances).where(and(gte(remittances.issuedAt, from), lte(remittances.issuedAt, to))).orderBy(remittances.issuedAt).all();
    return toCsv([['Remittance', 'Supplier', 'Issued', 'Status', 'Amount', 'Credits', 'Total', 'Paid', 'Reference'], ...rows.map((r) => [r.number, names[r.supplierOrgId] ?? '', r.issuedAt.toISOString().slice(0, 10), r.status, r.amount, r.credits, r.total, r.paidAt?.toISOString().slice(0, 10) ?? '', r.paymentReference ?? ''])]);
  }
  const rows = db.select().from(invoices).where(and(gte(invoices.issuedAt, from), lte(invoices.issuedAt, to))).orderBy(invoices.issuedAt).all();
  return toCsv([['Line', 'Host', 'Supplier', 'Agency sale', 'Period start', 'Period end', 'Hours', 'Charge', 'Platform fee', 'Supplier amount', 'Host invoice', 'Remittance', 'Status'], ...rows.map((r) => [r.number, names[r.hostOrgId] ?? '', names[r.supplierOrgId] ?? '', r.agencySale ? 'yes' : 'no', r.periodStart.toISOString().slice(0, 10), r.periodEnd.toISOString().slice(0, 10), r.totalHours, r.subtotal, r.platformFee, r.supplierAmount, r.hostInvoiceId ?? '', r.remittanceId ?? '', r.status])]);
}

/** Money split as the platform sees it: the owner's bank earns the full charge (decision 2). */
function effectiveSplit(ts: { platformFee: number; supplierAmount: number; hostCost: number; supplierOrgId: string }, ownerOrgId: string | null | undefined) {
  const agency = !!ownerOrgId && ts.supplierOrgId === ownerOrgId;
  return { agency, fee: agency ? 0 : ts.platformFee, supplier: agency ? ts.hostCost : ts.supplierAmount };
}

export interface ReportRow {
  key: string;
  label: string;
  hours: number;
  shifts: number;
  amount: number;
}

function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** Host spend grouped by site, supplier or month over approved timesheets for shifts in the range. */
export function spendReport(db: Db, hostOrgId: string, from: Date, to: Date, groupBy: 'site' | 'supplier' | 'month'): { rows: ReportRow[]; totals: { hours: number; shifts: number; amount: number } } {
  const names = orgNames(db);
  const rows = db
    .select({ ts: timesheets, shift: shifts, site: sites })
    .from(timesheets)
    .innerJoin(shifts, eq(shifts.id, timesheets.shiftId))
    .innerJoin(sites, eq(sites.id, shifts.siteId))
    .where(and(eq(timesheets.hostOrgId, hostOrgId), eq(timesheets.status, TimesheetStatus.APPROVED), gte(shifts.startsAt, from), lt(shifts.startsAt, to)))
    .all();
  return aggregate(rows.map(({ ts, shift, site }) => ({ key: groupBy === 'site' ? site.id : groupBy === 'supplier' ? ts.supplierOrgId : monthKey(shift.startsAt), label: groupBy === 'site' ? site.name : groupBy === 'supplier' ? (names[ts.supplierOrgId] ?? '') : monthKey(shift.startsAt), hours: ts.paidHours, amount: ts.hostCost })));
}

/** Supplier earnings grouped by host, worker or month. */
export function earningsReport(db: Db, supplierOrgId: string, ownerOrgId: string | null | undefined, from: Date, to: Date, groupBy: 'host' | 'worker' | 'month'): { rows: ReportRow[]; totals: { hours: number; shifts: number; amount: number } } {
  const names = orgNames(db);
  const rows = db
    .select({ ts: timesheets, shift: shifts, worker: workers })
    .from(timesheets)
    .innerJoin(shifts, eq(shifts.id, timesheets.shiftId))
    .innerJoin(workers, eq(workers.id, timesheets.workerId))
    .where(and(eq(timesheets.supplierOrgId, supplierOrgId), eq(timesheets.status, TimesheetStatus.APPROVED), gte(shifts.startsAt, from), lt(shifts.startsAt, to)))
    .all();
  return aggregate(rows.map(({ ts, shift, worker }) => ({ key: groupBy === 'host' ? ts.hostOrgId : groupBy === 'worker' ? worker.id : monthKey(shift.startsAt), label: groupBy === 'host' ? (names[ts.hostOrgId] ?? '') : groupBy === 'worker' ? `${worker.firstName} ${worker.lastName}` : monthKey(shift.startsAt), hours: ts.paidHours, amount: effectiveSplit(ts, ownerOrgId).supplier })));
}

function aggregate(items: Array<{ key: string; label: string; hours: number; amount: number }>) {
  const map = new Map<string, ReportRow>();
  for (const i of items) {
    const r = map.get(i.key) ?? { key: i.key, label: i.label, hours: 0, shifts: 0, amount: 0 };
    r.hours = round2(r.hours + i.hours);
    r.shifts += 1;
    r.amount = round2(r.amount + i.amount);
    map.set(i.key, r);
  }
  const rows = [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  return { rows, totals: { hours: round2(rows.reduce((s, r) => s + r.hours, 0)), shifts: rows.reduce((s, r) => s + r.shifts, 0), amount: round2(rows.reduce((s, r) => s + r.amount, 0)) } };
}

export interface AgencyPnl {
  from: string;
  to: string;
  revenue: { platformFees: number; agencySales: number; total: number };
  costOfSales: { bankWorkerPay: number };
  grossMargin: number;
  grossMarginPct: number | null;
  hours: { thirdParty: number; agencyBank: number };
  byClient: Array<{ hostOrgId: string; hostName: string; thirdPartyCharge: number; platformFees: number; agencySales: number; agencyHours: number; bankPay: number; margin: number }>;
  note: string;
}

/** Agency profit and loss (decision 2): platform fees on third-party lines plus own-bank sales, less bank worker pay. */
export function agencyPnl(db: Db, ownerOrgId: string | null | undefined, from: Date, to: Date): AgencyPnl {
  const names = orgNames(db);
  const rows = db
    .select({ ts: timesheets, shift: shifts, payRate: workers.hourlyPayRate })
    .from(timesheets)
    .innerJoin(shifts, eq(shifts.id, timesheets.shiftId))
    .innerJoin(workers, eq(workers.id, timesheets.workerId))
    .where(and(eq(timesheets.status, TimesheetStatus.APPROVED), gte(shifts.startsAt, from), lt(shifts.startsAt, to)))
    .all();
  const byClient = new Map<string, AgencyPnl['byClient'][number]>();
  let platformFees = 0;
  let agencySales = 0;
  let bankPay = 0;
  let thirdPartyHours = 0;
  let agencyHours = 0;
  for (const { ts, payRate } of rows) {
    const split = effectiveSplit(ts, ownerOrgId);
    const c = byClient.get(ts.hostOrgId) ?? { hostOrgId: ts.hostOrgId, hostName: names[ts.hostOrgId] ?? '', thirdPartyCharge: 0, platformFees: 0, agencySales: 0, agencyHours: 0, bankPay: 0, margin: 0 };
    if (split.agency) {
      const pay = round2(ts.paidHours * (payRate ?? 0));
      agencySales += ts.hostCost;
      bankPay += pay;
      agencyHours += ts.paidHours;
      c.agencySales = round2(c.agencySales + ts.hostCost);
      c.agencyHours = round2(c.agencyHours + ts.paidHours);
      c.bankPay = round2(c.bankPay + pay);
    } else {
      platformFees += ts.platformFee;
      thirdPartyHours += ts.paidHours;
      c.thirdPartyCharge = round2(c.thirdPartyCharge + ts.hostCost);
      c.platformFees = round2(c.platformFees + ts.platformFee);
    }
    c.margin = round2(c.platformFees + c.agencySales - c.bankPay);
    byClient.set(ts.hostOrgId, c);
  }
  const revenue = round2(platformFees + agencySales);
  const grossMargin = round2(revenue - bankPay);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    revenue: { platformFees: round2(platformFees), agencySales: round2(agencySales), total: revenue },
    costOfSales: { bankWorkerPay: round2(bankPay) },
    grossMargin,
    grossMarginPct: revenue > 0 ? round2((grossMargin / revenue) * 100) : null,
    hours: { thirdParty: round2(thirdPartyHours), agencyBank: round2(agencyHours) },
    byClient: [...byClient.values()].sort((a, b) => b.margin - a.margin),
    note: 'Bank worker pay is hours × the worker\'s hourly pay rate; employer on-costs, holiday pay and VAT are not included.',
  };
}

export interface BankUtilisationRow {
  workerId: string;
  name: string;
  jobRole: string;
  status: string;
  contractedHoursPerWeek: number | null;
  hoursWorked: number;
  shifts: number;
  availableHours: number | null;
  utilisationPct: number | null;
  lastShiftAt: string | null;
  idleDays: number | null;
}

/** Utilisation of the agency's own bank over the range. Zero-hours workers have no denominator; they are reported on hours alone. */
export function bankUtilisation(db: Db, ownerOrgId: string | null | undefined, from: Date, to: Date, now: Date): { weeks: number; rows: BankUtilisationRow[] } {
  if (!ownerOrgId) return { weeks: 0, rows: [] };
  const weeks = round2((to.getTime() - from.getTime()) / (7 * DAY));
  const bank = db.select().from(workers).where(eq(workers.orgId, ownerOrgId)).all();
  const worked = db
    .select({ workerId: timesheets.workerId, hours: sql<number>`coalesce(sum(${timesheets.paidHours}),0)`, shifts: sql<number>`count(*)` })
    .from(timesheets)
    .innerJoin(shifts, eq(shifts.id, timesheets.shiftId))
    .where(and(eq(timesheets.supplierOrgId, ownerOrgId), eq(timesheets.status, TimesheetStatus.APPROVED), gte(shifts.startsAt, from), lt(shifts.startsAt, to)))
    .groupBy(timesheets.workerId)
    .all();
  const workedBy = new Map(worked.map((w) => [w.workerId, w]));
  const lastShift = db
    .select({ workerId: shiftAssignments.workerId, last: sql<number>`max(${shifts.endsAt})` })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .where(and(eq(shiftAssignments.supplierOrgId, ownerOrgId), inArray(shiftAssignments.status, ['CONFIRMED', 'COMPLETED']), lte(shifts.endsAt, now)))
    .groupBy(shiftAssignments.workerId)
    .all();
  const lastBy = new Map(lastShift.map((l) => [l.workerId, l.last]));
  const rows = bank
    .map((w) => {
      const wk = workedBy.get(w.id);
      const hours = round2(wk?.hours ?? 0);
      const available = w.contractedHoursPerWeek ? round2(w.contractedHoursPerWeek * weeks) : null;
      const last = lastBy.get(w.id);
      return {
        workerId: w.id,
        name: `${w.firstName} ${w.lastName}`,
        jobRole: w.jobRole,
        status: w.status,
        contractedHoursPerWeek: w.contractedHoursPerWeek,
        hoursWorked: hours,
        shifts: wk?.shifts ?? 0,
        availableHours: available,
        utilisationPct: available ? round2((hours / available) * 100) : null,
        lastShiftAt: last ? new Date(last).toISOString() : null,
        idleDays: last ? Math.floor((now.getTime() - last) / DAY) : null,
      };
    })
    .sort((a, b) => (b.idleDays ?? 9999) - (a.idleDays ?? 9999));
  return { weeks, rows };
}

export function listHostInvoices(db: Db, where: { hostOrgId?: string; status?: string }) {
  const names = orgNames(db);
  return db
    .select()
    .from(hostInvoices)
    .where(and(where.hostOrgId ? eq(hostInvoices.hostOrgId, where.hostOrgId) : undefined, where.status ? eq(hostInvoices.status, where.status as HostInvoice['status']) : undefined))
    .orderBy(desc(hostInvoices.issuedAt))
    .all()
    .map((r) => ({ ...r, hostName: names[r.hostOrgId] ?? '' }));
}

export function listRemittances(db: Db, where: { supplierOrgId?: string; status?: string }) {
  const names = orgNames(db);
  return db
    .select()
    .from(remittances)
    .where(and(where.supplierOrgId ? eq(remittances.supplierOrgId, where.supplierOrgId) : undefined, where.status ? eq(remittances.status, where.status as Remittance['status']) : undefined))
    .orderBy(desc(remittances.issuedAt))
    .all()
    .map((r) => ({ ...r, supplierName: names[r.supplierOrgId] ?? '' }));
}

export function hostInvoiceDetail(db: Db, id: string) {
  const inv = db.select().from(hostInvoices).where(eq(hostInvoices.id, id)).get();
  if (!inv) throw notFound('Invoice');
  const names = orgNames(db);
  const lines = db.select().from(invoices).where(eq(invoices.hostInvoiceId, id)).all();
  return {
    ...inv,
    hostName: names[inv.hostOrgId] ?? '',
    lines: lines.map((l) => ({ ...l, supplierName: names[l.supplierOrgId] ?? '', timesheets: lineDetails(db, l.id).map((d) => ({ ...d.timesheet, shiftTitle: d.shiftTitle, shiftStartsAt: d.shiftStartsAt, shiftEndsAt: d.shiftEndsAt, siteName: d.siteName, workerName: d.workerName })) })),
    appliedCredits: db.select().from(credits).where(eq(credits.appliedToHostInvoiceId, id)).all(),
  };
}

export function remittanceDetail(db: Db, id: string) {
  const rem = db.select().from(remittances).where(eq(remittances.id, id)).get();
  if (!rem) throw notFound('Remittance');
  const names = orgNames(db);
  const lines = db.select().from(invoices).where(eq(invoices.remittanceId, id)).all();
  return {
    ...rem,
    supplierName: names[rem.supplierOrgId] ?? '',
    lines: lines.map((l) => ({ ...l, hostName: names[l.hostOrgId] ?? '', timesheets: lineDetails(db, l.id).map((d) => ({ ...d.timesheet, shiftTitle: d.shiftTitle, shiftStartsAt: d.shiftStartsAt, shiftEndsAt: d.shiftEndsAt, siteName: d.siteName, workerName: d.workerName })) })),
    appliedCredits: db.select().from(credits).where(eq(credits.appliedToRemittanceId, id)).all(),
  };
}
