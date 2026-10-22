/** Re-derive week-based findings and re-render the report from sim-output/result.json without re-running. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GapRegister, type Gap } from './lib.js';
import { deriveGapsFromWeeks } from './derive.js';
import { renderReport } from './report.js';

const dir = resolve(import.meta.dirname ?? '.', '../sim-output');
const result = JSON.parse(readFileSync(resolve(dir, 'result.json'), 'utf8'));
const reg = new GapRegister();
for (const g of result.gaps as Gap[]) reg.gaps.set(g.id, g);
deriveGapsFromWeeks(reg, result.weeks);
result.gaps = reg.list();
writeFileSync(resolve(dir, 'result.json'), JSON.stringify(result, null, 1));
writeFileSync(resolve(import.meta.dirname ?? '.', '../../../docs/SIMULATION-REPORT.md'), renderReport(result));
console.log(`Report re-rendered with ${result.gaps.length} gaps.`);
