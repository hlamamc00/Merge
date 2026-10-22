/** Render the simulation result as a Markdown report. */
import type { Gap } from './lib.js';
import type { WeekStats } from './scenario.js';
import { observations } from './derive.js';

interface Result {
  config: { weeks: number; seed: number; start: string; stepHours: number };
  elapsedMinutes: number;
  apiCalls: number;
  providers: Array<{ name: string; size: string; staff: number; sites: number; joinWeek: number; status: string; noShowsCaused: number }>;
  weeks: WeekStats[];
  tasks: Array<{ task: string; occurrences: number; calls: number; callsPerOccurrence: number; errors: number; p95ms: number }>;
  notificationsByType: Record<string, number>;
  gaps: Gap[];
  log: string[];
  fixed?: Record<string, string>;
}

/** Verifier text can contain line breaks and nested bullets, which break the report's own lists; flatten it. */
function flat(text: string): string {
  return text.replace(/^\s*[-*•]\s+/, '').replace(/\s*\n+\s*(?:[-*•]\s+)?/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** Long verifier evidence is cut at a sentence boundary for the report; the full text stays in result.json. */
function trim(raw: string, max = 900): string {
  const text = flat(raw);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return `${cut.slice(0, end > 300 ? end + 1 : max)} …`;
}

const sum = (xs: number[]) => xs.reduce((s, n) => s + n, 0);
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '–');
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const fmtMin = (m: number | null) => (m == null ? '–' : m < 60 ? `${m} min` : `${Math.round((m / 60) * 10) / 10} h`);

export function renderReport(r: Result): string {
  const months: WeekStats[][] = [];
  for (const w of r.weeks) (months[Math.floor(w.week / 4.33)] ??= []).push(w);
  const monthRows = months
    .map((ws, i) => {
      const posted = sum(ws.map((w) => w.shiftsPosted));
      const places = sum(ws.map((w) => w.placesPosted));
      const filled = sum(ws.map((w) => w.placesFilled));
      const expired = sum(ws.map((w) => w.shiftsExpiredUnfilled));
      const conf = sum(ws.map((w) => w.confirmations));
      const pr = sum(ws.map((w) => w.confirmedViaPriority));
      const ag = sum(ws.map((w) => w.confirmedViaAgency));
      const ttf = median(ws.flatMap((w) => w.timeToFillMinutes));
      const last = ws[ws.length - 1]!;
      return `| ${i + 1} | ${ws[0]!.weekStart} | ${last.providers} | ${last.workers.toLocaleString()} | ${posted} | ${sum(ws.map((w) => w.urgentPosted))} | ${pct(filled, places)} | ${expired} | ${pct(pr, conf)} / ${pct(ag, conf)} | ${fmtMin(ttf)} | ${sum(ws.map((w) => w.lateCancellations))} / ${sum(ws.map((w) => w.noShows))} | ${Math.round(sum(ws.map((w) => w.hoursTraded))).toLocaleString()} | £${Math.round(sum(ws.map((w) => w.chargeTraded))).toLocaleString()} | £${Math.round(sum(ws.map((w) => w.platformFee))).toLocaleString()} |`;
    })
    .join('\n');

  const totals = {
    posted: sum(r.weeks.map((w) => w.shiftsPosted)),
    places: sum(r.weeks.map((w) => w.placesPosted)),
    filled: sum(r.weeks.map((w) => w.placesFilled)),
    expired: sum(r.weeks.map((w) => w.shiftsExpiredUnfilled)),
    conf: sum(r.weeks.map((w) => w.confirmations)),
    pr: sum(r.weeks.map((w) => w.confirmedViaPriority)),
    ag: sum(r.weeks.map((w) => w.confirmedViaAgency)),
    hours: sum(r.weeks.map((w) => w.hoursTraded)),
    charge: sum(r.weeks.map((w) => w.chargeTraded)),
    fee: sum(r.weeks.map((w) => w.platformFee)),
    late: sum(r.weeks.map((w) => w.lateCancellations)),
    noShows: sum(r.weeks.map((w) => w.noShows)),
    notifications: sum(r.weeks.map((w) => w.notificationsSent)),
  };

  const taskRows = r.tasks
    .filter((t) => t.occurrences > 0 && !t.task.startsWith('Try to') && t.task !== 'untagged')
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 30)
    .map((t) => `| ${t.task} | ${t.occurrences.toLocaleString()} | ${t.calls.toLocaleString()} | ${t.callsPerOccurrence} | ${t.errors} | ${t.p95ms} ms |`)
    .join('\n');

  const refusals = new Map<string, number>();
  for (const w of r.weeks) for (const [k, v] of Object.entries(w.requestsRefused)) refusals.set(k, (refusals.get(k) ?? 0) + v);
  const refusalRows = [...refusals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k, v]) => `| ${k} | ${v.toLocaleString()} |`)
    .join('\n');

  const notifRows = Object.entries(r.notificationsByType)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `| ${k} | ${v.toLocaleString()} |`)
    .join('\n');

  const errors = new Map<string, number>();
  for (const w of r.weeks) for (const [k, v] of Object.entries(w.apiErrors)) errors.set(k, (errors.get(k) ?? 0) + v);
  const errorRows = [...errors.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k, v]) => `| ${k} | ${v.toLocaleString()} |`)
    .join('\n');

  const sevIcon: Record<string, string> = { blocker: '🟥 Blocker', high: '🟧 High', medium: '🟨 Medium', low: '⬜ Low' };
  const byCategory = new Map<string, Gap[]>();
  for (const g of r.gaps) byCategory.set(g.category, [...(byCategory.get(g.category) ?? []), g]);
  const gapSections = [...byCategory.entries()]
    .map(
      ([cat, gaps]) =>
        `### ${cat}\n\n` +
        gaps
          .map(
            (g) =>
              `#### ${g.id} · ${g.title}\n\n` +
              `**Severity:** ${sevIcon[g.severity]} · **Seen by:** ${g.persona} · **First hit:** month ${g.month + 1}${g.occurrences > 1 ? ` · **Recurred:** ${g.occurrences}×` : ''}${g.status === 'fixed' ? ' · **Status:** ✅ fixed during the exercise' : ''}\n\n` +
              `- **What happened:** ${trim(g.evidence)}\n` +
              `- **Why it matters:** ${flat(g.impact)}\n` +
              `- **Proposed solution:** ${flat(g.proposal)}\n` +
              (g.decisionNeeded ? `- **Decision needed:** ${flat(g.decisionNeeded)}\n` : ''),
          )
          .join('\n'),
    )
    .join('\n');

  const decisions = r.gaps.filter((g) => g.decisionNeeded).map((g, i) => `${i + 1}. **${g.id}** – ${flat(g.decisionNeeded!)}`).join('\n');
  const counts = { blocker: 0, high: 0, medium: 0, low: 0 } as Record<string, number>;
  for (const g of r.gaps) counts[g.severity]!++;

  const providerRows = r.providers.map((p) => `| ${p.name} | ${p.size} | ${p.staff} | ${p.sites} | ${p.joinWeek + 1} | ${p.status} |`).join('\n');

  return `# Merge six-month market-entry simulation

_Generated by \`npm run sim -w @merge/api\` (seed ${r.config.seed}, ${r.config.weeks} weeks from ${r.config.start.slice(0, 10)}, ${r.config.stepHours}-hour steps). ${r.apiCalls.toLocaleString()} API calls in ${r.elapsedMinutes} minutes of machine time. Re-run after changes to see what moved._

## What was simulated

A staffing agency ("Merge Staffing") launches the platform with a bank of 25 workers, growing to 45. Twenty care providers join over 18 weeks: two large groups (400 and 250 staff, 8 and 5 sites), six medium homes and twelve small services. Every worker is onboarded the way the platform allows today (one record, six to eight documents, a verification each). Each week every provider's staffing balance drifts with winter pressure (peaking mid-January) and random shocks; short-staffed providers post shifts with realistic lead times (55% three to ten days ahead, 25% one to three days, 20% same day), over-staffed providers raise surplus flags, suppliers and self-service workers check the board at their own rhythm and put eligible workers forward, hosts confirm first-come-first-served, workers clock in and out, hosts approve or dispute timesheets, and the agency issues monthly statements. Scripted events test a worker changing employer, a host blocking an unreliable supplier, the agency bank being released first for four weeks, a CQC-style records request, a non-paying host being suspended, a data-subject request, and a provider leaving.

Every action is a real HTTP call to the API as that person would make it, so "calls per task" below is a direct measure of how laborious the task is in the product today.

### Providers

| Organisation | Size | Staff | Sites | Joined (week) | Status at end |
| --- | --- | --- | --- | --- | --- |
${providerRows}

## Month by month

| Month | From | Providers | Workers | Shifts posted | Urgent | Places filled | Started unfilled | Filled via priority / agency | Median time to fill | Late cancels / no-shows | Hours traded | Charged | Platform fee |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${monthRows}
| **Total** | | | | **${totals.posted.toLocaleString()}** | ${sum(r.weeks.map((w) => w.urgentPosted))} | **${pct(totals.filled, totals.places)}** | **${totals.expired}** | ${pct(totals.pr, totals.conf)} / ${pct(totals.ag, totals.conf)} | ${fmtMin(median(r.weeks.flatMap((w) => w.timeToFillMinutes)))} | ${totals.late} / ${totals.noShows} | **${Math.round(totals.hours).toLocaleString()}** | **£${Math.round(totals.charge).toLocaleString()}** | **£${Math.round(totals.fee).toLocaleString()}** |

"Filled via priority" is the share of confirmed bookings whose supplier had priority access from a surplus flag or preferred-partner status; "agency" is the share filled by the agency's own bank. Weeks 17–20 ran with the agency bank released first; compare the agency share in months 4–5 with the rest.

## What the numbers say

${observations(r.weeks, r.providers).map((o) => `- **${o.title}.** ${o.detail}`).join('\n')}

## Ease of use: how many calls each task needed

| Task | Times performed | API calls | Calls per task | Errors | p95 latency |
| --- | --- | --- | --- | --- | --- |
${taskRows}

Anything above 1 call per task is a place where a person is doing work the platform could do for them. Onboarding a worker today costs about 15 calls (record, 6–8 documents, verification each); a 400-person employer therefore needs roughly 6,000 actions before its staff can be traded.

## Why requests were refused

Blocker codes returned by the eligibility check when suppliers looked for someone to put forward (one row per worker per look-up).

| Reason | Count |
| --- | --- |
${refusalRows}

## Notifications generated

${totals.notifications.toLocaleString()} in total, all in-app.

| Type | Count |
| --- | --- |
${notifRows}

## API errors seen by simulated users

| Status and endpoint | Count |
| --- | --- |
${errorRows || '| none | 0 |'}

## Gap register

${counts.blocker} blockers, ${counts.high} high, ${counts.medium} medium, ${counts.low} low. Ids starting with a scripted prefix (ONB, DSP, CMP, FIN, …) come from the scripted six-month run; ids starting with P (PH, PR, PW, PA, PF, PC, PM, PS, PT) come from persona walkthroughs of the end state by an HR manager, a small-home rota manager, a care worker on a phone, the agency owner, a host finance clerk, a compliance officer, a registered manager facing inspection, a supplier rota manager and an IT/data-protection lead, each finding checked by an independent verifier against the running system. Each gap records what the simulated person tried, what the platform did, and a proposed solution. Where the solution needs a product decision, it is listed under **Decisions needed** at the end.

${gapSections}

## Fixed during the exercise

These were defects rather than product gaps, so they were corrected in the codebase as part of this run (the re-run reflects the fixes):

${r.fixed ? Object.entries(r.fixed).map(([id, what]) => `- **${id}** – ${what}`).join('\n') : 'None.'}

## Decisions needed

${decisions || 'None.'}

## Run log

\`\`\`
${r.log.join('\n')}
\`\`\`
`;
}
