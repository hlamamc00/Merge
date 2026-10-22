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
/** Defects corrected during the exercise (see the "Fixed during the exercise" section of the report). */
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
};
/**
 * Persona verifiers attached a decision to every finding. Only those that materially change what gets built
 * are kept as questions for the platform owner; for the rest the proposal takes a sensible default.
 */
const KEEP_DECISION = new Set(['PH-01', 'PH-02', 'PH-03', 'PR-02', 'PR-04', 'PW-03', 'PA-01', 'PA-04', 'PF-03', 'PC-01', 'PM-06', 'PS-01', 'PT-01', 'PT-02', 'PT-03', 'PT-06']);
for (const f of findings) if (!KEEP_DECISION.has(f.id)) delete f.decisionNeeded;
const existing = new Set((result.gaps as Gap[]).map((g) => g.id));
for (const g of result.gaps as Gap[]) {
  if (extensions[g.id]) g.evidence += extensions[g.id];
}
let added = 0;
for (const f of findings) {
  if (existing.has(f.id)) continue;
  (result.gaps as Gap[]).push({ ...f, month: 5, occurrences: 1, status: FIXED[f.id] ? 'fixed' : 'open' });
  added++;
}
for (const g of result.gaps as Gap[]) if (FIXED[g.id] && !g.status) g.status = 'fixed';
(result as { fixed?: Record<string, string> }).fixed = FIXED;
const order: Record<GapSeverity, number> = { blocker: 0, high: 1, medium: 2, low: 3 };
(result.gaps as Gap[]).sort((a, b) => order[a.severity] - order[b.severity] || a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
writeFileSync(resolve(dir, 'result.json'), JSON.stringify(result, null, 1));
writeFileSync(resolve(import.meta.dirname ?? '.', '../../../docs/SIMULATION-REPORT.md'), renderReport(result));
console.log(`Merged ${added} persona finding(s); gap register now has ${result.gaps.length} entries.`);
