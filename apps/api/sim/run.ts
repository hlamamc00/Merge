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
import { openDatabase, runMigrations } from '../src/db/client.js';
import type { NotificationChannel } from '../src/lib/notify.js';
import { ApiClient, Clock, DAY, GapRegister, HOUR, Rng, fmtDate } from './lib.js';
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
  resolveDisputes,
  refreshFloorRate,
  settlePayments,
  supplierCheck,
  workerCheck,
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
  const { app } = createApp({ db, now: () => clock.now, channels: [channel] });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  const api = new ApiClient(`http://127.0.0.1:${port}`);
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
  const ctx: SimContext = { api, clock, rng, gaps, log, world, stats, mailbox };
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
        if (t.status === 200) stats.current.shiftsExpiredUnfilled += t.body.shifts?.expired ?? 0;
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
    stats.current.timesheetsPendingEnd = ((pending.body as any[]) ?? []).length;
    try {
      const since = weekStart.getTime();
      stats.current.escalatedShifts = (sqlite.prepare(`select count(*) c from shifts where escalation_step > 0 and published_at >= ?`).get(since) as { c: number }).c;
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
  await ev.probeNotificationVolume(ctx, notificationsPerOrgDay, notificationsByType);
  deriveGapsFromData(ctx, sqlite);
  deriveGapsFromWeeks(gaps, stats.weeks);

  const elapsedMin = Math.round(((performance.now() - startedAt) / 60_000) * 10) / 10;
  const result = {
    config: { weeks: WEEKS, seed: SEED, start: SIM_START.toISOString(), stepHours: STEP_HOURS },
    elapsedMinutes: elapsedMin,
    apiCalls: api.calls.length,
    providers: world.orgs.filter((o) => o.type === 'PROVIDER').map((o) => ({ name: o.name, size: o.size, staff: o.workers.length, sites: o.sites.length, joinWeek: o.joinWeek, status: o.status, noShowsCaused: o.noShowsCaused })),
    weeks: stats.weeks,
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

/** Findings that only show up in the data after months of activity. */
function deriveGapsFromData(ctx: SimContext, sqlite: import('better-sqlite3').Database) {
  const { gaps, stats, world } = ctx;
  // 1. Weekly platform hours on top of contracted hours (the platform does not know the internal rota).
  const over = sqlite
    .prepare(
      `with weekly as (
         select a.worker_id, strftime('%Y-%W', s.starts_at/1000, 'unixepoch') wk,
                sum((s.ends_at - s.starts_at)/3600000.0 - s.break_minutes/60.0) hrs
         from shift_assignments a join shifts s on s.id = a.shift_id
         where a.status in ('CONFIRMED','COMPLETED') group by 1,2)
       select w.first_name || ' ' || w.last_name name, w.contracted_hours_per_week contracted, max(weekly.hrs) platform_hrs
       from weekly join workers w on w.id = weekly.worker_id
       where w.contracted_hours_per_week + weekly.hrs > 48
       group by w.id order by platform_hrs desc limit 5`,
    )
    .all() as Array<{ name: string; contracted: number; platform_hrs: number }>;
  const overCount = (sqlite.prepare(`with weekly as (select a.worker_id, strftime('%Y-%W', s.starts_at/1000, 'unixepoch') wk, sum((s.ends_at - s.starts_at)/3600000.0 - s.break_minutes/60.0) hrs from shift_assignments a join shifts s on s.id = a.shift_id where a.status in ('CONFIRMED','COMPLETED') group by 1,2) select count(*) c from weekly join workers w on w.id = weekly.worker_id where w.contracted_hours_per_week + weekly.hrs > 48`).get() as { c: number }).c;
  if (overCount > 0) {
    gaps.record({
      id: 'WF-03',
      title: 'The 48-hour check ignores the worker\'s own rota: the platform only counts platform shifts',
      category: 'Workforce',
      severity: 'blocker',
      persona: 'worker / employer (Working Time Regulations)',
      month: 5,
      evidence: `${overCount} worker-weeks exceeded 48 hours once contracted hours are added to platform bookings, e.g. ${over.map((o) => `${o.name}: ${o.contracted}h contracted + ${o.platform_hrs.toFixed(1)}h on the platform`).join('; ')}. The eligibility rule has a field for internal hours but nothing feeds it.`,
      impact: 'Fatigued workers, a regulatory breach for the employer, and an avoidable safeguarding risk at the host.',
      proposal: 'Count contracted hours by default (configurable per worker), let employers declare the worker\'s actual rota hours for the week (or import the rota), and show the running total before a request.',
      decisionNeeded: 'Should the platform assume a worker is working their full contracted hours for their employer every week unless told otherwise?',
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
  // 4. Unfilled shifts: hosts received only an in-app warning 24h before.
  const expired = stats.weeks.reduce((s, w) => s + w.shiftsExpiredUnfilled, 0);
  const posted = stats.weeks.reduce((s, w) => s + w.shiftsPosted, 0);
  if (expired > 0) {
    gaps.record({
      id: 'DSP-01',
      title: 'Nothing escalates an unfilled shift: no auto-widening, rate uplift or agency fallback',
      category: 'Shifts & dispatch',
      severity: 'high',
      persona: 'rota manager at a host',
      month: 2,
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
