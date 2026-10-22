/**
 * The simulated world: an agency, care providers of different sizes joining over time, their workers,
 * and the weekly rhythm of posting shifts, raising capacity flags, responding, confirming, working,
 * submitting timesheets, approving them and settling statements.
 *
 * Every interaction goes through the real HTTP API as the corresponding human would, so the number
 * of calls a task needs is a direct measure of how laborious it is today.
 */
import { requiredDocumentsForRole, type DocumentType, type JobRole, type Skill } from '@merge/shared';
import { AREAS, ApiClient, Clock, DAY, GapRegister, HOUR, Rng, fmtDate, iso, personName, postcodeNear, round1 } from './lib.js';

export type RoleGroup = 'CARE' | 'SENIOR' | 'NURSE';
export type Size = 'large' | 'medium' | 'small';

export interface SimWorker {
  id: string;
  orgId: string;
  name: string;
  jobRole: JobRole;
  group: RoleGroup;
  skills: Skill[];
  shareable: boolean;
  token: string | null; // self-service login
  email: string | null;
  contractedHours: number;
  active: boolean;
}

export interface SimSite {
  id: string;
  name: string;
  lat: number;
  lng: number;
  postcode: string;
  serviceType: 'RESIDENTIAL' | 'NURSING' | 'SUPPORTED_LIVING' | 'DOMICILIARY';
}

export interface SimOrg {
  id: string;
  name: string;
  type: 'AGENCY' | 'PROVIDER';
  size: Size;
  adminToken: string;
  adminEmail: string;
  managerToken: string;
  sites: SimSite[];
  workers: SimWorker[];
  area: (typeof AREAS)[number];
  joinWeek: number;
  /** Baseline weekly staffing balance per role group, in shifts: negative = short, positive = spare. */
  balance: Record<RoleGroup, number>;
  shock: { until: number; factor: number } | null;
  floor: Record<RoleGroup, number>;
  checkHours: number[];
  autoConfirm: boolean;
  responsiveness: number; // 0..1 probability of acting at a check
  reliability: number; // 0..1, higher = fewer late cancellations
  payLagDays: number;
  selfService: boolean;
  activeSurplusFlag: Partial<Record<RoleGroup, string>>;
  status: 'ACTIVE' | 'SUSPENDED' | 'LEFT';
  queue: PendingPost[];
  noShowsCaused: number;
  blockedBy: string[];
}

export interface PendingPost {
  postAt: Date;
  startsAt: Date;
  endsAt: Date;
  breakMinutes: number;
  jobRole: JobRole;
  group: RoleGroup;
  siteId: string;
  headcount: number;
  chargeRate: number;
  title: string;
  requiredSkills: Skill[];
  urgent: boolean;
}

export interface SimContext {
  api: ApiClient;
  clock: Clock;
  rng: Rng;
  gaps: GapRegister;
  log: (msg: string) => void;
  world: World;
  stats: Stats;
}

export interface WeekStats {
  week: number;
  weekStart: string;
  providers: number;
  workers: number;
  shiftsPosted: number;
  urgentPosted: number;
  placesPosted: number;
  placesFilled: number;
  shiftsExpiredUnfilled: number;
  confirmations: number;
  confirmedViaPriority: number;
  confirmedViaAgency: number;
  confirmedViaNetwork: number;
  timeToFillMinutes: number[];
  requestsRefused: Record<string, number>;
  lateCancellations: number;
  noShows: number;
  hostCancellations: number;
  timesheetsApproved: number;
  timesheetsDisputed: number;
  timesheetsPendingEnd: number;
  hoursTraded: number;
  chargeTraded: number;
  platformFee: number;
  surplusHoursFlagged: number;
  shortageHoursFlagged: number;
  workersBlockedByCompliance: number;
  notificationsSent: number;
  apiErrors: Record<string, number>;
}

export class Stats {
  weeks: WeekStats[] = [];
  current!: WeekStats;
  notificationsByType = new Map<string, number>();
  notificationsPerOrgDay = new Map<string, number>();
  startWeek(week: number, weekStart: Date, providers: number, workers: number) {
    this.current = {
      week,
      weekStart: fmtDate(weekStart),
      providers,
      workers,
      shiftsPosted: 0,
      urgentPosted: 0,
      placesPosted: 0,
      placesFilled: 0,
      shiftsExpiredUnfilled: 0,
      confirmations: 0,
      confirmedViaPriority: 0,
      confirmedViaAgency: 0,
      confirmedViaNetwork: 0,
      timeToFillMinutes: [],
      requestsRefused: {},
      lateCancellations: 0,
      noShows: 0,
      hostCancellations: 0,
      timesheetsApproved: 0,
      timesheetsDisputed: 0,
      timesheetsPendingEnd: 0,
      hoursTraded: 0,
      chargeTraded: 0,
      platformFee: 0,
      surplusHoursFlagged: 0,
      shortageHoursFlagged: 0,
      workersBlockedByCompliance: 0,
      notificationsSent: 0,
      apiErrors: {},
    };
    this.weeks.push(this.current);
  }
  refused(code: string) {
    this.current.requestsRefused[code] = (this.current.requestsRefused[code] ?? 0) + 1;
  }
  apiError(status: number, path: string) {
    const k = `${status} ${path}`;
    this.current.apiErrors[k] = (this.current.apiErrors[k] ?? 0) + 1;
  }
}

export class World {
  orgs: SimOrg[] = [];
  platformAdminToken = '';
  agency!: SimOrg;
  /** shiftId → details we need later without refetching */
  shifts = new Map<string, { hostOrgId: string; publishedAt: Date; startsAt: Date; endsAt: Date; headcount: number; group: RoleGroup; urgent: boolean }>();
  providers(): SimOrg[] {
    return this.orgs.filter((o) => o.type === 'PROVIDER' && o.status === 'ACTIVE');
  }
  activeOrgs(): SimOrg[] {
    return this.orgs.filter((o) => o.status === 'ACTIVE');
  }
  org(id: string): SimOrg {
    return this.orgs.find((o) => o.id === id)!;
  }
  workerCount(): number {
    return this.orgs.reduce((s, o) => s + o.workers.filter((w) => w.active).length, 0);
  }
}

const ROLE_FOR_GROUP: Record<RoleGroup, JobRole[]> = {
  CARE: ['CARE_ASSISTANT', 'CARE_ASSISTANT', 'CARE_ASSISTANT', 'SUPPORT_WORKER'],
  SENIOR: ['SENIOR_CARER', 'SENIOR_CARER', 'TEAM_LEADER'],
  NURSE: ['NURSE'],
};
export const GROUP_OF_ROLE: Record<JobRole, RoleGroup> = {
  CARE_ASSISTANT: 'CARE',
  SUPPORT_WORKER: 'CARE',
  DOMICILIARY_CARER: 'CARE',
  ANCILLARY: 'CARE',
  SENIOR_CARER: 'SENIOR',
  TEAM_LEADER: 'SENIOR',
  NURSE: 'NURSE',
};
const BASE_RATE: Record<RoleGroup, number> = { CARE: 17, SENIOR: 20.5, NURSE: 33 };
const SKILL_POOL: Skill[] = ['MOVING_AND_HANDLING', 'DEMENTIA', 'MEDICATION', 'PEG_FEEDING', 'CATHETER_CARE', 'LEARNING_DISABILITIES', 'MENTAL_HEALTH', 'END_OF_LIFE', 'CHALLENGING_BEHAVIOUR', 'EPILEPSY', 'DIABETES', 'HOIST', 'DRIVER'];

