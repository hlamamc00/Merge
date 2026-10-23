/**
 * Six-month market-entry simulation of Merge.
 *
 *   npm run sim -w @merge/api                 # 26 weeks, seed 42
 *   npm run sim -w @merge/api -- --weeks 4    # shorter smoke run
 *
 * Boots the real API in-process with a controllable clock, plays out the scenario through HTTP,
 * then writes sim-output/result.json, docs/SIMULATION-REPORT.md and apps/api/data/sim.db
 * (so the web app can be pointed at the end state: DATABASE_URL=./data/sim.db npm run dev:api).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { silentChannels } from '../src/services/mail.js';
import { setOutboxChannels } from '../src/services/scheduler.js';
import { openDatabase, runMigrations } from '../src/db/client.js';
import type { NotificationChannel } from '../src/lib/notify.js';
import { ApiClient, Clock, DAY, GapRegister, HOUR, Rng, fmtDate, listOf } from './lib.js';
import * as ev from './events.js';
import { renderReport } from './report.js';
import { deriveGapsFromWeeks } from './derive.js';
import {
  SIM_START,
  Stats,
  World,
  afterShifts,
  bootstrapAgency,
  cancellations,
  complianceRound,
  hostApprovals,
  hostCheck,
  hostDirectOffers,
  manageFlags,
  monthEnd,
  onboardProvider,
  planWeek,
  postDueShifts,
  recordWorkerExpiryGap,
  resolveDisputes,
  refreshFloorRate,
  runTotals,
  settlePayments,
  supplierCheck,
  workerCheck,
  type OutboundMail,
  type ProviderSpec,
  type SimContext,
} from './scenario.js';

const args = process.argv.slice(2);
const arg = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const WEEKS = arg('weeks', 26);
const SEED = arg('seed', 42);
const STEP_HOURS = 2;

const PROVIDERS: ProviderSpec[] = [
  { name: 'Northern Care Group', size: 'large', staff: 400, sites: 8, serviceType: 'NURSING', joinWeek: 0, autoEscalate: true, balance: { CARE: -14, SENIOR: -3, NURSE: -3 } },
  { name: 'Riverside Living', size: 'medium', staff: 45, sites: 1, serviceType: 'RESIDENTIAL', joinWeek: 0, selfService: true, balance: { CARE: 4, SENIOR: 1, NURSE: 0 } },
  { name: 'Oakwood Care Homes', size: 'medium', staff: 90, sites: 2, serviceType: 'NURSING', joinWeek: 0, balance: { CARE: -5, SENIOR: -1, NURSE: -1 } },
  { name: 'Bright Horizons Support', size: 'small', staff: 22, sites: 1, serviceType: 'SUPPORTED_LIVING', joinWeek: 2, balance: { CARE: 2, SENIOR: 0, NURSE: 0 } },
  { name: 'Meadow View', size: 'small', staff: 18, sites: 1, serviceType: 'RESIDENTIAL', joinWeek: 2, autoEscalate: true, balance: { CARE: -2, SENIOR: 0, NURSE: 0 }, reliability: 0.85 },
  { name: 'Pennine Nursing', size: 'medium', staff: 70, sites: 2, serviceType: 'NURSING', joinWeek: 4, balance: { CARE: -2, SENIOR: 0, NURSE: -2 } },
  { name: 'Hillside Care', size: 'small', staff: 25, sites: 1, serviceType: 'RESIDENTIAL', joinWeek: 4, selfService: true, balance: { CARE: 3, SENIOR: 1, NURSE: 0 } },
  { name: 'Lakeside Lodge', size: 'small', staff: 14, sites: 1, serviceType: 'RESIDENTIAL', joinWeek: 4, payLagDays: 95, balance: { CARE: -1, SENIOR: 0, NURSE: 0 } },
  { name: 'Trafford Care Partnership', size: 'large', staff: 250, sites: 5, serviceType: 'RESIDENTIAL', joinWeek: 6, selfService: true, balance: { CARE: 6, SENIOR: 2, NURSE: 0 } },
  { name: 'Willow Homecare', size: 'small', staff: 30, sites: 1, serviceType: 'DOMICILIARY', joinWeek: 6, balance: { CARE: 2, SENIOR: 0, NURSE: 0 } },
  { name: "St Anne's Residential", size: 'medium', staff: 55, sites: 1, serviceType: 'RESIDENTIAL', joinWeek: 9, autoConfirm: true, autoEscalate: true, balance: { CARE: -3, SENIOR: -1, NURSE: 0 } },
  { name: 'Cedar Court', size: 'medium', staff: 60, sites: 1, serviceType: 'NURSING', joinWeek: 9, balance: { CARE: 1, SENIOR: 0, NURSE: -1 } },
  { name: 'Sunnybank', size: 'small', staff: 16, sites: 1, serviceType: 'RESIDENTIAL', joinWeek: 9, balance: { CARE: -1, SENIOR: 0, NURSE: 0 } },
  { name: 'Harmony Supported Living', size: 'small', staff: 28, sites: 1, serviceType: 'SUPPORTED_LIVING', joinWeek: 9, selfService: true, balance: { CARE: 3, SENIOR: 0, NURSE: 0 } },
  { name: 'Greenfield Manor', size: 'medium', staff: 48, sites: 1, serviceType: 'NURSING', joinWeek: 12, autoEscalate: true, reliability: 0.9, balance: { CARE: -4, SENIOR: -1, NURSE: -1 } },
  { name: 'Birch House', size: 'small', staff: 12, sites: 1, serviceType: 'RESIDENTIAL', joinWeek: 12, balance: { CARE: 1, SENIOR: 0, NURSE: 0 } },
  { name: 'Elm Tree Care', size: 'small', staff: 20, sites: 1, serviceType: 'RESIDENTIAL', joinWeek: 15, balance: { CARE: -2, SENIOR: 0, NURSE: 0 } },
  { name: 'Mosaic Community Support', size: 'small', staff: 26, sites: 1, serviceType: 'SUPPORTED_LIVING', joinWeek: 15, balance: { CARE: 2, SENIOR: 1, NURSE: 0 } },
  { name: 'Northgate Nursing', size: 'medium', staff: 65, sites: 2, serviceType: 'NURSING', joinWeek: 18, autoEscalate: true, balance: { CARE: -3, SENIOR: 0, NURSE: -2 } },
  { name: 'The Beeches', size: 'small', staff: 15, sites: 1, serviceType: 'RESIDENTIAL', joinWeek: 18, balance: { CARE: 1, SENIOR: 0, NURSE: 0 } },
];

async function main() {
  const startedAt = performance.now();
  const clock = new Clock(new Date(SIM_START));
  const { db, sqlite } = openDatabase(':memory:');
  runMigrations(db);
  const stats = new Stats();
  const notificationsByType = new Map<string, number>();
  const notificationsPerOrgDay = new Map<string, number>();
  const channel: NotificationChannel = {
    name: 'sim-counter',
    send(n) {
      notificationsByType.set(n.type, (notificationsByType.get(n.type) ?? 0) + 1);
      const key = `${n.orgId}|${fmtDate(clock.now)}`;
      notificationsPerOrgDay.set(key, (notificationsPerOrgDay.get(key) ?? 0) + 1);
      if (stats.current) stats.current.notificationsSent++;
    },
  };
  setOutboxChannels(silentChannels); // emails stay in outbound_messages for the personas' mailboxes; nothing is printed
  const { app } = createApp({ db, now: () => clock.now, channels: [channel] });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  const api = new ApiClient(`http://127.0.0.1:${port}`);
  api.onSuspended = (token, error) => {
    const org = world.orgs.find((o) => o.adminToken === token || o.managerToken === token || o.siteManagerToken === token || o.workers.some((w) => w.token === token));
    if (!org || org.status !== 'ACTIVE') return;
    org.status = 'SUSPENDED';
    log(`${fmtDate(clock.now)} ${org.name} was suspended by the platform (${error}); its people are locked out until the agency reinstates it`);
  };
  const rng = new Rng(SEED);
  const gaps = new GapRegister();
  const world = new World();
  const logLines: string[] = [];
  const log = (m: string) => {
    logLines.push(m);
    console.log(m);
  };
  const mailbox = (email: string): string | null => {
    try {
      const row = sqlite.prepare(`select body from outbound_messages where channel = 'EMAIL' and to_address = ? order by created_at desc limit 1`).get(email) as { body: string } | undefined;
      return row?.body ?? null;
    } catch {
      return null; // table absent on an older API
    }
  };
  const countEmails = (predicate: (m: OutboundMail) => boolean): number => {
    try {
      const rows = sqlite.prepare(`select to_address "to", subject, body, created_at createdAt from outbound_messages where channel = 'EMAIL'`).all() as OutboundMail[];
      return rows.filter(predicate).length;
    } catch {
      return 0; // table absent on an older API
    }
  };
  const ctx: SimContext = { api, clock, rng, gaps, log, world, stats, mailbox, countEmails };
  const tick = () => api.post('/api/v1/admin/scheduler/tick', world.platformAdminToken);

  log(`Merge market-entry simulation: ${WEEKS} weeks from ${fmtDate(SIM_START)}, seed ${SEED}`);
  stats.startWeek(0, SIM_START, 0, 0);
  await bootstrapAgency(ctx, 25);
  let lastMonthEnd = new Date(SIM_START);
  let agencyFirstActive = false;

  for (let week = 0; week < WEEKS; week++) {
    const weekStart = new Date(SIM_START.getTime() + week * 7 * DAY);
    clock.set(weekStart);
    if (week > 0) stats.startWeek(week, weekStart, world.providers().length, world.workerCount());
    for (const spec of PROVIDERS.filter((p) => p.joinWeek === week)) {
      const org = await onboardProvider(ctx, spec);
      org.joinWeek = week;
      if (week === 0 && spec.size === 'large') {
        await ev.probeMissingEndpoints(ctx, org);
      }
      if (spec.selfService) await ev.probeWorkerSelfUpload(ctx, org);
    }
    stats.current.providers = world.providers().length;
    stats.current.workers = world.workerCount();
    await refreshFloorRate(ctx);
    for (const org of world.activeOrgs()) {
      planWeek(ctx, org, week);
      await manageFlags(ctx, org, week);
    }

    for (let day = 0; day < 7; day++) {
      for (let step = 0; step < 24 / STEP_HOURS; step++) {
        clock.set(new Date(weekStart.getTime() + day * DAY + step * STEP_HOURS * HOUR));
        const hour = clock.now.getUTCHours();
        const t = await tick();
        if (t.status === 200) {
          stats.current.shiftsExpiredUnfilled += t.body.shifts?.expired ?? 0;
          // What the daily jobs did, for the finance evidence (FIN-01, FIN-02).
          runTotals.markedOverdue += t.body.finance?.markedOverdue ?? 0;
          runTotals.financeReminders += t.body.finance?.reminders ?? 0;
          runTotals.creditHoldsApplied += t.body.finance?.holdsApplied ?? 0;
          runTotals.autoApproved += t.body.autoApproved ?? 0;
        }
        for (const org of rng.shuffle(world.activeOrgs())) {
          await postDueShifts(ctx, org);
          if (org.checkHours.includes(hour)) {
            await supplierCheck(ctx, org);
            await hostCheck(ctx, org);
            await afterShifts(ctx, org);
            await hostApprovals(ctx, org);
            await resolveDisputes(ctx, org);
          }
          if (hour === 10) {
            await hostDirectOffers(ctx, org);
            await cancellations(ctx, org);
          }
          if (hour === 14 || hour === 20) await workerCheck(ctx, org);
        }
        if (hour === 10) await settlePayments(ctx);
        if (day === 2 && hour === 8) for (const org of world.activeOrgs()) await complianceRound(ctx, org);
        // Month end: first step of a new calendar month.
        if (clock.now.getUTCDate() === 1 && hour === 8) {
          await monthEnd(ctx, lastMonthEnd, clock.now);
          lastMonthEnd = new Date(clock.now);
        }
        // Scripted events, Monday 14:00 of the given week.
        if (day === 0 && hour === 14) await runEvents(ctx, week);
      }
    }
    // Week-end bookkeeping.
    const pending = await api.get('/api/v1/timesheets?scope=all&status=SUBMITTED', world.platformAdminToken);
    stats.current.timesheetsPendingEnd = listOf(pending).length;
    try {
      const since = weekStart.getTime();
      stats.current.escalatedShifts = (sqlite.prepare(`select count(*) c from shifts s join organisations o on o.id = s.host_org_id where s.escalation_step > 0 and o.escalation_mode = 'AUTO' and s.published_at >= ?`).get(since) as { c: number }).c;
      stats.current.emailsSent = (sqlite.prepare(`select count(*) c from outbound_messages where channel = 'EMAIL' and created_at >= ?`).get(since) as { c: number }).c;
    } catch {
      /* columns absent on an older API */
    }
    log(ev.describeWeek(ctx, week));
    void agencyFirstActive;
  }

  // End-of-run probes.
  const host = world.providers().find((o) => o.size === 'large') ?? world.providers()[0]!;
  await ev.probeReporting(ctx, host);
  await ev.probePagination(ctx);
  await ev.probeDaylightSaving(ctx);
  await ev.probeNotificationVolume(ctx, notificationsPerOrgDay, notificationsByType, stats.weeks.reduce((s, w) => s + (w.emailsSent ?? 0), 0));
  recordWorkerExpiryGap(ctx, true);
  // How auto-escalated shifts ended: started with someone confirmed, or still unfilled.
  let escalation: { shifts: number; filled: number; expired: number } | null = null;
  try {
    const row = sqlite.prepare(`select count(*) shifts, coalesce(sum(case when s.status in ('IN_PROGRESS','COMPLETED') then 1 else 0 end), 0) filled, coalesce(sum(case when s.status = 'EXPIRED' then 1 else 0 end), 0) expired from shifts s join organisations o on o.id = s.host_org_id where s.escalation_step > 0 and o.escalation_mode = 'AUTO' and s.status in ('IN_PROGRESS','COMPLETED','EXPIRED')`).get() as { shifts: number; filled: number; expired: number };
    if (row.shifts > 0) escalation = row;
  } catch {
    /* columns absent on an older API */
  }
  deriveGapsFromData(ctx, sqlite, escalation);
  deriveGapsFromWeeks(gaps, stats.weeks, { workerRequests: api.taskOccurrences.get('Worker requests a shift') ?? 0 });

  const elapsedMin = Math.round(((performance.now() - startedAt) / 60_000) * 10) / 10;
  const result = {
    config: { weeks: WEEKS, seed: SEED, start: SIM_START.toISOString(), stepHours: STEP_HOURS },
    elapsedMinutes: elapsedMin,
    apiCalls: api.calls.length,
    providers: world.orgs.filter((o) => o.type === 'PROVIDER').map((o) => ({ name: o.name, size: o.size, staff: o.workers.length, sites: o.sites.length, joinWeek: o.joinWeek, status: o.status, noShowsCaused: o.noShowsCaused, onboarding: o.onboarding })),
    weeks: stats.weeks,
    escalation,
    tasks: api.taskSummary().sort((a, b) => b.calls - a.calls),
    notificationsByType: Object.fromEntries(notificationsByType),
    gaps: gaps.list(),
    log: logLines,
  };
  const outDir = resolve(import.meta.dirname ?? '.', '../sim-output');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'result.json'), JSON.stringify(result, null, 1));
  writeFileSync(resolve(import.meta.dirname ?? '.', '../../../docs/SIMULATION-REPORT.md'), renderReport(result));
  const dbOut = resolve(import.meta.dirname ?? '.', '../data/sim.db');
  mkdirSync(resolve(import.meta.dirname ?? '.', '../data'), { recursive: true });
  await sqlite.backup(dbOut);
  server.close();
  sqlite.close();
  log(`\nDone in ${elapsedMin} min, ${api.calls.length.toLocaleString()} API calls. Report: docs/SIMULATION-REPORT.md · data: apps/api/data/sim.db · raw: apps/api/sim-output/result.json`);
}

