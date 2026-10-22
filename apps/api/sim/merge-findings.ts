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
const existing = new Set((result.gaps as Gap[]).map((g) => g.id));
let added = 0;
for (const f of findings) {
  if (existing.has(f.id)) continue;
  (result.gaps as Gap[]).push({ ...f, month: 5, occurrences: 1 });
  added++;
}
const order: Record<GapSeverity, number> = { blocker: 0, high: 1, medium: 2, low: 3 };
(result.gaps as Gap[]).sort((a, b) => order[a.severity] - order[b.severity] || a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
writeFileSync(resolve(dir, 'result.json'), JSON.stringify(result, null, 1));
writeFileSync(resolve(import.meta.dirname ?? '.', '../../../docs/SIMULATION-REPORT.md'), renderReport(result));
console.log(`Merged ${added} persona finding(s); gap register now has ${result.gaps.length} entries.`);