export interface ProviderSpec {
  name: string;
  size: Size;
  staff: number;
  sites: number;
  serviceType: SimSite['serviceType'];
  joinWeek: number;
  selfService?: boolean;
  autoConfirm?: boolean;
  reliability?: number;
  payLagDays?: number;
  /** Baseline balance per role group in shifts/week (negative = short-staffed). */
  balance: Record<RoleGroup, number>;
}

// ----------------------------------------------------------------------------------------------
// Bootstrap and onboarding
// ----------------------------------------------------------------------------------------------

export async function bootstrapAgency(ctx: SimContext, bankSize: number): Promise<void> {
  const { api, rng, world, clock } = ctx;
  const area = AREAS[0]!;
  const res = await api.task('Platform set-up (agency bootstrap)', 'agency owner', () =>
    api.post('/api/v1/auth/bootstrap', null, {
      organisation: { name: 'Merge Staffing', postcode: `${area.outward} 4BT`, lat: area.lat, lng: area.lng, serviceTypes: [], defaultChargeRate: 19, email: 'ops@merge-staffing.example' },
      admin: { email: 'owner@merge-staffing.example', password: 'Simulation-Pass-1', firstName: 'Priya', lastName: 'Shah' },
    }),
  );
  if (res.status !== 201) throw new Error(`bootstrap failed: ${JSON.stringify(res.body)}`);
  world.platformAdminToken = res.body.token;
  const agency: SimOrg = {
    id: res.body.organisation.id,
    name: 'Merge Staffing',
    type: 'AGENCY',
    size: 'medium',
    adminToken: res.body.token,
    adminEmail: 'owner@merge-staffing.example',
    managerToken: res.body.token,
    sites: [],
    workers: [],
    area,
    joinWeek: 0,
    balance: { CARE: 0, SENIOR: 0, NURSE: 0 },
    shock: null,
    floor: { CARE: 16, SENIOR: 19.5, NURSE: 31 },
    checkHours: [8, 10, 12, 14, 16, 18, 20],
    autoConfirm: false,
    responsiveness: 0.95,
    reliability: 0.97,
    payLagDays: 0,
    selfService: true,
    activeSurplusFlag: {},
    status: 'ACTIVE',
    queue: [],
    noShowsCaused: 0,
    blockedBy: [],
  };
  world.agency = agency;
  world.orgs.push(agency);
  await api.task('Platform settings', 'agency owner', () => api.patch('/api/v1/admin/settings', world.platformAdminToken, { platformFeePct: 8, priorityWindowMinutes: 120, agencyWindowMinutes: 60, agencyPosition: 'AFTER_PRIORITY' }));
  await addWorkers(ctx, agency, bankSize, { loginShare: 0.8 });
  ctx.log(`${fmtDate(clock.now)} agency ready with a bank of ${bankSize}`);
}

export async function onboardProvider(ctx: SimContext, spec: ProviderSpec): Promise<SimOrg> {
  const { api, rng, world, clock, gaps } = ctx;
  const area = rng.pick(AREAS);
  const email = `admin@${spec.name.toLowerCase().replace(/[^a-z]+/g, '-')}.example`;
  const started = performance.now();
  const callsBefore = api.calls.length;
  const reg = await api.task('Register organisation', 'org admin', () =>
    api.post('/api/v1/auth/register', null, {
      organisation: { name: spec.name, postcode: `${area.outward} 1AA`, lat: area.lat, lng: area.lng, serviceTypes: [spec.serviceType], defaultChargeRate: BASE_RATE.CARE, workerSelfServiceAllowed: !!spec.selfService, email },
      admin: { email, password: 'Simulation-Pass-1', firstName: 'Admin', lastName: spec.name.split(' ')[0]! },
    }),
  );
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  api.countTask('Register organisation');
  const approval = await api.task('Approve a new organisation', 'agency owner', () => api.patch(`/api/v1/organisations/${reg.body.organisation.id}`, world.platformAdminToken, { status: 'ACTIVE' }));
  api.countTask('Approve a new organisation');
  if (approval.status !== 200) throw new Error(`approval failed: ${JSON.stringify(approval.body)}`);
  const org: SimOrg = {
    id: reg.body.organisation.id,
    name: spec.name,
    type: 'PROVIDER',
    size: spec.size,
    adminToken: reg.body.token,
    adminEmail: email,
    managerToken: '',
    sites: [],
    workers: [],
    area,
    joinWeek: 0,
    balance: spec.balance,
    shock: null,
    floor: { CARE: BASE_RATE.CARE * (0.9 + rng.next() * 0.15), SENIOR: BASE_RATE.SENIOR * (0.9 + rng.next() * 0.15), NURSE: BASE_RATE.NURSE * (0.9 + rng.next() * 0.15) },
    checkHours: spec.size === 'large' ? [8, 11, 14, 17, 20] : spec.size === 'medium' ? [8, 13, 18] : [9, 17],
    autoConfirm: !!spec.autoConfirm,
    responsiveness: spec.size === 'large' ? 0.9 : spec.size === 'medium' ? 0.8 : 0.65,
    reliability: spec.reliability ?? 0.96,
    payLagDays: spec.payLagDays ?? rng.int(10, 35),
    selfService: !!spec.selfService,
    activeSurplusFlag: {},
    status: 'ACTIVE',
    queue: [],
    noShowsCaused: 0,
    blockedBy: [],
  };
  world.orgs.push(org);

  // A second login for the rota manager.
  const mgr = await api.task('Add a user', 'org admin', () =>
    api.post(`/api/v1/organisations/${org.id}/users`, org.adminToken, { email: `rota@${spec.name.toLowerCase().replace(/[^a-z]+/g, '-')}.example`, password: 'Simulation-Pass-1', firstName: 'Rota', lastName: 'Manager', role: 'ORG_MANAGER' }),
  );
  api.countTask('Add a user');
  const login = await api.task('Log in', 'rota manager', () => api.post('/api/v1/auth/login', null, { email: mgr.body.email, password: 'Simulation-Pass-1' }));
  org.managerToken = login.body.token;

  // Sites.
  for (let i = 0; i < spec.sites; i++) {
    const siteArea = i === 0 ? area : rng.pick(AREAS);
    const pc = postcodeNear(rng, siteArea);
    const site = await api.task('Add a site', 'org admin', () =>
      api.post(`/api/v1/organisations/${org.id}/sites`, org.adminToken, { name: spec.sites === 1 ? spec.name : `${spec.name} – ${siteArea.town}`, serviceType: spec.serviceType, postcode: pc.postcode, lat: pc.lat, lng: pc.lng, addressLine1: `${rng.int(1, 120)} ${rng.pick(['Mill', 'Church', 'Park', 'Station', 'High'])} Road`, city: siteArea.town, accessNotes: 'Sign in at reception.' }),
    );
    api.countTask('Add a site');
    org.sites.push({ id: site.body.id, name: site.body.name, lat: pc.lat, lng: pc.lng, postcode: pc.postcode, serviceType: spec.serviceType });
  }

  await addWorkers(ctx, org, spec.staff, { loginShare: spec.selfService ? 0.5 : 0.15, nurses: spec.serviceType === 'NURSING' });

  const elapsedMin = round1((performance.now() - started) / 60_000);
  const calls = api.calls.length - callsBefore;
  ctx.log(`${fmtDate(clock.now)} onboarded ${spec.name} (${spec.staff} staff, ${spec.sites} site(s)): ${calls} API calls, ${elapsedMin} min of machine time`);
  if (spec.staff >= 40) {
    gaps.record({
      id: 'ONB-01',
      title: 'No bulk import: every worker and every document is added one at a time',
      category: 'Onboarding',
      severity: 'blocker',
      persona: 'HR manager at a large provider',
      month: Math.floor(((clock.now.getTime() - SIM_START.getTime()) / DAY) / 30),
      evidence: `${spec.name} with ${spec.staff} staff needed ${calls} API calls (one worker + ${requiredDocumentsForRole('CARE_ASSISTANT').length}–8 documents + a verification each). A human doing this through the UI would type each worker and each certificate by hand.`,
      impact: 'Large providers will not finish onboarding; the platform only gets a handful of their staff, which starves the exchange of supply.',
      proposal: 'CSV/Excel import of workers (name, email, role, skills, contracted hours, postcode, document references and expiry dates) with a preview, validation report and partial-success handling; bulk verification; and an export of the same shape so providers can round-trip from their HR or rota system.',
    });
  }
  if (spec.sites >= 3) {
    gaps.record({
      id: 'ONB-03',
      title: 'No site-level roles: a multi-site group gives every manager access to every site',
      category: 'Workforce',
      severity: 'high',
      persona: 'Regional manager of a care group',
      month: 0,
      evidence: `${spec.name} has ${spec.sites} sites but one organisation; its rota manager login sees and can act on all of them.`,
      impact: 'Groups cannot delegate to home managers safely; either they share one login or they register each home as a separate organisation and lose group-level reporting and internal-first dispatch.',
      proposal: 'Scope ORG_MANAGER to one or more sites; group-level admins see everything. Alternatively an organisation hierarchy (group → homes) with an internal-first dispatch stage.',
      decisionNeeded: 'Should a care group be one organisation with site-scoped managers, or a parent organisation with child organisations that can still trade internally first?',
    });
  }
  return org;
}

