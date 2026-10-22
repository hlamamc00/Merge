/**
 * Simulation support: deterministic randomness, a controllable clock, an HTTP client that attributes
 * every call to a human task (so "calls per task" becomes an ease-of-use metric), and a gap register.
 */

// ---------- randomness ----------
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    // mulberry32
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!;
  }
  weighted<T>(items: readonly { v: T; w: number }[]): T {
    const total = items.reduce((s, i) => s + i.w, 0);
    let r = this.next() * total;
    for (const i of items) {
      r -= i.w;
      if (r <= 0) return i.v;
    }
    return items[items.length - 1]!.v;
  }
  shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }
}

// ---------- clock ----------
export class Clock {
  constructor(public now: Date) {}
  set(d: Date) {
    this.now = d;
  }
  advanceMinutes(m: number) {
    this.now = new Date(this.now.getTime() + m * 60_000);
  }
  plusHours(h: number): Date {
    return new Date(this.now.getTime() + h * 3_600_000);
  }
  plusDays(d: number): Date {
    return new Date(this.now.getTime() + d * 86_400_000);
  }
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

// ---------- HTTP client with task attribution ----------
export interface CallRecord {
  task: string;
  actor: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  error?: string;
}

export class ApiClient {
  readonly calls: CallRecord[] = [];
  private currentTask = 'untagged';
  private currentActor = 'system';
  constructor(private readonly base: string) {}

  /** Attribute every call made inside `fn` to a named human task performed by `actor`. */
  async task<T>(task: string, actor: string, fn: () => Promise<T>): Promise<T> {
    const prevT = this.currentTask;
    const prevA = this.currentActor;
    this.currentTask = task;
    this.currentActor = actor;
    try {
      return await fn();
    } finally {
      this.currentTask = prevT;
      this.currentActor = prevA;
    }
  }

  async call<T = any>(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; body: T }> {
    const started = performance.now();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    const ms = performance.now() - started;
    this.calls.push({ task: this.currentTask, actor: this.currentActor, method, path: path.replace(/\/[a-z]+_[a-z0-9]{16}/g, '/:id'), status: res.status, ms, error: res.status >= 400 ? parsed?.error : undefined });
    return { status: res.status, body: parsed };
  }

  get<T = any>(path: string, token: string | null) {
    return this.call<T>('GET', path, token);
  }
  post<T = any>(path: string, token: string | null, body?: unknown) {
    return this.call<T>('POST', path, token, body ?? {});
  }
  patch<T = any>(path: string, token: string | null, body: unknown) {
    return this.call<T>('PATCH', path, token, body);
  }
  put<T = any>(path: string, token: string | null, body: unknown) {
    return this.call<T>('PUT', path, token, body);
  }
  del<T = any>(path: string, token: string | null) {
    return this.call<T>('DELETE', path, token);
  }

  /** Calls per task: how many HTTP requests a human had to make to get something done. */
  taskSummary(): Array<{ task: string; occurrences: number; calls: number; callsPerOccurrence: number; errors: number; p95ms: number }> {
    const byTask = new Map<string, { calls: number; errors: number; occ: Set<string>; ms: number[] }>();
    for (const c of this.calls) {
      const t = byTask.get(c.task) ?? { calls: 0, errors: 0, occ: new Set<string>(), ms: [] };
      t.calls++;
      if (c.status >= 400) t.errors++;
      t.ms.push(c.ms);
      byTask.set(c.task, t);
    }
    return [...byTask.entries()].map(([task, t]) => {
      const sorted = [...t.ms].sort((a, b) => a - b);
      const occurrences = this.taskOccurrences.get(task) ?? 1;
      return { task, occurrences, calls: t.calls, callsPerOccurrence: Math.round((t.calls / occurrences) * 10) / 10, errors: t.errors, p95ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0) };
    });
  }
  readonly taskOccurrences = new Map<string, number>();
  countTask(task: string, n = 1) {
    this.taskOccurrences.set(task, (this.taskOccurrences.get(task) ?? 0) + n);
  }
}

// ---------- gap register ----------
export type GapSeverity = 'blocker' | 'high' | 'medium' | 'low';
export type GapCategory =
  | 'Onboarding'
  | 'Workforce'
  | 'Shifts & dispatch'
  | 'Compliance'
  | 'Finance'
  | 'Communication'
  | 'Reporting'
  | 'Platform & admin'
  | 'Scale & performance'
  | 'Security & data';

export interface Gap {
  id: string;
  title: string;
  category: GapCategory;
  severity: GapSeverity;
  persona: string;
  /** Simulated month (0-based) when first hit. */
  month: number;
  evidence: string;
  impact: string;
  proposal: string;
  /** A product decision the platform owner must make before this can be built. */
  decisionNeeded?: string;
  occurrences: number;
  /** 'fixed' when the defect was corrected during the exercise (the re-run shows it gone). */
  status?: 'open' | 'fixed';
}

