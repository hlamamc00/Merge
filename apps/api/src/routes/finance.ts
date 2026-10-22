import { Router } from 'express';
import { and, desc, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { UserRole } from '@merge/shared';
import { credits, invoices, organisations } from '../db/schema.js';
import { auditFromReq } from '../lib/audit.js';
import { ADMINS, isPlatformAdmin, requireAuth, requireRole } from '../lib/auth.js';
import { auth, deps } from '../lib/context.js';
import { forbidden, h, notFound } from '../lib/errors.js';
import { parseBody, parseQuery, zDate } from '../lib/validate.js';
import * as settlement from '../services/settlement.js';

/**
 * Finance: the monthly settlement run, host invoices, supplier remittances, credits, overdue handling,
 * accounting exports and the agency's own P&L. Decisions 1, 2 and 5 in docs/DECISIONS.md.
 */
export const financeRouter = Router();
financeRouter.use(requireAuth);

const PLATFORM = requireRole(UserRole.PLATFORM_ADMIN);
const DAY = 86_400_000;

function sendCsv(res: Parameters<Parameters<typeof h>[0]>[1], filename: string, csv: string) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

function rangeQuery(req: Parameters<typeof deps>[0], now: Date) {
  const q = parseQuery(req, z.object({ from: zDate.optional(), to: zDate.optional(), orgId: z.string().optional() }));
  // `to` is an exclusive end for reports, so the default reaches to the end of today.
  const to = q.to ?? new Date(now.getTime() + DAY);
  const from = q.from ?? new Date(to.getTime() - 91 * DAY);
  return { from, to, orgId: q.orgId };
}

// ---------- Settlement run ----------

financeRouter.post(
  '/run',
  PLATFORM,
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { settings } = auth(req);
    const body = parseBody(req, z.object({ periodStart: zDate, periodEnd: zDate }).refine((b) => b.periodEnd > b.periodStart, { message: 'periodEnd must be after periodStart' }));
    const at = now();
    const run = settlement.runSettlement(db, notifier, settings, body, at);
    for (const inv of run.hostInvoices) auditFromReq(req, db, { action: 'CREATE', entityType: 'host_invoice', entityId: inv.id, data: { number: inv.number, total: inv.total } }, at);
    for (const rem of run.remittances) auditFromReq(req, db, { action: 'CREATE', entityType: 'remittance', entityId: rem.id, data: { number: rem.number, total: rem.total } }, at);
    res.status(201).json(run);
  }),
);

/** Overdue marking, reminders and credit holds; the scheduler calls the same function daily. */
financeRouter.post(
  '/jobs/run',
  PLATFORM,
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { settings } = auth(req);
    res.json(settlement.runFinanceJobs(db, notifier, settings, now()));
  }),
);

// ---------- Host invoices ----------

financeRouter.get(
  '/host-invoices',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db } = deps(req);
    const { org } = auth(req);
    const q = parseQuery(req, z.object({ status: z.enum(['ISSUED', 'PAID', 'OVERDUE', 'VOID']).optional(), hostOrgId: z.string().optional() }));
    const hostOrgId = isPlatformAdmin(req) ? q.hostOrgId : org.id;
    res.json(settlement.listHostInvoices(db, { hostOrgId, status: q.status }));
  }),
);

financeRouter.get(
  '/host-invoices/:id',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db } = deps(req);
    const { org } = auth(req);
    const detail = settlement.hostInvoiceDetail(db, req.params.id!);
    if (!isPlatformAdmin(req) && detail.hostOrgId !== org.id) throw forbidden();
    res.json(detail);
  }),
);

financeRouter.get(
  '/host-invoices/:id/export.csv',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db } = deps(req);
    const { org } = auth(req);
    const detail = settlement.hostInvoiceDetail(db, req.params.id!);
    if (!isPlatformAdmin(req) && detail.hostOrgId !== org.id) throw forbidden();
    sendCsv(res, `${detail.number}.csv`, settlement.hostInvoiceCsv(db, detail));
  }),
);

financeRouter.post(
  '/host-invoices/:id/mark-paid',
  PLATFORM,
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const body = parseBody(req, z.object({ reference: z.string().trim().max(120).optional().nullable() }).default({}));
    const at = now();
    const inv = settlement.markHostInvoicePaid(db, notifier, req.params.id!, body.reference ?? null, at);
    auditFromReq(req, db, { action: 'UPDATE', entityType: 'host_invoice', entityId: inv.id, data: { paid: true, reference: body.reference ?? null } }, at);
    res.json(inv);
  }),
);

