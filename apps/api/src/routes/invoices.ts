import { Router } from 'express';
import { and, desc, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { InvoiceStatus } from '@merge/shared';
import { invoices, organisations, shifts, timesheets, workers } from '../db/schema.js';
import { auditFromReq } from '../lib/audit.js';
import { ADMINS, isPlatformAdmin, requireAuth, requireRole } from '../lib/auth.js';
import { auth, deps } from '../lib/context.js';
import { conflict, forbidden, h, notFound } from '../lib/errors.js';
import { parseBody, parseQuery, zDate } from '../lib/validate.js';
import { generateInvoices } from '../services/invoices.js';

export const invoicesRouter = Router();
invoicesRouter.use(requireAuth);

invoicesRouter.get(
  '/',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db } = deps(req);
    const { org } = auth(req);
    const q = parseQuery(req, z.object({ scope: z.enum(['payable', 'receivable', 'all']).default('payable') }));
    if (q.scope === 'all' && !isPlatformAdmin(req)) throw forbidden();
    const rows = db
      .select()
      .from(invoices)
      .where(q.scope === 'payable' ? eq(invoices.hostOrgId, org.id) : q.scope === 'receivable' ? eq(invoices.supplierOrgId, org.id) : undefined)
      .orderBy(desc(invoices.createdAt))
      .all();
    const names = Object.fromEntries(db.select({ id: organisations.id, name: organisations.name }).from(organisations).all().map((o) => [o.id, o.name]));
    res.json(rows.map((i) => ({ ...i, hostName: names[i.hostOrgId], supplierName: names[i.supplierOrgId] })));
  }),
);

invoicesRouter.get(
  '/:id',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db } = deps(req);
    const { org } = auth(req);
    const inv = db.select().from(invoices).where(eq(invoices.id, req.params.id!)).get();
    if (!inv) throw notFound('Statement');
    if (!isPlatformAdmin(req) && inv.hostOrgId !== org.id && inv.supplierOrgId !== org.id) throw forbidden();
    const lines = db
      .select({ timesheet: timesheets, shift: shifts, worker: workers })
      .from(timesheets)
      .innerJoin(shifts, eq(shifts.id, timesheets.shiftId))
      .innerJoin(workers, eq(workers.id, timesheets.workerId))
      .where(eq(timesheets.invoiceId, inv.id))
      .all();
    const names = Object.fromEntries(db.select({ id: organisations.id, name: organisations.name }).from(organisations).all().map((o) => [o.id, o.name]));
    res.json({
      ...inv,
      hostName: names[inv.hostOrgId],
      supplierName: names[inv.supplierOrgId],
      lines: lines.map(({ timesheet, shift, worker }) => ({ ...timesheet, shift: { id: shift.id, title: shift.title, jobRole: shift.jobRole, startsAt: shift.startsAt, endsAt: shift.endsAt }, worker: { id: worker.id, firstName: worker.firstName, lastName: worker.lastName } })),
    });
  }),
);

/** Turn approved timesheets into statements. Platform admins can run it network-wide; org admins only for their own organisation. */
invoicesRouter.post(
  '/generate',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db, now, notifier } = deps(req);
    const { org } = auth(req);
    const body = parseBody(req, z.object({ periodStart: zDate, periodEnd: zDate, hostOrgId: z.string().optional(), supplierOrgId: z.string().optional() }).refine((b) => b.periodEnd > b.periodStart, { message: 'periodEnd must be after periodStart' }));
    if (!isPlatformAdmin(req)) {
      if (body.hostOrgId && body.hostOrgId !== org.id) throw forbidden();
      if (body.supplierOrgId && body.supplierOrgId !== org.id) throw forbidden();
      if (!body.hostOrgId && !body.supplierOrgId) body.hostOrgId = org.id;
    }
    const at = now();
    const created = generateInvoices(db, notifier, body, at);
    for (const inv of created) auditFromReq(req, db, { action: 'CREATE', entityType: 'invoice', entityId: inv.id, data: { number: inv.number } }, at);
    res.status(201).json(created);
  }),
);

invoicesRouter.post(
  '/:id/mark-paid',
  requireRole(...ADMINS),
  h((req, res) => {
    const { db, now } = deps(req);
    const { org } = auth(req);
    const inv = db.select().from(invoices).where(and(eq(invoices.id, req.params.id!), or(eq(invoices.hostOrgId, org.id), eq(invoices.supplierOrgId, org.id)))).get() ?? (isPlatformAdmin(req) ? db.select().from(invoices).where(eq(invoices.id, req.params.id!)).get() : undefined);
    if (!inv) throw notFound('Statement');
    if (inv.status !== InvoiceStatus.ISSUED) throw conflict(`Statement is ${inv.status.toLowerCase()}`);
    const at = now();
    db.update(invoices).set({ status: InvoiceStatus.PAID, paidAt: at }).where(eq(invoices.id, inv.id)).run();
    auditFromReq(req, db, { action: 'UPDATE', entityType: 'invoice', entityId: inv.id, data: { paid: true } }, at);
    res.json(db.select().from(invoices).where(eq(invoices.id, inv.id)).get());
  }),
);