export const SIM_START = new Date('2026-11-02T06:00:00Z'); // a Monday

async function addWorkers(ctx: SimContext, org: SimOrg, count: number, opts: { loginShare: number; nurses?: boolean }): Promise<void> {
  const { api, rng, clock, gaps } = ctx;
  let unverifiedBacklog = 0;
  for (let i = 0; i < count; i++) {
    const group: RoleGroup = rng.weighted([
      { v: 'CARE' as RoleGroup, w: opts.nurses ? 65 : 78 },
      { v: 'SENIOR' as RoleGroup, w: 18 },
      { v: 'NURSE' as RoleGroup, w: opts.nurses ? 17 : 4 },
    ]);
    const jobRole = rng.pick(ROLE_FOR_GROUP[group]);
    const skills = new Set<Skill>(['MOVING_AND_HANDLING']);
    if (rng.chance(0.75)) skills.add('DEMENTIA');
    if (group !== 'CARE' || rng.chance(0.3)) skills.add('MEDICATION');
    for (const s of SKILL_POOL) if (rng.chance(0.18)) skills.add(s);
    const name = personName(rng);
    const pc = postcodeNear(rng, rng.chance(0.7) ? org.area : rng.pick(AREAS));
    const contracted = rng.pick([0, 16, 24, 30, 36, 37.5, 40]);
    const w = await api.task('Add a worker', 'HR / rota manager', () =>
      api.post('/api/v1/workers', org.adminToken, {
        firstName: name.firstName,
        lastName: name.lastName,
        jobRole,
        skills: [...skills],
        shareable: rng.chance(0.78),
        contractedHoursPerWeek: contracted,
        maxHoursPerWeek: 48,
        optedOutOf48h: rng.chance(0.25),
        postcode: pc.postcode,
        lat: pc.lat,
        lng: pc.lng,
        travelRadiusKm: rng.pick([10, 15, 20, 25, 35]),
        hourlyPayRate: group === 'NURSE' ? 21 : group === 'SENIOR' ? 13.5 : 12.3,
      }),
    );
    api.countTask('Add a worker');
    if (w.status !== 201) throw new Error(`worker create failed: ${JSON.stringify(w.body)}`);
    const worker: SimWorker = { id: w.body.id, orgId: org.id, name: `${name.firstName} ${name.lastName}`, jobRole, group, skills: [...skills], shareable: w.body.shareable, token: null, email: null, contractedHours: contracted, active: true };
    org.workers.push(worker);

    // Documents: mostly long-dated, some expiring inside the six months, a few left unverified.
    for (const type of requiredDocumentsForRole(jobRole)) {
      const soon = rng.chance(type === 'DBS' ? 0.08 : 0.14);
      const expiresAt = new Date(clock.now.getTime() + (soon ? rng.int(20, 170) : rng.int(200, 1000)) * DAY);
      const doc = await api.task('Add a worker document', 'HR / rota manager', () => api.post(`/api/v1/workers/${worker.id}/documents`, org.adminToken, { type, reference: `${type.slice(0, 3)}-${rng.int(100000, 999999)}`, expiresAt: iso(expiresAt) }));
      api.countTask('Add a worker document');
      if (rng.chance(0.988)) {
        await api.task('Verify a worker document', 'HR / rota manager', () => api.patch(`/api/v1/workers/${worker.id}/documents/${doc.body.id}`, org.adminToken, { verified: true }));
        api.countTask('Verify a worker document');
      } else unverifiedBacklog++;
    }

    if (rng.chance(opts.loginShare)) {
      const email = `${name.firstName}.${name.lastName}.${rng.int(100, 999)}@${org.name.toLowerCase().replace(/[^a-z]+/g, '-')}.example`.toLowerCase();
      const login = await api.task('Create a worker login', 'HR / rota manager', () => api.post(`/api/v1/workers/${worker.id}/login`, org.adminToken, { email, password: 'Temp-Pass-1234' }));
      api.countTask('Create a worker login');
      if (login.status === 201) {
        const session = await api.task('Log in', 'care worker', () => api.post('/api/v1/auth/login', null, { email, password: 'Temp-Pass-1234' }));
        worker.token = session.body.token;
        worker.email = email;
      }
    }
  }
  if (count >= 10) {
    gaps.record({
      id: 'ONB-02',
      title: 'Worker logins are created by hand with a password the manager must pass on',
      category: 'Onboarding',
      severity: 'high',
      persona: 'HR manager',
      month: 0,
      evidence: `${org.name}: the manager chose a password for each worker login and has no way to send it; there is no invitation email, no temporary-password flow and no password reset.`,
      impact: 'Passwords travel by WhatsApp or paper, the same temporary password gets reused, and locked-out workers cannot help themselves.',
      proposal: 'Invite-by-email (also from the import): the worker sets their own password through a time-limited link; add forgotten-password reset and a forced change on first login. Needs an email channel.',
      decisionNeeded: 'Which email provider (e.g. SendGrid, Postmark, SES) and sender domain should platform emails use?',
    });
  }
  if (unverifiedBacklog > 0) {
    gaps.record({
      id: 'CMP-01',
      title: 'Verification backlog is invisible: unverified documents silently block workers',
      category: 'Compliance',
      severity: 'medium',
      persona: 'Compliance officer',
      month: 0,
      evidence: `${org.name} ended onboarding with ${unverifiedBacklog} document(s) never verified; those workers show as non-compliant with no queue or reminder for the verifier.`,
      impact: 'Supply is quietly lost and managers only find out when a request is refused.',
      proposal: 'A "needs verification" queue with bulk verify, plus a weekly digest of unverified and expiring documents per organisation.',
    });
  }
}