export class GapRegister {
  readonly gaps = new Map<string, Gap>();
  record(g: Omit<Gap, 'occurrences'>): void {
    const existing = this.gaps.get(g.id);
    if (existing) {
      existing.occurrences++;
      return;
    }
    this.gaps.set(g.id, { ...g, occurrences: 1 });
  }
  list(): Gap[] {
    const order: Record<GapSeverity, number> = { blocker: 0, high: 1, medium: 2, low: 3 };
    return [...this.gaps.values()].sort((a, b) => order[a.severity] - order[b.severity] || a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  }
}

// ---------- UK-flavoured generators ----------
const FIRST = ['Aisha', 'Amara', 'Amelia', 'Ava', 'Beth', 'Carys', 'Chloe', 'Daniel', 'Dev', 'Eli', 'Ella', 'Emma', 'Esther', 'Fatima', 'Finn', 'Grace', 'Hannah', 'Harry', 'Ibrahim', 'Isla', 'Jack', 'Jamal', 'Jessica', 'Joseph', 'Kamil', 'Kemi', 'Leah', 'Liam', 'Lucy', 'Maria', 'Mia', 'Mohammed', 'Nadia', 'Niamh', 'Noah', 'Olivia', 'Oscar', 'Priya', 'Rahim', 'Ruby', 'Sam', 'Sofia', 'Tariq', 'Thomas', 'Yusuf', 'Zara', 'Zoe', 'George', 'Connor', 'Megan'];
const LAST = ['Ahmed', 'Ali', 'Begum', 'Bennett', 'Brown', 'Byrne', 'Carter', 'Chen', 'Clarke', 'Davies', 'Evans', 'Fletcher', 'Green', 'Hughes', 'Hussain', 'Jones', 'Kaur', 'Khan', 'Lam', 'Lewis', 'Mensah', 'Morgan', 'Murphy', 'Nowak', 'Okafor', 'Osei', 'Patel', 'Price', 'Reid', 'Roberts', 'Robinson', 'Shah', 'Singh', 'Smith', 'Taylor', 'Thomas', 'Walker', 'Ward', 'Williams', 'Wilson', 'Wright', 'Adeyemi', 'Dube', 'Grant'];

/** Greater Manchester outward codes with approximate centroids. */
export const AREAS: Array<{ outward: string; lat: number; lng: number; town: string }> = [
  { outward: 'M1', lat: 53.479, lng: -2.24, town: 'Manchester' },
  { outward: 'M4', lat: 53.485, lng: -2.23, town: 'Ancoats' },
  { outward: 'M8', lat: 53.506, lng: -2.241, town: 'Cheetham' },
  { outward: 'M14', lat: 53.445, lng: -2.22, town: 'Fallowfield' },
  { outward: 'M19', lat: 53.43, lng: -2.2, town: 'Levenshulme' },
  { outward: 'M20', lat: 53.418, lng: -2.231, town: 'Didsbury' },
  { outward: 'M21', lat: 53.442, lng: -2.276, town: 'Chorlton' },
  { outward: 'M33', lat: 53.424, lng: -2.322, town: 'Sale' },
  { outward: 'M41', lat: 53.45, lng: -2.35, town: 'Urmston' },
  { outward: 'SK4', lat: 53.41, lng: -2.157, town: 'Heaton Moor' },
  { outward: 'SK5', lat: 53.42, lng: -2.14, town: 'Reddish' },
  { outward: 'SK8', lat: 53.39, lng: -2.2, town: 'Cheadle' },
  { outward: 'OL1', lat: 53.541, lng: -2.111, town: 'Oldham' },
  { outward: 'OL4', lat: 53.53, lng: -2.08, town: 'Lees' },
  { outward: 'BL1', lat: 53.58, lng: -2.43, town: 'Bolton' },
  { outward: 'WN1', lat: 53.545, lng: -2.63, town: 'Wigan' },
  { outward: 'WA14', lat: 53.39, lng: -2.35, town: 'Altrincham' },
  { outward: 'M28', lat: 53.51, lng: -2.4, town: 'Worsley' },
];

export function personName(rng: Rng): { firstName: string; lastName: string } {
  return { firstName: rng.pick(FIRST), lastName: rng.pick(LAST) };
}

export function postcodeNear(rng: Rng, area: (typeof AREAS)[number]): { postcode: string; lat: number; lng: number } {
  return {
    postcode: `${area.outward} ${rng.int(1, 9)}${rng.pick(['AB', 'BD', 'DF', 'EH', 'JL', 'NP', 'QR', 'TW'])}`,
    lat: area.lat + (rng.next() - 0.5) * 0.03,
    lng: area.lng + (rng.next() - 0.5) * 0.04,
  };
}

export function iso(d: Date): string {
  return d.toISOString();
}

export function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function pct(n: number, d: number): number | null {
  return d === 0 ? null : Math.round((n / d) * 1000) / 10;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