async function runEvents(ctx: SimContext, week: number) {
  const { world, api, log, clock } = ctx;
  const byName = (n: string) => world.orgs.find((o) => o.name === n);
  switch (week) {
    case 8: {
      const from = byName('Riverside Living');
      const to = byName('Oakwood Care Homes');
      if (from && to) await ev.probeWorkerTransfer(ctx, from, to);
      break;
    }
    case 13: {
      const host = byName('Northern Care Group');
      if (host) await ev.probeBlocklist(ctx, host);
      break;
    }
    case 14: {
      // The agency grows its bank in response to winter demand.
      const { addBankWorkers } = await import('./growth.js');
      await addBankWorkers(ctx, 20);
      break;
    }
    case 16: {
      await api.task('Platform settings', 'agency owner', () => api.patch('/api/v1/admin/settings', world.platformAdminToken, { agencyPosition: 'FIRST' }));
      log(`${fmtDate(clock.now)} EXPERIMENT: agency bank now released FIRST (for 4 weeks)`);
      break;
    }
    case 17: {
      const host = byName('Northern Care Group');
      if (host) await ev.probeInspectorRequest(ctx, host);
      break;
    }
    case 20: {
      await api.task('Platform settings', 'agency owner', () => api.patch('/api/v1/admin/settings', world.platformAdminToken, { agencyPosition: 'AFTER_PRIORITY' }));
      log(`${fmtDate(clock.now)} EXPERIMENT ends: agency position back to AFTER_PRIORITY`);
      const late = byName('Lakeside Lodge');
      if (late) await ev.probeSuspension(ctx, late);
      break;
    }
    case 21: {
      const org = byName('Riverside Living');
      if (org) await ev.probeDataSubjectRequest(ctx, org);
      break;
    }
    case 23: {
      const org = byName('Birch House');
      if (org) await ev.probeOffboarding(ctx, org);
      break;
    }
  }
}