// ----------------------------------------------------------------------------------------------
// Weekly planning: shifts to post and capacity flags to raise
// ----------------------------------------------------------------------------------------------

/** Seasonal demand multiplier: winter pressure peaks around week 10 (mid-January). */
export function seasonal(week: number): number {
  return 1 + 0.35 * Math.sin(((week - 2) / 26) * Math.PI);
}

export function planWeek(ctx: SimContext, org: SimOrg, week: number): void {
  const { rng, clock } = ctx;
  org.queue = [];
  if (org.status !== 'ACTIVE' || org.sites.length === 0) return; // the agency bank never hosts shifts
  if (org.shock && org.shock.until < week) org.shock = null;
  if (!org.shock && rng.chance(0.06)) org.shock = { until: week + rng.int(1, 3), factor: rng.pick([1.6, 2.0, 0.5]) };
  const groups: RoleGroup[] = ['CARE', 'SENIOR', 'NURSE'];
  let shortageHours = 0;
  let surplusHours = 0;
  for (const g of groups) {
    const base = org.balance[g];
    const season = seasonal(week);
    // Shortage grows with winter pressure; surplus shrinks with it.
    let balance = base < 0 ? base * season : base * (2 - season);
    if (org.shock) balance = balance < 0 ? balance * org.shock.factor : balance / org.shock.factor;
    balance += (rng.next() - 0.5) * 2;
    const shifts = Math.round(-balance);
    if (shifts > 0) {
      shortageHours += shifts * 8;
      for (let i = 0; i < shifts; i++) org.queue.push(makePost(ctx, org, g, week));
    } else if (balance >= 1 && org.workers.some((w) => w.group === g && w.shareable && w.active)) {
      surplusHours += Math.round(balance) * 8;
    }
  }
  org.queue.sort((a, b) => a.postAt.getTime() - b.postAt.getTime());
  ctx.stats.current.shortageHoursFlagged += shortageHours;
  ctx.stats.current.surplusHoursFlagged += surplusHours;
  void clock;
}

function makePost(ctx: SimContext, org: SimOrg, group: RoleGroup, week: number): PendingPost {
  const { rng } = ctx;
  const weekStart = new Date(SIM_START.getTime() + week * 7 * DAY);
  const day = rng.int(0, 6);
  const pattern = rng.weighted([
    { v: { start: 7, hours: 12, name: 'Long day' }, w: 40 },
    { v: { start: 7, hours: 7.5, name: 'Early' }, w: 20 },
    { v: { start: 14, hours: 8, name: 'Late' }, w: 15 },
    { v: { start: 19, hours: 12, name: 'Night' }, w: 25 },
  ]);
  const startsAt = new Date(weekStart.getTime() + day * DAY + (pattern.start - 6) * HOUR);
  const endsAt = new Date(startsAt.getTime() + pattern.hours * HOUR);
  const lead = rng.weighted([
    { v: rng.int(72, 240), w: 55 }, // 3–10 days ahead
    { v: rng.int(24, 72), w: 25 },
    { v: rng.int(2, 11), w: 20 }, // same-day / urgent
  ]);
  let postAt = new Date(startsAt.getTime() - lead * HOUR);
  const earliest = new Date(weekStart.getTime() - 7 * DAY);
  if (postAt < earliest) postAt = earliest;
  const urgent = lead <= 12;
  const weekend = startsAt.getUTCDay() === 0 || startsAt.getUTCDay() === 6;
  let rate = BASE_RATE[group] * (pattern.name === 'Night' ? 1.12 : 1) * (weekend ? 1.1 : 1) * (urgent ? 1.2 : 1);
  rate = Math.round(rate * 4) / 4;
  const jobRole = rng.pick(ROLE_FOR_GROUP[group]);
  const site = rng.pick(org.sites);
  const skills: Skill[] = ['MOVING_AND_HANDLING'];
  if (rng.chance(0.6)) skills.push('DEMENTIA');
  if (group !== 'CARE' && rng.chance(0.7)) skills.push('MEDICATION');
  if (jobRole === 'NURSE' && rng.chance(0.4)) skills.push('PEG_FEEDING');
  return { postAt, startsAt, endsAt, breakMinutes: pattern.hours >= 10 ? 60 : 30, jobRole, group, siteId: site.id, headcount: rng.chance(0.2) ? 2 : 1, chargeRate: rate, title: `${pattern.name} – ${site.name.split(' – ')[1] ?? 'main unit'}`, requiredSkills: skills, urgent };
}

// ----------------------------------------------------------------------------------------------
// Step behaviours (run every simulated step)
// ----------------------------------------------------------------------------------------------

export async function postDueShifts(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, clock, rng, world, stats, gaps } = ctx;
  while (org.queue.length && org.queue[0]!.postAt <= clock.now) {
    const p = org.queue.shift()!;
    if (p.startsAt.getTime() <= clock.now.getTime() + HOUR) continue; // too late to bother
    const res = await api.task('Post a shift', 'rota manager', () =>
      api.post('/api/v1/shifts', org.managerToken, {
        siteId: p.siteId,
        jobRole: p.jobRole,
        title: p.title,
        startsAt: iso(p.startsAt),
        endsAt: iso(p.endsAt),
        breakMinutes: p.breakMinutes,
        headcount: p.headcount,
        requiredSkills: p.requiredSkills,
        chargeRate: p.chargeRate,
        autoConfirm: org.autoConfirm,
        publish: true,
      }),
    );
    api.countTask('Post a shift');
    if (res.status !== 201) {
      stats.apiError(res.status, 'POST /shifts');
      continue;
    }
    world.shifts.set(res.body.id, { hostOrgId: org.id, publishedAt: clock.now, startsAt: p.startsAt, endsAt: p.endsAt, headcount: p.headcount, group: p.group, urgent: res.body.urgent });
    stats.current.shiftsPosted++;
    stats.current.placesPosted += p.headcount;
    if (res.body.urgent) stats.current.urgentPosted++;
    if (res.body.plan?.length === 0) {
      gaps.record({
        id: 'DSP-04',
        title: 'A shift can be published to nobody',
        category: 'Shifts & dispatch',
        severity: 'medium',
        persona: 'rota manager',
        month: monthOf(clock.now),
        evidence: `${org.name} published "${p.title}" and the release plan was empty (no other active organisation, or all blocked). The API returned 201 as if all were well.`,
        impact: 'The host waits for cover that can never come.',
        proposal: 'Warn at publish time when the plan is empty or has no organisation with eligible workers, and suggest widening visibility or contacting the agency.',
      });
    }
  }
  // Hosts who want someone specific pull candidates directly for a share of shifts (direct offers).
  void rng;
}

