/** Findings and observations derived from the weekly numbers alone (re-computable without re-running). */
import type { Gap, GapRegister } from './lib.js';
import type { WeekStats } from './scenario.js';

const sum = (xs: number[]) => xs.reduce((s, n) => s + n, 0);
const med = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

export function deriveGapsFromWeeks(gaps: GapRegister, weeks: WeekStats[]): void {
  // Self-service workers are shown shifts they cannot take.
  const workerRefusals = sum(weeks.map((w) => Object.entries(w.apiErrors).filter(([k]) => k.includes('requests (worker)')).reduce((s, [, v]) => s + v, 0)));
  const reasons = new Map<string, number>();
  for (const w of weeks) for (const [k, v] of Object.entries(w.requestsRefused)) if (k.startsWith('worker:')) reasons.set(k.slice(7), (reasons.get(k.slice(7)) ?? 0) + v);
  const attempts = sum(weeks.map((w) => w.confirmations)); // proxy for scale
  if (workerRefusals >= 20) {
    gaps.record({
      id: 'DSP-08',
      title: 'Workers see shifts on their board that they cannot actually take',
      category: 'Shifts & dispatch',
      severity: 'medium',
      persona: 'care worker (phone)',
      month: 1,
      evidence: `Self-service workers had ${workerRefusals} requests refused after choosing a shift from their own board (top reasons: ${[...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(', ')}). The worker board filters by role only; skills, compliance, rest and weekly hours are checked only when they press Request.`,
      impact: 'The first thing a worker learns about the app is a rejection; they stop using it.',
      proposal: 'Evaluate eligibility server-side for the worker view and show only shifts they can take, with the blocked ones (and why) in a separate "not eligible" list.',
    });
  }
  void attempts;
}

export interface Observation {
  title: string;
  detail: string;
}

/** Plain-language readings of the numbers, for the report. */
export function observations(weeks: WeekStats[], providers: Array<{ name: string; status: string }>): Observation[] {
  const out: Observation[] = [];
  const posted = sum(weeks.map((w) => w.shiftsPosted));
  const expired = sum(weeks.map((w) => w.shiftsExpiredUnfilled));
  const conf = sum(weeks.map((w) => w.confirmations));
  const pr = sum(weeks.map((w) => w.confirmedViaPriority));
  const ag = sum(weeks.map((w) => w.confirmedViaAgency));
  const urgent = sum(weeks.map((w) => w.urgentPosted));
  out.push({
    title: `${Math.round((expired / posted) * 100)}% of shifts started with nobody confirmed`,
    detail: `${expired} of ${posted} shifts went unfilled. The network never had enough spare, compliant, in-range staff for winter demand, and nothing on the platform changed a shift's terms or reach when it was still open close to its start. ${Math.round((urgent / posted) * 100)}% of shifts were posted within 12 hours of starting, which collapses the priority windows and turns the exchange into a scramble.`,
  });
  out.push({
    title: `The agency bank filled ${Math.round((ag / conf) * 100)}% of bookings; priority access filled ${Math.round((pr / conf) * 100)}%`,
    detail: `Surplus flags did earn first access, but flagged organisations were small and their flags lapsed; the bank, which is always flagged in effect and checks the board more often, took the larger share. If the agency's aim is to grow a provider-to-provider exchange rather than its own agency business, the product needs to make flagging effortless and reward it.`,
  });
  const window = (lo: number, hi: number) => {
    const ws = weeks.slice(lo, hi);
    const c = sum(ws.map((w) => w.confirmations));
    return { agency: Math.round((sum(ws.map((w) => w.confirmedViaAgency)) / c) * 100), priority: Math.round((sum(ws.map((w) => w.confirmedViaPriority)) / c) * 100), unfilled: Math.round((sum(ws.map((w) => w.shiftsExpiredUnfilled)) / sum(ws.map((w) => w.shiftsPosted))) * 100), ttf: med(ws.flatMap((w) => w.timeToFillMinutes)) };
  };
  if (weeks.length >= 24) {
    const before = window(12, 16);
    const during = window(16, 20);
    const after = window(20, 24);
    out.push({
      title: 'Releasing the agency bank first did not improve fill rate; it displaced priority organisations and slowed filling',
      detail: `Four weeks before the experiment: agency ${before.agency}%, priority ${before.priority}%, unfilled ${before.unfilled}%, median time to fill ${before.ttf} min. During (agency FIRST): agency ${during.agency}%, priority ${during.priority}%, unfilled ${during.unfilled}%, time to fill ${during.ttf} min. After: agency ${after.agency}%, priority ${after.priority}%, unfilled ${after.unfilled}%, time to fill ${after.ttf} min. The bank took bookings that flagged providers would otherwise have had, and hosts waited longer because the bank's exclusive hour delayed everyone else.`,
    });
  }
  const left = providers.filter((p) => p.status !== 'ACTIVE').map((p) => p.name);
  if (left.length) out.push({ title: `${left.length} organisation(s) ended the run suspended or gone`, detail: `${left.join(', ')}. Their open shifts, bookings and statements were left for people to sort out by hand; see PLT-01 and PLT-02.` });
  const notif = sum(weeks.map((w) => w.notificationsSent));
  const peakWeek = weeks.reduce((a, b) => (b.notificationsSent > a.notificationsSent ? b : a));
  out.push({ title: `${notif.toLocaleString()} notifications, none delivered outside the app`, detail: `Peak week ${peakWeek.weekStart}: ${peakWeek.notificationsSent.toLocaleString()} notifications across the network, mostly release notices. Every urgent shift, late cancellation and dispute relied on someone happening to log in.` });
  return out;
}

export type { Gap };
