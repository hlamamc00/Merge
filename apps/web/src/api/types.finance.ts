/** Types for the finance build: settlement lines, host invoices, remittances, credits and reports. */
import type { Invoice, Timesheet, TimesheetListItem } from './types';

export type HostInvoiceStatus = 'ISSUED' | 'PAID' | 'OVERDUE' | 'VOID';
export type RemittanceStatus = 'ISSUED' | 'PAID' | 'VOID';
export type CreditStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'APPLIED';

/** A per host/supplier settlement line (the legacy "statement"), now rolled up into invoices and remittances. */
export interface SettlementLine extends Invoice {
  agencySale: boolean;
  hostInvoiceId: string | null;
  remittanceId: string | null;
}

export interface HostInvoice {
  id: string;
  number: string;
  hostOrgId: string;
  hostName?: string;
  periodStart: string;
  periodEnd: string;
  status: HostInvoiceStatus;
  currency: string;
  subtotal: number;
  credits: number;
  total: number;
  dueAt: string;
  issuedAt: string;
  paidAt: string | null;
  paymentReference: string | null;
  remindedAt: string | null;
}

export interface Remittance {
  id: string;
  number: string;
  supplierOrgId: string;
  supplierName?: string;
  periodStart: string;
  periodEnd: string;
  status: RemittanceStatus;
  currency: string;
  amount: number;
  credits: number;
  total: number;
  issuedAt: string;
  paidAt: string | null;
  paymentReference: string | null;
}

export interface LineTimesheet extends Timesheet {
  shiftTitle: string;
  shiftStartsAt: string;
  shiftEndsAt: string;
  siteName: string;
  workerName: string;
}

export interface Credit {
  id: string;
  invoiceId: string;
  timesheetId: string | null;
  hostOrgId: string;
  supplierOrgId: string;
  amount: number;
  reason: string;
  status: CreditStatus;
  requestedByUserId: string | null;
  decidedByUserId: string | null;
  appliedToHostInvoiceId: string | null;
  appliedToRemittanceId: string | null;
  createdAt: string;
  decidedAt: string | null;
  lineNumber?: string;
  hostName?: string;
  supplierName?: string;
}

export interface HostInvoiceDetail extends HostInvoice {
  lines: (SettlementLine & { supplierName: string; timesheets: LineTimesheet[] })[];
  appliedCredits: Credit[];
}

export interface RemittanceDetail extends Remittance {
  lines: (SettlementLine & { hostName: string; timesheets: LineTimesheet[] })[];
  appliedCredits: Credit[];
}

export interface SettlementRunResult {
  lines: SettlementLine[];
  hostInvoices: HostInvoice[];
  remittances: Remittance[];
}

export interface FinanceJobsResult {
  markedOverdue: number;
  reminders: number;
  holdsApplied: number;
  holdsCleared: number;
}

export interface FinanceSummary {
  outstanding: number;
  overdue: number;
  overdueCount: number;
  remittancesDue: number;
  pendingCredits: number;
  creditHold: boolean;
}

export interface ReportRow {
  key: string;
  label: string;
  hours: number;
  shifts: number;
  amount: number;
}

export interface ReportResult {
  from: string;
  to: string;
  groupBy: string;
  rows: ReportRow[];
  totals: { hours: number; shifts: number; amount: number };
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

export interface BankUtilisation {
  from: string;
  to: string;
  weeks: number;
  rows: BankUtilisationRow[];
}

export type TimesheetException = 'OVER_LENGTH' | 'MISSING_CLOCK_OUT' | 'LATE_CLOCK_IN' | 'SUBMITTED_LATE';

export const EXCEPTION_LABELS: Record<TimesheetException, string> = {
  OVER_LENGTH: 'Over length',
  MISSING_CLOCK_OUT: 'No clock-out',
  LATE_CLOCK_IN: 'Late clock-in',
  SUBMITTED_LATE: 'Submitted late',
};

export interface TimesheetRow extends TimesheetListItem {
  exceptions?: TimesheetException[];
}

export interface BulkApproveResponse {
  approved: number;
  failed: number;
  results: Array<{ id: string; ok: boolean; status?: string; error?: string }>;
}
