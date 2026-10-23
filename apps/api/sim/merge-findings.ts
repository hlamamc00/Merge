/**
 * Merge verified persona-walkthrough findings (sim-output/persona-findings.json) into the gap register
 * and re-render docs/SIMULATION-REPORT.md.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderReport } from './report.js';
import type { Gap, GapCategory, GapSeverity } from './lib.js';

const dir = resolve(import.meta.dirname ?? '.', '../sim-output');
const result = JSON.parse(readFileSync(resolve(dir, 'result.json'), 'utf8'));
const findingsPath = resolve(dir, 'persona-findings.json');
if (!existsSync(findingsPath)) {
  console.error('No persona-findings.json found');
  process.exit(1);
}
const findings = JSON.parse(readFileSync(findingsPath, 'utf8')) as Array<{
  id: string;
  title: string;
  category: GapCategory;
  severity: GapSeverity;
  persona: string;
  evidence: string;
  impact: string;
  proposal: string;
  decisionNeeded?: string;
}>;
const extensionsPath = resolve(dir, 'persona-extensions.json');
const extensions = existsSync(extensionsPath) ? (JSON.parse(readFileSync(extensionsPath, 'utf8')) as Record<string, string>) : {};
/**
 * Persona findings answered in the codebase: defects corrected during the exercise and phase-1 features that
 * meet a finding (see the "Fixed during the exercise" section of the report). Each sentence states what now exists.
 */
const FIXED: Record<string, string> = {
  'PH-02': 'A worker login now ends when the worker record is deactivated (requireAuth and login check the linked worker). Cancelling or reassigning a leaver\'s future bookings remains open; see WF-02.',
  'PT-04': 'Worker logins can no longer read or edit colleagues\' records; organisation-wide worker access needs a manager role.',
  'PF-01': 'Statement runs now bill every approved, un-invoiced timesheet up to the period end, so late approvals are caught up.',
  'PR-01': 'Site access notes are released only to an organisation with a confirmed booking on that shift.',
  'PT-01': 'New organisations register as PENDING and must be approved by the platform before they can publish or receive shifts.',
  'PC-04': 'Expiry alerts skip documents superseded by a newer verified one.',
  'PM-05': 'The release plan is kept when a shift starts or is cancelled, as the record of who was offered it and when.',
  'PR-03': 'When a cancellation reopens a filled shift, organisations whose stage is open are notified again.',
  'PW-03': 'Worker logins no longer see the inter-organisation charge rate as if it were their pay.',
  'PH-01': 'Workers have a home site (workers.homeSiteId, set from the import sheet or on the record); GET /workers?siteId= and the compliance reports filter by it.',
  'PH-03': 'A manager can be limited to some of the organisation\'s sites (decision 10): a site-limited manager sees and posts only those sites\' shifts, sees only workers based there or unassigned, and cannot read or change pay rates or private notes.',
  'PH-04': 'GET /compliance/expiring?days= lists documents expiring within the horizon (already-expired ones included) for the organisation or one site.',
  'PH-05': 'Contracted hours count towards the 48-hour check by default; the employer records a worker\'s actual hours for any ISO week (PUT /workers/:id/weeks/:monday, in bulk via POST /workers/week-hours, or by naming the staff a surplus flag frees), and the agency reads hours and utilisation per bank worker from GET /finance/agency/bank-utilisation.',
  'PR-02': 'A host sees a "meets mandatory requirements" compliance status for each candidate and booked worker rather than the documents (decision 11), and can state its own requirements (GET/POST /compliance/requirements) against which suppliers declare their workers.',
  'PR-05': 'A pattern of shifts is posted as a series (POST /shifts/series, cancelled as one with POST /shifts/series/:id/cancel) and a single shift is copied with POST /shifts/:id/copy.',
  'PA-01': 'A platform-wide floor charge rate is derived from the minimum wage plus employer on-costs and the platform fee (GET /shifts/floor-rate, decision 3) and a shift cannot be posted below it; there is no rate card beyond the floor.',
  'PA-02': 'Timesheets left undecided for 14 days are approved automatically and picked up by the next settlement run, so a suspended or silent host\'s debt is invoiced and its suppliers are paid.',
  'PA-04': 'GET /finance/agency/pnl?from&to reports platform fees, own-bank sales, bank worker pay, gross margin and a per-client breakdown (decision 2); VAT and employer on-costs are not included.',
  'PA-05': 'GET /finance/agency/bank-utilisation?from&to reports hours worked and utilisation per bank worker over the range.',
  'PF-02': 'Host invoices and remittances are marked paid by the platform with a payment reference (POST /finance/host-invoices/:id/mark-paid, POST /finance/remittances/:id/mark-paid); the other party is notified and the audit trail records who did it.',
  'PF-03': 'A host queries a line on an issued invoice (POST /finance/credits naming the timesheet, amount and reason); the platform approves or rejects it and an approved credit nets off the next invoice and remittance (decision 5).',
  'PF-06': 'Submitted timesheets carry exception flags (late clock-in, over length, missing clock-out, submitted late), can be approved in bulk (POST /timesheets/bulk-approve), and auto-approve after 14 days of host silence.',
  'PC-03': 'Correcting a document supersedes the old version instead of editing it in place; the history stays on the record (and in the worker\'s export) and a verified document cannot be deleted.',
  'PC-06': 'Hosts define their own requirements, such as a site induction (POST /compliance/requirements), and record which workers meet them (POST /compliance/requirements/:id/workers).',
  'PM-01': 'A host bars a named worker from all or one of its sites with a reason (POST /trust/bars); future bookings with that host are released and the employer is told.',
  'PM-02': 'A host reports a concern about a lent worker to the employer (POST /trust/reports); the employer acknowledges and closes it, and the report stays on the worker\'s record (decision 14).',
  'PS-01': 'A pending request is a soft hold: a firm booking elsewhere takes priority and releases it, and the platform operator is reminded of requests unanswered for 12 hours or within 24 hours of the start (decision 7).',
  'PT-03': 'Authenticator-app two-factor is built in and compulsory for admins and managers, accounts lock after repeated failed sign-ins, passwords must be at least 10 characters and not common, and passwords can be changed or reset by email; Microsoft single sign-on is deferred to after go-live (decision 16).',
  'PT-05': 'GET /organisations/:id/audit?userId=&from=&to= filters the audit log by user and period.',
};
/**
 * Persona verifiers attached a decision to every finding. Only those that materially change what gets built
 * are kept as questions for the platform owner; for the rest the proposal takes a sensible default.
 * A finding that is fixed carries no decision: what remains is said in its sentence above.
 */
