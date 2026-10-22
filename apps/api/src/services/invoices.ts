import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { InvoiceStatus, NotificationType, TimesheetStatus, round2 } from '@merge/shared';
import type { Db } from '../db/client.js';
import { invoices, organisations, shifts, timesheets, type Invoice } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import type { Notifier } from '../lib/notify.js';

export interface GenerateInvoicesInput {
  periodStart: Date;
  periodEnd: Date;
  /** Restrict to one host (payer) or one supplier (payee). */
  hostOrgId?: string;
  supplierOrgId?: string;
}

export interface GenerateInvoicesOptions {
  /** The platform owner: supply from its own bank is an agency sale (decision 2), with no platform fee. */
  ownerOrgId?: string | null;
  /** Whether to notify both parties per line; the settlement run notifies per invoice/remittance instead. */
  notify?: boolean;
}

/**
 * Turn approved, un-invoiced timesheets for shifts up to the period end into one settlement line per
 * host/supplier pair. The host owes `subtotal`; the platform keeps `platformFee`; the supplier receives
 * `supplierAmount`. Lines are then rolled up into host invoices and remittances by `runSettlement`.
 *
 * @deprecated as a stand-alone step: `POST /invoices/generate` keeps working for compatibility, but the
 * settlement run (`POST /finance/run`) is what produces what hosts pay and suppliers receive.
 */
export function generateInvoices(db: Db, notifier: Notifier, input: GenerateInvoicesInput, now: Date, opts: GenerateInvoicesOptions = {}): Invoice[] {
  const notify = opts.notify ?? true;
  // Everything approved and not yet invoiced up to the period end is billed, so a timesheet approved after
  // last month's run is picked up this month rather than falling between two statements.
  const conditions = [eq(timesheets.status, TimesheetStatus.APPROVED), isNull(timesheets.invoiceId), lt(shifts.startsAt, input.periodEnd)];
  if (input.hostOrgId) conditions.push(eq(timesheets.hostOrgId, input.hostOrgId));
  if (input.supplierOrgId) conditions.push(eq(timesheets.supplierOrgId, input.supplierOrgId));
  const rows = db.select({ ts: timesheets, currency: shifts.currency }).from(timesheets).innerJoin(shifts, eq(shifts.id, timesheets.shiftId)).where(and(...conditions)).all();

  // One line per host / supplier / currency: amounts in different currencies are never summed together.
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.ts.hostOrgId}|${r.ts.supplierOrgId}|${r.currency}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  const created: Invoice[] = [];
  let seq = db.select({ id: invoices.id }).from(invoices).all().length;
  for (const [key, group] of groups) {
    const [hostOrgId, supplierOrgId, currency] = key.split('|') as [string, string, string];
    seq += 1;
    const id = newId('inv');
    const agencySale = !!opts.ownerOrgId && supplierOrgId === opts.ownerOrgId;
    const totals = group.reduce(
      (acc, { ts }) => ({ hours: acc.hours + ts.paidHours, subtotal: acc.subtotal + ts.hostCost, fee: acc.fee + ts.platformFee, supplier: acc.supplier + ts.supplierAmount }),
      { hours: 0, subtotal: 0, fee: 0, supplier: 0 },
    );
    db.insert(invoices)
      .values({
        id,
        number: `MRG-${now.getUTCFullYear()}-${String(seq).padStart(5, '0')}`,
        hostOrgId,
        supplierOrgId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        status: InvoiceStatus.ISSUED,
        currency,
        totalHours: round2(totals.hours),
        subtotal: round2(totals.subtotal),
        // Decision 2: the agency's own bank is the agency's own sale, so no platform fee is deducted.
        platformFee: agencySale ? 0 : round2(totals.fee),
        supplierAmount: agencySale ? round2(totals.subtotal) : round2(totals.supplier),
        agencySale,
        issuedAt: now,
        createdAt: now,
      })
      .run();
    db.update(timesheets).set({ invoiceId: id, updatedAt: now }).where(inArray(timesheets.id, group.map((g) => g.ts.id))).run();
    const inv = db.select().from(invoices).where(eq(invoices.id, id)).get()!;
    created.push(inv);
    if (notify) {
      const supplierName = db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, supplierOrgId)).get()?.name;
      const hostName = db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, hostOrgId)).get()?.name;
      notifier.send({ orgId: hostOrgId, type: NotificationType.INVOICE_ISSUED, title: `Statement ${inv.number} issued`, body: `£${inv.subtotal.toFixed(2)} payable for ${inv.totalHours}h supplied by ${supplierName}.`, data: { invoiceId: id } });
      notifier.send({ orgId: supplierOrgId, type: NotificationType.INVOICE_ISSUED, title: `Statement ${inv.number} issued`, body: `£${inv.supplierAmount.toFixed(2)} due to you for ${inv.totalHours}h supplied to ${hostName}${agencySale ? '' : ` (after £${inv.platformFee.toFixed(2)} platform fee)`}.`, data: { invoiceId: id } });
    }
  }
  return created;
}