// ---------- Remittances ----------

financeRouter.get(
  '/remittances',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db } = deps(req);
    const { org } = auth(req);
    const q = parseQuery(req, z.object({ status: z.enum(['ISSUED', 'PAID', 'VOID']).optional(), supplierOrgId: z.string().optional() }));
    const supplierOrgId = isPlatformAdmin(req) ? q.supplierOrgId : org.id;
    res.json(settlement.listRemittances(db, { supplierOrgId, status: q.status }));
  }),
);

financeRouter.get(
  '/remittances/:id',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db } = deps(req);
    const { org } = auth(req);
    const detail = settlement.remittanceDetail(db, req.params.id!);
    if (!isPlatformAdmin(req) && detail.supplierOrgId !== org.id) throw forbidden();
    res.json(detail);
  }),
);

financeRouter.get(
  '/remittances/:id/export.csv',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db } = deps(req);
    const { org } = auth(req);
    const detail = settlement.remittanceDetail(db, req.params.id!);
    if (!isPlatformAdmin(req) && detail.supplierOrgId !== org.id) throw forbidden();
    sendCsv(res, `${detail.number}.csv`, settlement.remittanceCsv(db, detail));
  }),
);

financeRouter.post(
  '/remittances/:id/mark-paid',
  PLATFORM,
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const body = parseBody(req, z.object({ reference: z.string().trim().max(120).optional().nullable() }).default({}));
    const at = now();
    const rem = settlement.markRemittancePaid(db, notifier, req.params.id!, body.reference ?? null, at);
    auditFromReq(req, db, { action: 'UPDATE', entityType: 'remittance', entityId: rem.id, data: { paid: true, reference: body.reference ?? null } }, at);
    res.json(rem);
  }),
);

// ---------- Credits ----------

/** A host queries a statement line; the platform decides; the credit nets off the next invoice and remittance. */
financeRouter.post(
  '/credits',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { org, user, settings } = auth(req);
    const body = parseBody(req, z.object({ invoiceId: z.string(), timesheetId: z.string().optional().nullable(), amount: z.number().positive(), reason: z.string().trim().min(3).max(500) }));
    const line = db.select({ hostOrgId: invoices.hostOrgId }).from(invoices).where(eq(invoices.id, body.invoiceId)).get();
    if (!line) throw notFound('Statement line');
    if (!isPlatformAdmin(req) && line.hostOrgId !== org.id) throw forbidden('Only the host organisation can query its statement');
    const at = now();
    const credit = settlement.requestCredit(db, notifier, settings, { ...body, requestedByUserId: user.id, hostOrgId: line.hostOrgId }, at);
    auditFromReq(req, db, { action: 'CREATE', entityType: 'credit', entityId: credit.id, data: { invoiceId: body.invoiceId, amount: body.amount } }, at);
    res.status(201).json(credit);
  }),
);

financeRouter.get(
  '/credits',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db } = deps(req);
    const { org } = auth(req);
    const q = parseQuery(req, z.object({ scope: z.enum(['payable', 'receivable', 'all']).default('payable'), status: z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'APPLIED']).optional() }));
    if (q.scope === 'all' && !isPlatformAdmin(req)) throw forbidden();
    const names = settlement.orgNames(db);
    const rows = db
      .select({ credit: credits, lineNumber: invoices.number })
      .from(credits)
      .innerJoin(invoices, eq(invoices.id, credits.invoiceId))
      .where(and(q.scope === 'payable' ? eq(credits.hostOrgId, org.id) : q.scope === 'receivable' ? eq(credits.supplierOrgId, org.id) : undefined, q.status ? eq(credits.status, q.status) : undefined))
      .orderBy(desc(credits.createdAt))
      .all();
    res.json(rows.map(({ credit, lineNumber }) => ({ ...credit, lineNumber, hostName: names[credit.hostOrgId] ?? '', supplierName: names[credit.supplierOrgId] ?? '' })));
  }),
);

for (const decision of ['approve', 'reject'] as const) {
  financeRouter.post(
    `/credits/:id/${decision}`,
    PLATFORM,
    h((req, res) => {
      const { db, now, notifier } = deps(req);
      const { user } = auth(req);
      const body = parseBody(req, z.object({ note: z.string().trim().max(500).optional().nullable() }).default({}));
      const at = now();
      const credit = settlement.decideCredit(db, notifier, req.params.id!, decision === 'approve' ? 'APPROVED' : 'REJECTED', user.id, body.note ?? null, at);
      auditFromReq(req, db, { action: 'UPDATE', entityType: 'credit', entityId: credit.id, data: { status: credit.status } }, at);
      res.json(credit);
    }),
  );
}