/** Suppliers look at the board at their check hours and put workers forward. */
export async function supplierCheck(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, clock, rng, world, stats, gaps } = ctx;
  if (!rng.chance(org.responsiveness)) return;
  const board = await api.task('Check the shift board', 'rota manager', () => api.get('/api/v1/shifts?scope=available', org.managerToken));
  api.countTask('Check the shift board');
  if (board.status !== 200) {
    stats.apiError(board.status, 'GET /shifts?scope=available');
    return;
  }
  const open = (board.body as any[]).filter((s) => s.access.open && s.myAssignments.length === 0 && s.placesLeft > 0);
  if (open.length === 0) return;
  const hasSurplus = Object.keys(org.activeSurplusFlag).length > 0;
  let responded = 0;
  for (const shift of rng.shuffle(open)) {
    if (responded >= (org.size === 'large' ? 6 : org.size === 'medium' ? 3 : 2)) break;
    const group = GROUP_OF_ROLE[shift.jobRole as JobRole];
    const rateOk = shift.chargeRate >= org.floor[group];
    const base = org.activeSurplusFlag[group] ? 0.85 : hasSurplus ? 0.5 : org.type === 'AGENCY' ? 0.8 : 0.3;
    const p = base * (rateOk ? 1 : 0.35) * (shift.urgent ? 0.8 : 1);
    if (!rng.chance(p)) continue;
    const elig = await api.task('Find an eligible worker for a shift', 'rota manager', () => api.get(`/api/v1/shifts/${shift.id}/eligible-workers`, org.managerToken));
    api.countTask('Find an eligible worker for a shift');
    if (elig.status !== 200) {
      stats.apiError(elig.status, 'GET /shifts/:id/eligible-workers');
      continue;
    }
    const workers = elig.body.workers as any[];
    for (const w of workers) for (const b of w.blockers ?? []) stats.refused(b.code);
    const candidates = workers.filter((w) => w.eligible && !w.alreadyRequested).sort((a, b) => a.warnings.length - b.warnings.length);
    if (candidates.length === 0) {
      if (workers.some((w) => (w.blockers ?? []).some((b: any) => b.code === 'NON_COMPLIANT'))) stats.current.workersBlockedByCompliance++;
      continue;
    }
    const pickFrom = candidates.slice(0, 3);
    const chosen = rng.pick(pickFrom);
    const req = await api.task('Put a worker forward', 'rota manager', () => api.post(`/api/v1/shifts/${shift.id}/requests`, org.managerToken, { workerId: chosen.id }));
    api.countTask('Put a worker forward');
    if (req.status === 201) responded++;
    else {
      stats.apiError(req.status, 'POST /shifts/:id/requests');
      if (req.status === 422) for (const b of req.body?.details?.blockers ?? []) stats.refused(`late:${b.code}`);
    }
  }
  if (open.length > 25 && org.size !== 'large') {
    gaps.record({
      id: 'DSP-05',
      title: 'The shift board is a flat list with no sort by fit, distance or pay',
      category: 'Shifts & dispatch',
      severity: 'medium',
      persona: 'rota manager at a supplier',
      month: monthOf(clock.now),
      evidence: `${org.name} saw ${open.length} open shifts at once; the API returns them ordered by release time only, and finding which ones its staff can actually cover means opening each one.`,
      impact: 'Suppliers respond to the first few and miss better matches; priority organisations waste their window.',
      proposal: 'Board filters and sorting by role fit, distance, rate, start time; a per-organisation "you have N eligible workers" count computed server-side; saved searches and alerts.',
    });
  }
}

/** Self-service workers browse and request for themselves. */
export async function workerCheck(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, rng, stats } = ctx;
  if (!org.selfService) return;
  for (const w of org.workers) {
    if (!w.token || !w.active || !w.shareable || !rng.chance(0.12)) continue;
    const board = await api.task('Worker browses shifts', 'care worker', () => api.get('/api/v1/shifts?scope=available', w.token));
    api.countTask('Worker browses shifts');
    if (board.status !== 200) continue;
    const open = (board.body as any[]).filter((s) => s.access.open && s.myAssignments.length === 0 && s.placesLeft > 0);
    if (open.length === 0 || !rng.chance(0.5)) continue;
    const shift = rng.pick(open);
    const req = await api.task('Worker requests a shift', 'care worker', () => api.post(`/api/v1/shifts/${shift.id}/requests`, w.token, {}));
    api.countTask('Worker requests a shift');
    if (req.status !== 201) {
      stats.apiError(req.status, 'POST /shifts/:id/requests (worker)');
      if (req.status === 422) for (const b of req.body?.details?.blockers ?? []) stats.refused(`worker:${b.code}`);
    }
  }
}

/** Hosts confirm incoming requests and accept offers at their check hours. */
export async function hostCheck(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, clock, rng, world, stats, gaps } = ctx;
  if (!rng.chance(org.responsiveness)) return;
  const incoming = await api.task('Review incoming requests', 'rota manager', () => api.get('/api/v1/assignments?scope=incoming&status=REQUESTED', org.managerToken));
  api.countTask('Review incoming requests');
  if (incoming.status !== 200) return;
  const requests = incoming.body as any[];
  // First come, first served per shift.
  const byShift = new Map<string, any[]>();
  for (const r of requests) byShift.set(r.shiftId, [...(byShift.get(r.shiftId) ?? []), r]);
  for (const [, list] of byShift) {
    list.sort((a, b) => new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime());
    let placesLeft: number | null = null;
    for (const r of list) {
      if (placesLeft !== null && placesLeft <= 0) break; // filled earlier in this sitting
      if (!rng.chance(0.92)) {
        if (rng.chance(0.4)) await api.task('Decline a request', 'rota manager', () => api.post(`/api/v1/assignments/${r.id}/decline`, org.managerToken, { reason: 'Cover found internally' }));
        continue;
      }
      const res = await api.task('Confirm a request', 'rota manager', () => api.post(`/api/v1/assignments/${r.id}/confirm`, org.managerToken));
      api.countTask('Confirm a request');
      if (res.status === 200) {
        recordConfirmation(ctx, r, res.body);
        const s = world.shifts.get(r.shiftId);
        placesLeft = (placesLeft ?? s?.headcount ?? 1) - 1;
      }
      else if (res.status !== 409) stats.apiError(res.status, 'POST /assignments/:id/confirm');
    }
  }
  if (requests.length >= 15) {
    gaps.record({
      id: 'DSP-02',
      title: 'No bulk confirm: each request is confirmed one by one',
      category: 'Shifts & dispatch',
      severity: 'high',
      persona: 'rota manager at a host',
      month: monthOf(clock.now),
      evidence: `${org.name} had ${requests.length} pending requests at one check; confirming them took ${requests.length} separate actions, and the first-come rule is enforced by the manager reading timestamps.`,
      impact: 'Slow confirmations mean suppliers\' workers sit in limbo and sometimes get booked elsewhere; winter weeks pile up hundreds of clicks.',
      proposal: 'Bulk confirm/decline with per-shift grouping, keyboard-fast review, and an optional auto-confirm policy per host (e.g. auto-confirm preferred partners or priority-tier requests).',
    });
  }
  // Accept offers made to us (as a supplier).
  const offers = await api.task('Review offers received', 'rota manager', () => api.get('/api/v1/assignments?scope=outgoing&status=OFFERED', org.managerToken));
  api.countTask('Review offers received');
  for (const o of (offers.body as any[]) ?? []) {
    if (!rng.chance(0.8)) continue;
    const res = await api.task('Accept a direct offer', 'rota manager', () => api.post(`/api/v1/assignments/${o.id}/accept`, org.managerToken));
    api.countTask('Accept a direct offer');
    if (res.status === 200) recordConfirmation(ctx, o, res.body);
  }
  void world;
}