/** Monday of the ISO week holding the instant, as a date key (weeks are compared in UTC; a London Monday 00:00 lands on the same date). */
function mondayKey(ms: number): string {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Findings that only show up in the data after months of activity. */
function deriveGapsFromData(ctx: SimContext, sqlite: import('better-sqlite3').Database, escalation: { shifts: number; filled: number; expired: number } | null) {
  const { gaps, stats, world } = ctx;
  // 1. Weekly hours with the employer (contracted, or the week's recorded figure) plus platform bookings, per worker-week.
  //    A worker who has signed the 48-hour opt-out may lawfully exceed it, so those weeks are counted separately.
  const bookings = sqlite.prepare(`select a.worker_id workerId, s.starts_at startsAt, (s.ends_at - s.starts_at)/3600000.0 - s.break_minutes/60.0 hrs from shift_assignments a join shifts s on s.id = a.shift_id where a.status in ('CONFIRMED','COMPLETED')`).all() as Array<{ workerId: string; startsAt: number; hrs: number }>;
  const people = new Map((sqlite.prepare(`select id, first_name || ' ' || last_name name, contracted_hours_per_week contracted, opted_out_of_48h optedOut from workers`).all() as Array<{ id: string; name: string; contracted: number; optedOut: number }>).map((p) => [p.id, p]));
  const overrides = new Map<string, number>();
  try {
    for (const r of sqlite.prepare(`select worker_id workerId, week_start weekStart, internal_hours internalHours from worker_week_hours`).all() as Array<{ workerId: string; weekStart: number; internalHours: number }>) overrides.set(`${r.workerId}|${mondayKey(r.weekStart + 12 * HOUR)}`, r.internalHours);
  } catch {
    /* table absent on an older API */
  }
  const weekly = new Map<string, number>();
  for (const b of bookings) {
    const key = `${b.workerId}|${mondayKey(b.startsAt)}`;
    weekly.set(key, (weekly.get(key) ?? 0) + b.hrs);
  }
  const over: Array<{ name: string; internal: number; platform: number }> = [];
  let optedOutWeeks = 0;
  for (const [key, platform] of weekly) {
    const [workerId] = key.split('|');
    const p = people.get(workerId!);
    if (!p) continue;
    const internal = overrides.get(key) ?? p.contracted;
    if (internal + platform <= 48) continue;
    if (p.optedOut) optedOutWeeks++;
    else over.push({ name: p.name, internal, platform });
  }
  over.sort((a, b) => b.platform - a.platform);
  const wf03 = { id: 'WF-03', category: 'Workforce' as const, severity: 'blocker' as const, persona: 'worker / employer (Working Time Regulations)', month: 5 };
  if (over.length > 0) {
    gaps.record({
      ...wf03,
      title: 'The 48-hour limit can still be exceeded',
      evidence: `${over.length} worker-week(s) exceeded 48 hours once the employer's hours (contracted, or the figure recorded for that week) are added to platform bookings, for workers who have not signed an opt-out, e.g. ${over.slice(0, 5).map((o) => `${o.name}: ${o.internal}h with the employer + ${o.platform.toFixed(1)}h on the platform`).join('; ')}. ${optedOutWeeks} further worker-week(s) over 48 belonged to workers with a signed opt-out, which is lawful.`,
      impact: 'Fatigued workers, a regulatory breach for the employer, and an avoidable safeguarding risk at the host.',
      proposal: 'Check why the cap was passed (a booking made before the week\'s hours were recorded, or an override lowered after the booking); show the running total before a request and re-check bookings when the employer\'s figure changes.',
    });
  } else {
    gaps.record({
      ...wf03,
      title: 'The 48-hour check counts the worker\'s hours with their employer',
      status: 'fixed',
      evidence: `No worker-week exceeded 48 hours once the employer's hours were added to platform bookings, apart from ${optedOutWeeks} week(s) belonging to workers who have signed the opt-out, which is lawful. Contracted hours count by default (decision 8), the employer records the actual hours for any ISO week (PUT /workers/:id/weeks/:monday, in bulk, or by naming the staff a surplus flag frees), and both the request and the confirmation re-check the cap.`,
      impact: 'The platform no longer books a worker into a breach of the Working Time Regulations on the employer\'s behalf.',
      proposal: 'Keep: contracted hours by default with weekly overrides; a rota import would remove the manual step.',
    });
  }
  // 1b. Eligibility look-ups evaluate every worker of the supplier on every call.
  const elig = ctx.api.taskSummary().find((t) => t.task === 'Find an eligible worker for a shift');
  const largest = Math.max(...world.orgs.map((o) => o.workers.length));
  if (elig && elig.p95ms > 75) {
    gaps.record({
      id: 'SCL-02',
      title: 'Eligibility is recomputed for every worker on every look-up',
      category: 'Scale & performance',
      severity: 'medium',
      persona: 'rota manager at a large supplier',
      month: 1,
      evidence: `"Find an eligible worker" ran ${elig.occurrences.toLocaleString()} times with a p95 of ${elig.p95ms} ms on an in-memory database; each call loads documents, bookings and unavailability for every worker of the organisation (up to ${largest}) and evaluates them all, so the cost grows with headcount and with history.`,
      impact: 'On a real database over the network the biggest employers, who matter most for supply, get the slowest screens.',
      proposal: 'Pre-filter in SQL by role cover, shareable and active; cache each worker\'s compliance snapshot and weekly hours; evaluate the remaining candidates only.',
    });
  }
  // 2. Refusal reasons: what suppliers hit most when trying to put people forward.
  const refusals = new Map<string, number>();
  for (const w of stats.weeks) for (const [k, v] of Object.entries(w.requestsRefused)) refusals.set(k, (refusals.get(k) ?? 0) + v);
  const top = [...refusals.entries()].sort((a, b) => b[1] - a[1]);
  const roleNoise = refusals.get('ROLE_MISMATCH') ?? 0;
  const total = [...refusals.values()].reduce((s, n) => s + n, 0);
  if (roleNoise > total * 0.3) {
    gaps.record({
      id: 'DSP-07',
      title: 'The "put a worker forward" list evaluates every worker, so most rows are irrelevant',
      category: 'Shifts & dispatch',
      severity: 'medium',
      persona: 'rota manager at a supplier',
      month: 3,
      evidence: `Across the run the eligibility list produced ${total.toLocaleString()} blocker rows; ${roleNoise.toLocaleString()} (${Math.round((roleNoise / total) * 100)}%) were simply "wrong role". Top reasons: ${top.slice(0, 5).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
      impact: 'A 400-person employer scrolls past hundreds of nurses and seniors to find the care assistants who could cover a care-assistant shift.',
      proposal: 'Pre-filter by role cover and shareable, show eligible first, collapse the rest under "not eligible (N)", and let the manager search by name.',
    });
  }
  // 3. Late cancellations and no-shows with no consequence (already covered by TRS-01 when the blocklist probe ran; add numbers).
  const late = stats.weeks.reduce((s, w) => s + w.lateCancellations, 0);
  const noShows = stats.weeks.reduce((s, w) => s + w.noShows, 0);
  const existing = gaps.gaps.get('TRS-01');
  if (existing) existing.evidence += ` Over the run: ${late} late cancellations and ${noShows} no-shows network-wide.`;
  // 4. Unfilled shifts: did anything escalate them (decision 6), and how did the escalated ones end?
  const expired = stats.weeks.reduce((s, w) => s + w.shiftsExpiredUnfilled, 0);
  const posted = stats.weeks.reduce((s, w) => s + w.shiftsPosted, 0);
  let escalatedAll = 0;
  try {
    escalatedAll = (sqlite.prepare(`select count(*) c from shifts where escalation_step > 0`).get() as { c: number }).c;
  } catch {
    /* column absent on an older API */
  }
  const dsp01 = { id: 'DSP-01', category: 'Shifts & dispatch' as const, severity: 'high' as const, persona: 'rota manager at a host', month: 2 };
  if (escalatedAll > 0) {
    const auto = escalation ?? { shifts: 0, filled: 0, expired: 0 };
    gaps.record({
      ...dsp01,
      title: 'Unfilled shifts escalate automatically within the host\'s ceiling, or by hand',
      status: 'fixed',
      evidence: `${escalatedAll} shifts were escalated as they neared their start (rate raised in steps within the host's ceiling, reach widened; hosts choose automatic or manual, decision 6). Of the ${auto.shifts} automatically escalated shifts that had started by the end of the run, ${auto.filled} started with someone confirmed and ${auto.expired} still went unfilled. Overall ${expired} of ${posted} shifts (${posted ? Math.round((expired / posted) * 100) : 0}%) started with nobody confirmed: escalation moves the odds, it does not create staff. Manual hosts get a prompt and POST /shifts/:id/escalate.`,
      impact: 'A host no longer has to notice and edit the shift by hand to change its terms or reach.',
      proposal: 'Keep: escalation steps and ceilings; an SMS blast to eligible workers waits on the provider decision (decision 15).',
    });
  } else if (expired > 0) {
    gaps.record({
      ...dsp01,
      title: 'Nothing escalates an unfilled shift: no auto-widening, rate uplift or agency fallback',
      evidence: `${expired} of ${posted} shifts (${Math.round((expired / posted) * 100)}%) started with nobody confirmed. The only intervention available was an in-app warning 24 hours before; the rate, visibility and window never changed unless a manager edited the shift by hand.`,
      impact: 'Hosts fall back to phoning agencies, which is exactly what the platform set out to replace.',
      proposal: 'Escalation playbooks per host: at T-48h/T-24h/T-6h widen visibility, raise the rate by a step, release to the agency bank, and send an SMS blast to eligible workers; show the host what will happen and when.',
      decisionNeeded: 'Should rate uplifts on unfilled shifts be automatic (host sets a ceiling) or always a manual decision?',
    });
  }
  void world;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