// ---------- Exports and reports ----------

financeRouter.get(
  '/export.csv',
  PLATFORM,
  h((req, res) => {
    const { db, now } = deps(req);
    const { from, to } = rangeQuery(req, now());
    const q = parseQuery(req, z.object({ type: z.enum(['lines', 'host-invoices', 'remittances']).default('lines') }).passthrough());
    sendCsv(res, `merge-${q.type}-${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}.csv`, settlement.networkExportCsv(db, q.type, from, to));
  }),
);

/** What a host has spent, over approved timesheets for shifts in the range. */
financeRouter.get(
  '/spend',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db, now } = deps(req);
    const { org } = auth(req);
    const { from, to, orgId } = rangeQuery(req, now());
    const q = parseQuery(req, z.object({ groupBy: z.enum(['site', 'supplier', 'month']).default('site') }).passthrough());
    const hostOrgId = isPlatformAdmin(req) && orgId ? orgId : org.id;
    res.json({ from: from.toISOString(), to: to.toISOString(), groupBy: q.groupBy, ...settlement.spendReport(db, hostOrgId, from, to, q.groupBy) });
  }),
);

/** What a supplier has earned (the agency's own bank earns the full charge). */
financeRouter.get(
  '/earnings',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db, now } = deps(req);
    const { org, settings } = auth(req);
    const { from, to, orgId } = rangeQuery(req, now());
    const q = parseQuery(req, z.object({ groupBy: z.enum(['host', 'worker', 'month']).default('host') }).passthrough());
    const supplierOrgId = isPlatformAdmin(req) && orgId ? orgId : org.id;
    res.json({ from: from.toISOString(), to: to.toISOString(), groupBy: q.groupBy, ...settlement.earningsReport(db, supplierOrgId, settings.ownerOrgId, from, to, q.groupBy) });
  }),
);

/** Snapshot for the statements page: what is open, overdue and awaiting a decision. */
financeRouter.get(
  '/summary',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db } = deps(req);
    const { org } = auth(req);
    const platform = isPlatformAdmin(req);
    const hostInvoices = settlement.listHostInvoices(db, { hostOrgId: platform ? undefined : org.id });
    const remittances = settlement.listRemittances(db, { supplierOrgId: platform ? undefined : org.id });
    const pendingCredits = db
      .select({ id: credits.id })
      .from(credits)
      .where(and(eq(credits.status, 'REQUESTED'), platform ? undefined : or(eq(credits.hostOrgId, org.id), eq(credits.supplierOrgId, org.id))))
      .all().length;
    const creditHold = db.select({ creditHold: organisations.creditHold }).from(organisations).where(eq(organisations.id, org.id)).get()?.creditHold ?? false;
    const sum = (rows: Array<{ total: number }>) => Math.round(rows.reduce((s, r) => s + r.total, 0) * 100) / 100;
    res.json({
      outstanding: sum(hostInvoices.filter((i) => i.status === 'ISSUED' || i.status === 'OVERDUE')),
      overdue: sum(hostInvoices.filter((i) => i.status === 'OVERDUE')),
      overdueCount: hostInvoices.filter((i) => i.status === 'OVERDUE').length,
      remittancesDue: sum(remittances.filter((r) => r.status === 'ISSUED')),
      pendingCredits,
      creditHold,
    });
  }),
);

// ---------- Agency ----------

financeRouter.get(
  '/agency/pnl',
  PLATFORM,
  h((req, res) => {
    const { db, now } = deps(req);
    const { settings } = auth(req);
    const { from, to } = rangeQuery(req, now());
    res.json(settlement.agencyPnl(db, settings.ownerOrgId, from, to));
  }),
);

financeRouter.get(
  '/agency/bank-utilisation',
  PLATFORM,
  h((req, res) => {
    const { db, now } = deps(req);
    const { settings } = auth(req);
    const at = now();
    const { from, to } = rangeQuery(req, at);
    res.json({ from: from.toISOString(), to: to.toISOString(), ...settlement.bankUtilisation(db, settings.ownerOrgId, from, to, at) });
  }),
);