const KEEP_DECISION = new Set(['PH-01', 'PH-02', 'PH-03', 'PR-02', 'PR-04', 'PW-03', 'PA-01', 'PA-04', 'PF-03', 'PC-01', 'PM-06', 'PS-01', 'PT-01', 'PT-02', 'PT-03', 'PT-06']);
for (const f of findings) if (!KEEP_DECISION.has(f.id) || FIXED[f.id]) delete f.decisionNeeded;
const existing = new Set((result.gaps as Gap[]).map((g) => g.id));
let added = 0;
for (const f of findings) {
  if (existing.has(f.id)) continue;
  (result.gaps as Gap[]).push({ ...f, month: 5, occurrences: 1, status: FIXED[f.id] ? 'fixed' : 'open' });
  added++;
}
// Extensions apply to scripted and persona gaps alike, so they run once everything is in the register;
// a gap verified fixed keeps its own evidence, since the walkthrough notes describe the old state.
for (const g of result.gaps as Gap[]) {
  if (FIXED[g.id] && !g.status) g.status = 'fixed';
  if (g.status === 'fixed') delete g.decisionNeeded;
  else if (extensions[g.id] && !g.evidence.includes(extensions[g.id]!)) g.evidence += extensions[g.id]; // idempotent on re-runs
}
(result as { fixed?: Record<string, string> }).fixed = FIXED;
const order: Record<GapSeverity, number> = { blocker: 0, high: 1, medium: 2, low: 3 };
(result.gaps as Gap[]).sort((a, b) => order[a.severity] - order[b.severity] || a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
writeFileSync(resolve(dir, 'result.json'), JSON.stringify(result, null, 1));
writeFileSync(resolve(import.meta.dirname ?? '.', '../../../docs/SIMULATION-REPORT.md'), renderReport(result));
console.log(`Merged ${added} persona finding(s); gap register now has ${result.gaps.length} entries.`);