function recordConfirmation(ctx: SimContext, request: any, confirmed: any): void {
  const { stats, world, clock } = ctx;
  stats.current.confirmations++;
  stats.current.placesFilled++;
  const tier = confirmed.tierAtRequest ?? request.tierAtRequest;
  if (tier === 'PRIORITY') stats.current.confirmedViaPriority++;
  else if (tier === 'AGENCY') stats.current.confirmedViaAgency++;
  else stats.current.confirmedViaNetwork++;
  const s = world.shifts.get(confirmed.shiftId ?? request.shiftId);
  if (s) stats.current.timeToFillMinutes.push(Math.round((clock.now.getTime() - s.publishedAt.getTime()) / 60_000));
}

/** Hosts sometimes go looking for a named worker and offer directly. */
export async function hostDirectOffers(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, rng, clock } = ctx;
  if (!rng.chance(0.15)) return;
  const posted = await api.task('Review my posted shifts', 'rota manager', () => api.get('/api/v1/shifts?scope=posted&status=OPEN', org.managerToken));
  api.countTask('Review my posted shifts');
  const open = ((posted.body as any[]) ?? []).filter((s) => s.pendingRequests === 0 && new Date(s.startsAt).getTime() - clock.now.getTime() < 3 * DAY);
  if (open.length === 0) return;
  const shift = rng.pick(open);
  const cands = await api.task('Search candidates for a shift', 'rota manager', () => api.get(`/api/v1/shifts/${shift.id}/candidates`, org.managerToken));
  api.countTask('Search candidates for a shift');
  const list = (cands.body as any[]) ?? [];
  if (list.length === 0) return;
  const chosen = list[0];
  await api.task('Offer a shift to a named worker', 'rota manager', () => api.post(`/api/v1/shifts/${shift.id}/offers`, org.managerToken, { workerId: chosen.id }));
  api.countTask('Offer a shift to a named worker');
}

/** Pre-shift cancellations by suppliers (late ones count) and by hosts. */
export async function cancellations(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, rng, clock, stats } = ctx;
  const supplied = await api.task('Review upcoming bookings', 'rota manager', () => api.get('/api/v1/assignments?scope=outgoing&status=CONFIRMED', org.managerToken));
  api.countTask('Review upcoming bookings');
  for (const a of (supplied.body as any[]) ?? []) {
    const hoursToStart = (new Date(a.shift.startsAt).getTime() - clock.now.getTime()) / HOUR;
    if (hoursToStart <= 0 || hoursToStart > 72) continue;
    const pCancel = (1 - org.reliability) * 0.45; // per daily check inside the 72h window
    if (!rng.chance(pCancel)) continue;
    const res = await api.task('Cancel a booking', 'rota manager', () => api.post(`/api/v1/assignments/${a.id}/cancel`, org.managerToken, { reason: rng.pick(['Sickness', 'Family emergency', 'Double-booked on our own rota']) }));
    api.countTask('Cancel a booking');
    if (res.status === 200 && res.body.lateCancellation) stats.current.lateCancellations++;
  }
  if (rng.chance(0.25)) {
    const posted = await api.task('Review my posted shifts', 'rota manager', () => api.get('/api/v1/shifts?scope=posted', org.managerToken));
    api.countTask('Review my posted shifts');
    for (const s of (posted.body as any[]) ?? []) {
      if (!['OPEN', 'FILLED'].includes(s.status) || !rng.chance(0.004)) continue;
      const res = await api.task('Cancel a shift', 'rota manager', () => api.post(`/api/v1/shifts/${s.id}/cancel`, org.managerToken, { reason: 'Resident discharged' }));
      api.countTask('Cancel a shift');
      if (res.status === 200) stats.current.hostCancellations++;
    }
  }
}

/** After shifts end: suppliers submit timesheets; hosts record the odd no-show. */
export async function afterShifts(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, rng, clock, stats, gaps } = ctx;
  const receivable = await api.task('Review timesheets to submit', 'rota manager', () => api.get('/api/v1/timesheets?scope=receivable&status=DRAFT', org.managerToken));
  api.countTask('Review timesheets to submit');
  let submitted = 0;
  for (const ts of (receivable.body as any[]) ?? []) {
    const end = new Date(ts.shift.endsAt).getTime();
    const start = new Date(ts.shift.startsAt).getTime();
    if (start > clock.now.getTime()) continue;
    if (end > clock.now.getTime()) {
      // Shift in progress: clock in if not yet done (worker on a phone, or the manager for them).
      if (!ts.clockInAt && rng.chance(0.7)) {
        const actor = rng.chance(0.4) ? 'care worker (phone)' : 'rota manager';
        await api.task('Clock in', actor, () => api.post(`/api/v1/timesheets/${ts.id}/clock-in`, org.managerToken, { at: iso(new Date(start + rng.int(-10, 12) * 60_000)) }));
        api.countTask('Clock in');
      }
      continue;
    }
    if (!rng.chance(0.6)) continue;
    if (!ts.clockInAt) {
      const r = await api.task('Submit a timesheet manually', 'rota manager', () => api.post(`/api/v1/timesheets/${ts.id}/submit`, org.managerToken, { clockInAt: iso(new Date(start + rng.int(-5, 10) * 60_000)), clockOutAt: iso(new Date(end + rng.int(-10, 20) * 60_000)), breakMinutes: ts.breakMinutes }));
      api.countTask('Submit a timesheet manually');
      if (r.status === 200) submitted++;
      else stats.apiError(r.status, 'POST /timesheets/:id/submit');
    } else {
      const r = await api.task('Clock out', 'care worker (phone)', () => api.post(`/api/v1/timesheets/${ts.id}/clock-out`, org.managerToken, { at: iso(new Date(end + rng.int(-10, 20) * 60_000)) }));
      api.countTask('Clock out');
      if (r.status === 200) submitted++;
      else stats.apiError(r.status, 'POST /timesheets/:id/clock-out');
    }
  }
  // No-shows are recorded by hosts shortly after a start.
  if (rng.chance(0.85)) {
    const incoming = await api.task('Check who is due on shift', 'rota manager', () => api.get('/api/v1/assignments?scope=incoming&status=CONFIRMED', org.managerToken));
    api.countTask('Check who is due on shift');
    for (const a of (incoming.body as any[]) ?? []) {
      const start = new Date(a.shift.startsAt).getTime();
      if (start > clock.now.getTime() || clock.now.getTime() - start > 4 * HOUR) continue;
      const supplier = ctx.world.org(a.supplierOrgId);
      if (!rng.chance((1 - (supplier?.reliability ?? 0.96)) * 0.5)) continue;
      const res = await api.task('Record a no-show', 'rota manager', () => api.post(`/api/v1/assignments/${a.id}/no-show`, org.managerToken));
      api.countTask('Record a no-show');
      if (res.status === 200) {
        stats.current.noShows++;
        if (supplier) supplier.noShowsCaused++;
      }
    }
  }
  if (submitted >= 20) {
    gaps.record({
      id: 'FIN-02',
      title: 'Timesheets are submitted and approved one at a time',
      category: 'Finance',
      severity: 'high',
      persona: 'finance clerk',
      month: monthOf(clock.now),
      evidence: `${org.name} submitted ${submitted} timesheets in one sitting, each a separate form; hosts approve each one separately too.`,
      impact: 'Weekly admin scales linearly with volume; approvals lag, so statements go out late and suppliers chase.',
      proposal: 'A weekly timesheet grid per organisation with bulk submit/approve, exceptions highlighted (late clock-in, missing clock-out, over-length), and auto-approval after N days if the host does nothing (configurable).',
      decisionNeeded: 'Should timesheets auto-approve after a set number of days of host silence, and if so how many days?',
    });
  }
}

/** Hosts approve or dispute submitted timesheets at their checks. */
export async function hostApprovals(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, rng, stats } = ctx;
  if (!rng.chance(org.responsiveness * 0.7)) return;
  const payable = await api.task('Review submitted timesheets', 'finance clerk', () => api.get('/api/v1/timesheets?scope=payable&status=SUBMITTED', org.managerToken));
  api.countTask('Review submitted timesheets');
  for (const ts of (payable.body as any[]) ?? []) {
    const roll = rng.next();
    if (roll < 0.9) {
      const r = await api.task('Approve a timesheet', 'finance clerk', () => api.post(`/api/v1/timesheets/${ts.id}/approve`, org.managerToken));
      api.countTask('Approve a timesheet');
      if (r.status === 200) {
        stats.current.timesheetsApproved++;
        stats.current.hoursTraded += r.body.paidHours;
        stats.current.chargeTraded += r.body.hostCost;
        stats.current.platformFee += r.body.platformFee;
      } else stats.apiError(r.status, 'POST /timesheets/:id/approve');
    } else if (roll < 0.95) {
      const r = await api.task('Dispute a timesheet', 'finance clerk', () => api.post(`/api/v1/timesheets/${ts.id}/dispute`, org.managerToken, { reason: rng.pick(['Left early', 'Break not deducted', 'Did not attend handover']) }));
      api.countTask('Dispute a timesheet');
      if (r.status === 200) stats.current.timesheetsDisputed++;
    }
  }
}

/** Suppliers correct disputed timesheets. */
export async function resolveDisputes(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, rng } = ctx;
  if (!rng.chance(0.5)) return;
  const disputed = await api.task('Review disputed timesheets', 'rota manager', () => api.get('/api/v1/timesheets?scope=receivable&status=DISPUTED', org.managerToken));
  api.countTask('Review disputed timesheets');
  for (const ts of (disputed.body as any[]) ?? []) {
    const start = new Date(ts.shift.startsAt).getTime();
    const end = new Date(ts.shift.endsAt).getTime();
    await api.task('Correct a disputed timesheet', 'rota manager', () => api.post(`/api/v1/timesheets/${ts.id}/submit`, org.managerToken, { clockInAt: iso(new Date(start)), clockOutAt: iso(new Date(end - rng.int(0, 30) * 60_000)), breakMinutes: ts.breakMinutes, notes: 'Corrected after dispute' }));
    api.countTask('Correct a disputed timesheet');
  }
}

/** Capacity flags: raise when spare, withdraw when the balance flips. */
export async function manageFlags(ctx: SimContext, org: SimOrg, week: number): Promise<void> {
  const { api, rng, clock, stats, gaps } = ctx;
  const groups: RoleGroup[] = ['CARE', 'SENIOR', 'NURSE'];
  for (const g of groups) {
    const base = org.balance[g];
    const season = seasonal(week);
    let balance = base < 0 ? base * season : base * (2 - season);
    if (org.shock) balance = balance < 0 ? balance * org.shock.factor : balance / org.shock.factor;
    const spareWorkers = org.workers.filter((w) => w.group === g && w.shareable && w.active).length;
    if (balance >= 1 && spareWorkers > 0 && !org.activeSurplusFlag[g]) {
      const hours = Math.min(Math.round(balance) * 8 * 2, spareWorkers * 24);
      const res = await api.task('Raise a surplus flag', 'rota manager', () =>
        api.post('/api/v1/capacity/flags', org.managerToken, { kind: 'SURPLUS', jobRole: g === 'CARE' ? 'CARE_ASSISTANT' : g === 'SENIOR' ? 'SENIOR_CARER' : 'NURSE', headcount: Math.max(1, Math.round(balance)), hoursRequested: hours, startsAt: iso(clock.now), endsAt: iso(clock.plusDays(14)), radiusKm: 30, note: 'Staff short of hours this fortnight' }),
      );
      api.countTask('Raise a surplus flag');
      if (res.status === 201) org.activeSurplusFlag[g] = res.body.id;
    } else if (balance < -0.5 && !org.activeSurplusFlag[g] && rng.chance(0.4) && org.type === 'PROVIDER') {
      const res = await api.task('Raise a shortage flag', 'rota manager', () =>
        api.post('/api/v1/capacity/flags', org.managerToken, { kind: 'SHORTAGE', jobRole: g === 'CARE' ? 'CARE_ASSISTANT' : g === 'SENIOR' ? 'SENIOR_CARER' : 'NURSE', headcount: Math.round(-balance), hoursRequested: Math.round(-balance) * 8 * 2, startsAt: iso(clock.now), endsAt: iso(clock.plusDays(14)) }),
      );
      api.countTask('Raise a shortage flag');
      void res;
    } else if (balance < 0 && org.activeSurplusFlag[g]) {
      await api.task('Withdraw a surplus flag', 'rota manager', () => api.post(`/api/v1/capacity/flags/${org.activeSurplusFlag[g]}/withdraw`, org.managerToken));
      api.countTask('Withdraw a surplus flag');
      delete org.activeSurplusFlag[g];
    }
  }
  // Flags fulfilled or expired server-side: refresh our view.
  const mine = await api.task('Check my capacity flags', 'rota manager', () => api.get('/api/v1/capacity/flags?status=ACTIVE&kind=SURPLUS', org.managerToken));
  api.countTask('Check my capacity flags');
  const activeIds = new Set(((mine.body as any[]) ?? []).map((f) => f.id));
  for (const g of groups) if (org.activeSurplusFlag[g] && !activeIds.has(org.activeSurplusFlag[g])) delete org.activeSurplusFlag[g];
  if (week > 2 && Object.keys(org.activeSurplusFlag).length === 0 && groups.some((g) => org.balance[g] >= 2)) {
    gaps.record({
      id: 'DSP-03',
      title: 'Flags must be re-raised by hand every fortnight; nothing nudges a supplier whose flag lapsed',
      category: 'Shifts & dispatch',
      severity: 'medium',
      persona: 'rota manager at a supplier',
      month: monthOf(clock.now),
      evidence: `${org.name} still had spare staff but no active flag after its previous one expired or was fulfilled, so it had dropped to network timing without noticing.`,
      impact: 'The priority mechanism depends on managers remembering to flag; in practice flags lapse and priority goes to whoever is most diligent, not most in need.',
      proposal: 'Expiry and fulfilment reminders, one-click re-raise, recurring flags (e.g. "every week until occupancy recovers"), and a suggestion to flag when the platform sees a supplier\'s workers repeatedly eligible but idle.',
    });
  }
  void stats;
}

/** Compliance renewals: officers renew expiring documents with a lag; some slip through. */
export async function complianceRound(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, rng, clock, gaps, stats } = ctx;
  const list = await api.task('Review compliance list', 'compliance officer', () => api.get('/api/v1/workers', org.adminToken));
  api.countTask('Review compliance list');
  if (list.status !== 200) return;
  let blocked = 0;
  let renewed = 0;
  for (const w of list.body as any[]) {
    if (w.status !== 'ACTIVE') continue;
    const items = (w.compliance?.items ?? []) as Array<{ type: DocumentType; status: string }>;
    if (w.compliance?.status === 'NON_COMPLIANT') blocked++;
    for (const item of items) {
      if (item.status !== 'EXPIRING' && item.status !== 'EXPIRED') continue;
      if (!rng.chance(item.status === 'EXPIRED' ? 0.5 : 0.35)) continue;
      const doc = await api.task('Renew a worker document', 'compliance officer', () => api.post(`/api/v1/workers/${w.id}/documents`, org.adminToken, { type: item.type, reference: `${item.type.slice(0, 3)}-${rng.int(100000, 999999)}`, expiresAt: iso(clock.plusDays(rng.int(365, 1095))) }));
      api.countTask('Renew a worker document');
      if (doc.status === 201) {
        await api.task('Verify a worker document', 'compliance officer', () => api.patch(`/api/v1/workers/${w.id}/documents/${doc.body.id}`, org.adminToken, { verified: true }));
        api.countTask('Verify a worker document');
        renewed++;
      }
    }
  }
  stats.current.workersBlockedByCompliance = Math.max(stats.current.workersBlockedByCompliance, blocked);
  if (blocked >= 5 && org.workers.length >= 40) {
    gaps.record({
      id: 'CMP-02',
      title: 'Expiry alerts only reach the employer, and only in-app; workers cannot renew themselves',
      category: 'Compliance',
      severity: 'high',
      persona: 'compliance officer',
      month: monthOf(clock.now),
      evidence: `${org.name} had ${blocked} active workers blocked by expired or missing documents at one point; renewals are entered by the officer after the fact (${renewed} this round) because workers have no way to upload a renewed certificate.`,
      impact: 'Supply is lost exactly when it is needed; the officer becomes the bottleneck for hundreds of certificates a year.',
      proposal: 'Worker self-upload with manager verification, email/SMS reminders to the worker at 60/30/7 days, and a compliance dashboard per organisation with upcoming expiries by month.',
    });
  }
}

/** Monthly statements and payment behaviour. */
export async function monthEnd(ctx: SimContext, periodStart: Date, periodEnd: Date): Promise<void> {
  const { api, world, rng, clock, gaps } = ctx;
  const res = await api.task('Generate monthly statements', 'agency finance', () => api.post('/api/v1/invoices/generate', world.platformAdminToken, { periodStart: iso(periodStart), periodEnd: iso(periodEnd) }));
  api.countTask('Generate monthly statements');
  const created = (res.body as any[]) ?? [];
  ctx.log(`${fmtDate(clock.now)} statements for ${fmtDate(periodStart)}–${fmtDate(periodEnd)}: ${created.length} issued, £${created.reduce((s, i) => s + i.subtotal, 0).toFixed(0)} billed, £${created.reduce((s, i) => s + i.platformFee, 0).toFixed(0)} platform fee`);
  // Hosts pay after their lag (scheduled: we record due dates and settle in a later step).
  for (const inv of created) {
    const host = world.org(inv.hostOrgId);
    pendingPayments.push({ invoiceId: inv.id, hostOrgId: inv.hostOrgId, dueAt: new Date(clock.now.getTime() + (host?.payLagDays ?? 30) * DAY) });
  }
  if (created.length > 0) {
    gaps.record({
      id: 'FIN-01',
      title: 'Statements are generated and marked paid by hand; nothing collects money or chases it',
      category: 'Finance',
      severity: 'high',
      persona: 'agency finance',
      month: monthOf(clock.now),
      evidence: `${created.length} statements issued this month; each host must be invoiced through the agency's own accounts system and marked paid manually; suppliers are paid outside the platform with no remittance.`,
      impact: 'Double keying into the accounts package; no ageing report; the agency carries credit risk without visibility.',
      proposal: 'Self-billing PDFs and remittances, Xero/Sage/QuickBooks export, Direct Debit or card collection, automatic reminders at 7/14/30 days overdue, an ageing report, and a credit-hold rule that pauses posting for hosts over N days overdue.',
      decisionNeeded: 'Who pays whom? (a) hosts pay the platform and the platform pays suppliers (platform carries the float), or (b) hosts pay suppliers directly and the platform only invoices its fee.',
    });
  }
  void rng;
}

export const pendingPayments: Array<{ invoiceId: string; hostOrgId: string; dueAt: Date }> = [];

export async function settlePayments(ctx: SimContext): Promise<void> {
  const { api, world, clock } = ctx;
  for (let i = pendingPayments.length - 1; i >= 0; i--) {
    const p = pendingPayments[i]!;
    if (p.dueAt > clock.now) continue;
    const host = world.org(p.hostOrgId);
    if (!host || host.status !== 'ACTIVE' || host.payLagDays >= 90) continue; // the chronic late payer never pays
    await api.task('Mark a statement paid', 'host finance', () => api.post(`/api/v1/invoices/${p.invoiceId}/mark-paid`, host.adminToken));
    api.countTask('Mark a statement paid');
    pendingPayments.splice(i, 1);
  }
}

export function monthOf(d: Date): number {
  return Math.floor((d.getTime() - SIM_START.getTime()) / (30 * DAY));
}
