/**
 * The simulated world: an agency, care providers of different sizes joining over time, their workers,
 * and the weekly rhythm of posting shifts, raising capacity flags, responding, confirming, working,
 * submitting timesheets, approving them and settling statements.
 *
 * Every interaction goes through the real HTTP API as the corresponding human would, so the number
 * of calls a task needs is a direct measure of how laborious it is today.
 */
import { requiredDocumentsForRole, type DocumentType, type JobRole, type Skill } from '@merge/shared';
import { AREAS, ApiClient, Clock, DAY, GapRegister, HOUR, Rng, fmtDate, iso, personName, postcodeNear, round1, listOf } from './lib.js';
import { totpCode } from '../src/lib/totp.js';

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
  /** How the staff were loaded and what it cost; null for the agency (its bank is created at bootstrap). */
  onboarding: { method: 'import' | 'one-by-one'; staff: number; apiCalls: number } | null;
  /** Decision 10: a manager limited to the first site, kept so the record can be checked later (ONB-03). */
  siteManagerToken?: string;
}

/** An email the platform sent, as the simulated person would see it in their inbox. */
export interface OutboundMail {
  to: string;
  subject: string | null;
  body: string;
  createdAt: number;
}

/**
 * Run-wide counters behind the "verified fixed" evidence. Each probe re-records its gap with the
 * cumulative figures, so the final register carries the whole run's numbers.
 */
export const runTotals = {
  invited: 0,
  accepted: 0,
  bulkConfirmCalls: 0,
  bulkConfirmed: 0,
  bulkApproveCalls: 0,
  bulkApproved: 0,
  hostInvoices: 0,
  hostInvoiceValue: 0,
  remittances: 0,
  remittanceValue: 0,
  hostPaymentsRecorded: 0,
  markedOverdue: 0,
  financeReminders: 0,
  creditHoldsApplied: 0,
  autoApproved: 0,
};

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
  /** The simulated person reads their email: latest outbound message body sent to this address, if any. */
  mailbox: (email: string) => string | null;
  /** How many emails the platform has sent that match (for probes that check a message reached someone). */
  countEmails: (predicate: (m: OutboundMail) => boolean) => number;
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
  escalatedShifts: number;
  reportsRaised: number;
  barsCreated: number;
  emailsSent: number;
  workersReleased: number;
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
      escalatedShifts: 0,
      reportsRaised: 0,
      barsCreated: 0,
      emailsSent: 0,
      workersReleased: 0,
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
  /** Platform floor charge rate (decision 3), refreshed weekly; 0 when the endpoint does not exist. */
  floorRate = 0;
  /** Which of the phase-1 endpoints exist on the API under test (detected on first use). */
  features: Record<string, boolean> = {};
  /** Checks that could not be settled when first met and are re-read at the end of the run. */
  deferred: { cmp02?: { orgName: string; blocked: number; renewed: number; month: number } } = {};
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
  /** Decision 6: this host chooses automatic escalation of unfilled shifts. */
  autoEscalate?: boolean;
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
    onboarding: null,
  };
  world.agency = agency;
  world.orgs.push(agency);
  // Decision 16: managers must enrol an authenticator before anything else. The platform owner does so here;
  // the trial then switches the requirement off for the other organisations so their sign-up effort is measured without it.
  const setup = await api.task('Authenticator enrolment', 'agency owner', () => api.post('/api/v1/auth/2fa/setup', world.platformAdminToken, {}));
  if (setup.status !== 200) throw new Error(`2fa setup failed: ${JSON.stringify(setup.body)}`);
  const enabled = await api.task('Authenticator enrolment', 'agency owner', () => api.post('/api/v1/auth/2fa/enable', world.platformAdminToken, { code: totpCode(setup.body.secret, clock.now) }));
  if (enabled.status !== 200) throw new Error(`2fa enable failed: ${JSON.stringify(enabled.body)}`);
  const settings = await api.task('Platform settings', 'agency owner', () => api.patch('/api/v1/admin/settings', world.platformAdminToken, { platformFeePct: 8, priorityWindowMinutes: 120, agencyWindowMinutes: 60, agencyPosition: 'AFTER_PRIORITY', twoFactorRequiredForManagers: false }));
  if (settings.status !== 200) throw new Error(`platform settings failed: ${JSON.stringify(settings.body)}`);
  await refreshFloorRate(ctx);
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
      organisation: { name: spec.name, postcode: `${area.outward} 1AA`, lat: area.lat, lng: area.lng, serviceTypes: [spec.serviceType], defaultChargeRate: BASE_RATE.CARE, workerSelfServiceAllowed: !!spec.selfService, email, cqcRegistrationNumber: `1-${rng.int(100000000, 999999999)}` },
      admin: { email, password: 'Simulation-Pass-1', firstName: 'Admin', lastName: spec.name.split(' ')[0]! },
      cqcRegistrationNumber: `1-${rng.int(100000000, 999999999)}`,
      mouAccepted: true,
    }),
  );
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  api.countTask('Register organisation');
  // Decision 12: the agency checks CQC registration and MOU acceptance, then approves.
  let approval = await api.task('Approve a new organisation', 'agency owner', () => api.post(`/api/v1/organisations/${reg.body.organisation.id}/approve`, world.platformAdminToken, {}));
  if (approval.status === 404) approval = await api.task('Approve a new organisation', 'agency owner', () => api.patch(`/api/v1/organisations/${reg.body.organisation.id}`, world.platformAdminToken, { status: 'ACTIVE' }));
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
    onboarding: null,
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

  if (spec.autoEscalate) {
    await api.task('Choose automatic escalation', 'org admin', () => api.patch(`/api/v1/organisations/${org.id}`, org.adminToken, { escalationMode: 'AUTO', escalationCeilingPct: 20 }));
    api.countTask('Choose automatic escalation');
  }

  const imported = spec.staff >= 40 ? await importWorkers(ctx, org, spec.staff, { loginShare: spec.selfService ? 0.5 : 0.15, nurses: spec.serviceType === 'NURSING' }) : false;
  if (!imported) await addWorkers(ctx, org, spec.staff, { loginShare: spec.selfService ? 0.5 : 0.15, nurses: spec.serviceType === 'NURSING' });

  const elapsedMin = round1((performance.now() - started) / 60_000);
  const calls = api.calls.length - callsBefore;
  org.onboarding = { method: imported ? 'import' : 'one-by-one', staff: spec.staff, apiCalls: calls };
  ctx.log(`${fmtDate(clock.now)} onboarded ${spec.name} (${spec.staff} staff, ${spec.sites} site(s)) ${imported ? 'by spreadsheet import' : 'one worker at a time'}: ${calls} API calls, ${elapsedMin} min of machine time`);
  const onb01 = {
    id: 'ONB-01',
    category: 'Onboarding' as const,
    severity: 'blocker' as const,
    persona: 'HR manager at a large provider',
    month: Math.floor((clock.now.getTime() - SIM_START.getTime()) / DAY / 30),
    impact: 'Large providers will not finish onboarding; the platform only gets a handful of their staff, which starves the exchange of supply.',
    proposal: 'CSV/Excel import of workers (name, email, role, skills, contracted hours, postcode, document references and expiry dates) with a preview, validation report and partial-success handling; bulk verification; and an export of the same shape so providers can round-trip from their HR or rota system.',
  };
  if (spec.staff >= 40 && !imported) {
    gaps.record({
      ...onb01,
      title: 'No bulk import: every worker and every document is added one at a time',
      evidence: `${spec.name} with ${spec.staff} staff needed ${calls} API calls (one worker + ${requiredDocumentsForRole('CARE_ASSISTANT').length}–8 documents + a verification each). A human doing this through the UI would type each worker and each certificate by hand.`,
    });
  } else if (imported) {
    // Compare what the two routes cost per worker across every employer onboarded so far.
    const by = (method: 'import' | 'one-by-one') => {
      const ps = world.orgs.filter((o) => o.onboarding?.method === method && o.onboarding.staff > 0);
      const staff = ps.reduce((s, o) => s + o.onboarding!.staff, 0);
      const c = ps.reduce((s, o) => s + o.onboarding!.apiCalls, 0);
      return { orgs: ps.length, staff, perWorker: staff ? round1(c / staff) : 0 };
    };
    const imp = by('import');
    const one = by('one-by-one');
    gaps.record({
      ...onb01,
      title: 'Bulk import: a spreadsheet loads workers, documents and invitations in a few calls',
      status: 'fixed',
      evidence: `Spreadsheet import cost ${imp.perWorker} API calls per worker (${imp.orgs} employer(s), ${imp.staff.toLocaleString()} staff: registration, sites, template, preview, apply, bulk verification and every invitation accepted)${one.orgs ? ` against ${one.perWorker} per worker when added one at a time (${one.orgs} employer(s), ${one.staff.toLocaleString()} staff)` : ''}. ${spec.name} loaded ${spec.staff} staff with ${calls} calls; ${runTotals.invited} workers have been invited by email across the run and ${runTotals.accepted} accepted.`,
    });
  }
  if (spec.sites >= 3) await probeSiteScopedManager(ctx, org);
  return org;
}

/**
 * Decision 10 (ONB-03): a group invites a home manager limited to its first site. As that manager, the rota
 * must show only that site and posting to another site must be refused.
 */
async function probeSiteScopedManager(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, gaps, clock, rng, world } = ctx;
  const home = org.sites[0]!;
  const other = org.sites[1]!;
  const open = (what: string) =>
    gaps.record({
      id: 'ONB-03',
      title: 'No site-level roles: a multi-site group gives every manager access to every site',
      category: 'Workforce',
      severity: 'high',
      persona: 'Regional manager of a care group',
      month: 0,
      evidence: `${org.name} has ${org.sites.length} sites but one organisation. ${what}`,
      impact: 'Groups cannot delegate to home managers safely; either they share one login or they register each home as a separate organisation and lose group-level reporting and internal-first dispatch.',
      proposal: 'Scope ORG_MANAGER to one or more sites; group-level admins see everything. Alternatively an organisation hierarchy (group → homes) with an internal-first dispatch stage.',
    });
  const email = `manager.${home.name.toLowerCase().replace(/[^a-z]+/g, '-')}@${org.name.toLowerCase().replace(/[^a-z]+/g, '-')}.example`;
  const invite = await api.task('Invite a home manager', 'group admin', () => api.post('/api/v1/onboarding/invitations', org.adminToken, { email, role: 'ORG_MANAGER', firstName: 'Home', lastName: 'Manager', siteIds: [home.id] }));
  if (invite.status !== 201) return open(`Inviting a manager limited to ${home.name} failed: HTTP ${invite.status} (${invite.body?.error ?? 'no invitation endpoint'}); its rota manager login sees and can act on all of them.`);
  api.countTask('Invite a home manager');
  const token = ctx.mailbox(email)?.match(/\/invite\/([A-Za-z0-9_-]+)/)?.[1];
  const accept = token ? await api.task('Manager accepts an invitation', 'home manager', () => api.post(`/api/v1/onboarding/invitations/${token}/accept`, null, { password: `Welcome-${rng.int(100000, 999999)}-ok` })) : null;
  if (!accept || accept.status !== 200 || !accept.body?.token) return open(`The home manager's invitation email ${token ? `could not be accepted (HTTP ${accept?.status})` : 'never arrived'}.`);
  api.countTask('Manager accepts an invitation');
  org.siteManagerToken = accept.body.token as string;
  // Two drafts, one per site, so the rota has something to filter on the day the group joins.
  const draft = (site: SimSite, tokenFor: string) =>
    api.post('/api/v1/shifts', tokenFor, { siteId: site.id, jobRole: 'CARE_ASSISTANT', title: `Draft – ${site.name}`, startsAt: iso(clock.plusDays(10)), endsAt: iso(new Date(clock.plusDays(10).getTime() + 8 * HOUR)), breakMinutes: 30, headcount: 1, requiredSkills: ['MOVING_AND_HANDLING'], chargeRate: Math.max(BASE_RATE.CARE, world.floorRate), publish: false });
  const homeDraft = await api.task('Prepare a draft shift', 'group admin', () => draft(home, org.adminToken));
  const otherDraft = await api.task('Prepare a draft shift', 'group admin', () => draft(other, org.adminToken));
  const rota = await api.task('Home manager reviews the rota', 'home manager', () => api.get('/api/v1/shifts?scope=posted', org.siteManagerToken!));
  const rows = listOf(rota);
  const offSite = rows.filter((s) => s.siteId !== home.id);
  const denied = await api.task('Home manager posts for another site', 'home manager', () => draft(other, org.siteManagerToken!));
  const allowed = await api.task('Home manager posts for their site', 'home manager', () => draft(home, org.siteManagerToken!));
  const staff = await api.task('Home manager reviews staff', 'home manager', () => api.get('/api/v1/workers', org.siteManagerToken!));
  const staffOffSite = listOf(staff).filter((w) => w.homeSiteId && w.homeSiteId !== home.id);
  for (const d of [homeDraft, otherDraft, allowed]) if (d.status === 201) await api.post(`/api/v1/shifts/${d.body.id}/cancel`, org.adminToken, { reason: 'Access check only' });
  const ok = rota.status === 200 && rows.length >= 1 && offSite.length === 0 && denied.status === 403 && allowed.status === 201 && staff.status === 200 && staffOffSite.length === 0;
  if (!ok) return open(`A manager invited for ${home.name} only: GET /shifts?scope=posted → ${rota.status} with ${rows.length} rows (${offSite.length} from other sites); POST /shifts for ${other.name} → ${denied.status} (expected 403); for ${home.name} → ${allowed.status}; GET /workers → ${staff.status} with ${staffOffSite.length} worker(s) based elsewhere.`);
  gaps.record({
    id: 'ONB-03',
    title: 'Site-scoped managers: a group invites a home manager who sees and acts on their own site only',
    category: 'Workforce',
    severity: 'high',
    persona: 'Regional manager of a care group',
    month: 0,
    status: 'fixed',
    evidence: `${org.name} (${org.sites.length} sites) invited a manager limited to ${home.name} by email; after accepting, their rota showed ${rows.length} shift(s), all at that site (the group's ${other.name} draft was hidden), POST /shifts for ${other.name} was refused (403) while their own site's was accepted (201), and GET /workers listed only staff based at ${home.name} or unassigned (${listOf(staff).length} rows, 0 elsewhere). The group admin still sees everything; moving staff between a group's own homes stays outside Merge (decision 10).`,
    impact: 'Groups can delegate to home managers without sharing one login or splitting into separate organisations.',
    proposal: 'Keep: ORG_MANAGER scoped to one or more sites; group-level admins see everything.',
  });
}

export const SIM_START = new Date('2026-11-02T06:00:00Z'); // a Monday

async function addWorkers(ctx: SimContext, org: SimOrg, count: number, opts: { loginShare: number; nurses?: boolean }): Promise<void> {
  const { api, rng, clock, gaps, world } = ctx;
  let unverifiedBacklog = 0;
  let invited = 0;
  let accepted = 0;
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
      if (world.features.invitations !== false) {
        // Decision ONB-02: the manager sends an invitation; the worker opens the email and sets their own password.
        const invite = await api.task('Invite a worker by email', 'HR / rota manager', () => api.post('/api/v1/onboarding/invitations', org.adminToken, { email, role: 'WORKER', firstName: name.firstName, lastName: name.lastName, workerId: worker.id }));
        if (invite.status === 404) world.features.invitations = false;
        else {
          api.countTask('Invite a worker by email');
          if (invite.status === 201) {
            world.features.invitations = true;
            invited++;
            runTotals.invited++;
            const token = ctx.mailbox(email)?.match(/\/invite\/([A-Za-z0-9_-]+)/)?.[1];
            if (token) {
              const res = await api.task('Worker accepts an invitation', 'care worker (phone)', () => api.post(`/api/v1/onboarding/invitations/${token}/accept`, null, { password: `Welcome-${rng.int(100000, 999999)}-ok` }));
              api.countTask('Worker accepts an invitation');
              if (res.status === 200 && res.body?.token) {
                worker.token = res.body.token;
                worker.email = email;
                accepted++;
                runTotals.accepted++;
              }
            }
          }
        }
      }
      if (world.features.invitations === false) {
        const login = await api.task('Create a worker login', 'HR / rota manager', () => api.post(`/api/v1/workers/${worker.id}/login`, org.adminToken, { email, password: 'Temp-Pass-1234' }));
        api.countTask('Create a worker login');
        if (login.status === 201) {
          const session = await api.task('Log in', 'care worker', () => api.post('/api/v1/auth/login', null, { email, password: 'Temp-Pass-1234' }));
          worker.token = session.body.token;
          worker.email = email;
        }
      }
    }
  }
  if (count >= 10 && world.features.invitations === false) {
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
  } else if (invited > 0) {
    gaps.record({
      id: 'ONB-02',
      title: 'Worker logins are created by email invitation; the worker sets their own password',
      category: 'Onboarding',
      severity: 'high',
      persona: 'HR manager',
      month: 0,
      status: 'fixed',
      evidence: `${org.name} invited ${invited} worker(s) by email and ${accepted} opened the link and chose a password; across the run ${runTotals.invited} invitations were sent (by hand and from imports) and ${runTotals.accepted} accepted. No manager chose or passed on a password; forgotten-password reset and a forced change on first login exist. The email provider and sender domain are still to be chosen at deployment (decision 15).`,
      impact: 'No passwords travel by WhatsApp or paper, and locked-out workers can help themselves.',
      proposal: 'Keep: invitation and reset tokens delivered by email, single use, with expiry.',
    });
  }
  if (unverifiedBacklog > 0) {
    // The compliance officer looks for what the sheet or the manager left unverified and clears it in one go.
    const queue = await api.task('Review verification queue', 'compliance officer', () => api.get(`/api/v1/compliance/verification-queue?orgId=${org.id}`, org.adminToken));
    const ids = queue.status === 200 ? listOf(queue).map((d) => d.document?.id ?? d.id).filter(Boolean) : [];
    let verifyCalls = 0;
    let verified = 0;
    if (queue.status === 200) {
      api.countTask('Review verification queue');
      for (let i = 0; i < ids.length; i += 200) {
        const res = await api.task('Verify documents in bulk', 'compliance officer', () => api.post('/api/v1/compliance/verify', org.adminToken, { documentIds: ids.slice(i, i + 200) }));
        api.countTask('Verify documents in bulk');
        verifyCalls++;
        verified += res.status === 200 ? (res.body?.verified?.length ?? ids.slice(i, i + 200).length) : 0;
      }
    }
    if (queue.status === 200 && ids.length >= unverifiedBacklog) {
      gaps.record({
        id: 'CMP-01',
        title: 'A verification queue shows what is unverified and clears it in bulk',
        category: 'Compliance',
        severity: 'medium',
        persona: 'Compliance officer',
        month: 0,
        status: 'fixed',
        evidence: `${org.name} ended onboarding with ${unverifiedBacklog} document(s) never verified; GET /compliance/verification-queue listed ${ids.length} and POST /compliance/verify cleared ${verified} in ${verifyCalls} call(s), so no worker stays blocked without the officer knowing. Expiring documents have their own horizon report (GET /compliance/expiring).`,
        impact: 'Supply is no longer quietly lost to a backlog nobody can see.',
        proposal: 'Keep: the queue and bulk verify; a weekly digest of unverified and expiring documents per organisation would round it off.',
      });
    } else {
      gaps.record({
        id: 'CMP-01',
        title: 'Verification backlog is invisible: unverified documents silently block workers',
        category: 'Compliance',
        severity: 'medium',
        persona: 'Compliance officer',
        month: 0,
        evidence: `${org.name} ended onboarding with ${unverifiedBacklog} document(s) never verified; those workers show as non-compliant with no queue or reminder for the verifier (GET /compliance/verification-queue → ${queue.status}${queue.status === 200 ? ` with ${ids.length} rows` : ''}).`,
        impact: 'Supply is quietly lost and managers only find out when a request is refused.',
        proposal: 'A "needs verification" queue with bulk verify, plus a weekly digest of unverified and expiring documents per organisation.',
      });
    }
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
  if (ctx.world.floorRate > 0 && rate < ctx.world.floorRate) rate = Math.ceil(ctx.world.floorRate * 20) / 20; // decision 3: never below the floor
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
  const open = listOf(board).filter((s) => s.access.open && s.myAssignments.length === 0 && s.placesLeft > 0);
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
  if (open.length > 25 && org.size !== 'large' && !gaps.gaps.has('DSP-05')) {
    // A busy board: the manager narrows it to what is near and sorts by distance (widening once when nothing is close).
    let radius = 30;
    let near = await api.task('Sort the board by distance', 'rota manager', () => api.get(`/api/v1/shifts?scope=available&sort=distance&nearKm=${radius}`, org.managerToken));
    if (near.status === 200 && listOf(near).length === 0) {
      radius = 60;
      near = await api.task('Sort the board by distance', 'rota manager', () => api.get(`/api/v1/shifts?scope=available&sort=distance&nearKm=${radius}`, org.managerToken));
    }
    const rows = near.status === 200 ? listOf(near) : [];
    const withDistance = rows.filter((r) => typeof r.distanceKm === 'number');
    if (near.status === 200 && rows.length > 0 && withDistance.length === rows.length) {
      api.countTask('Sort the board by distance');
      const sorted = withDistance.every((r, i) => i === 0 || r.distanceKm >= withDistance[i - 1]!.distanceKm);
      gaps.record({
        id: 'DSP-05',
        title: 'The shift board sorts by distance, rate or start and filters to a radius',
        category: 'Shifts & dispatch',
        severity: 'medium',
        persona: 'rota manager at a supplier',
        month: monthOf(clock.now),
        status: 'fixed',
        evidence: `${org.name} saw ${open.length} open shifts at once; GET /shifts?scope=available&sort=distance&nearKm=${radius} returned ${rows.length} within ${radius} km, every row with distanceKm (nearest ${withDistance[0]?.distanceKm} km, farthest ${withDistance[withDistance.length - 1]?.distanceKm} km${sorted ? ', in order' : ''}), and sort=opens|start|rate are available too. Worker logins see eligible/blockers on each row.`,
        impact: 'Suppliers find the shifts their staff can cover first instead of opening each one.',
        proposal: 'Keep: board sorting and radius; a per-organisation "you have N eligible workers" count and saved searches would round it off.',
      });
    } else {
      gaps.record({
        id: 'DSP-05',
        title: 'The shift board is a flat list with no sort by fit, distance or pay',
        category: 'Shifts & dispatch',
        severity: 'medium',
        persona: 'rota manager at a supplier',
        month: monthOf(clock.now),
        evidence: `${org.name} saw ${open.length} open shifts at once; sorting by distance within ${radius} km returned HTTP ${near.status} with ${rows.length} rows, ${withDistance.length} carrying a distance. The board is ordered by release time only, and finding which ones its staff can actually cover means opening each one.`,
        impact: 'Suppliers respond to the first few and miss better matches; priority organisations waste their window.',
        proposal: 'Board filters and sorting by role fit, distance, rate, start time; a per-organisation "you have N eligible workers" count computed server-side; saved searches and alerts.',
      });
    }
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
    const open = listOf(board).filter((s) => s.access.open && s.myAssignments.length === 0 && s.placesLeft > 0);
    if (open.length === 0 || !rng.chance(0.5)) continue;
    const shift = rng.pick(open);
    // The board marks each row "you can take this" or "not eligible"; nobody presses Request on the latter.
    if (shift.eligible === false) {
      for (const b of shift.blockers ?? []) stats.refused(`worker:${b.code}`);
      continue;
    }
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
  const requests = listOf(incoming);
  // First come, first served per shift, confirmed in one action.
  const chosen: string[] = [];
  const seen = new Map<string, number>();
  if (requests.length >= 5 && world.features.bulkConfirm !== false) {
    for (const r of [...requests].sort((a, b) => new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime())) {
      const cap = world.shifts.get(r.shiftId)?.headcount ?? 1;
      const n = seen.get(r.shiftId) ?? 0;
      if (n < cap && rng.chance(0.92)) {
        chosen.push(r.id);
        seen.set(r.shiftId, n + 1);
      }
    }
  }
  if (chosen.length > 0) {
    const bulk = await api.task('Confirm requests in bulk', 'rota manager', () => api.post('/api/v1/assignments/bulk', org.managerToken, { ids: chosen, action: 'confirm' }));
    if (bulk.status === 404) world.features.bulkConfirm = false;
    else {
      api.countTask('Confirm requests in bulk');
      world.features.bulkConfirm = true;
      let okCount = 0;
      for (const res of (bulk.body?.results as any[]) ?? []) {
        if (!res.ok) {
          if (res.details?.code === 'NO_LONGER_ELIGIBLE') stats.refused('late:NO_LONGER_ELIGIBLE');
          continue;
        }
        okCount++;
        const r = requests.find((x) => x.id === res.id);
        if (r) recordConfirmation(ctx, r, { ...r, status: 'CONFIRMED' });
      }
      runTotals.bulkConfirmCalls++;
      runTotals.bulkConfirmed += okCount;
      gaps.record({
        id: 'DSP-02',
        title: 'Bulk confirm: a host answers a sitting of requests in one action',
        category: 'Shifts & dispatch',
        severity: 'high',
        persona: 'rota manager at a host',
        month: monthOf(clock.now),
        status: 'fixed',
        evidence: `${org.name} had ${requests.length} pending requests at one check and confirmed ${okCount} of ${chosen.length} chosen in a single POST /assignments/bulk (rows that were no longer eligible came back with their blockers instead of a booking). Across the run ${runTotals.bulkConfirmed} requests were confirmed in ${runTotals.bulkConfirmCalls} bulk calls (${round1(runTotals.bulkConfirmed / runTotals.bulkConfirmCalls)} per call); each confirmation re-checks eligibility first.`,
        impact: 'Winter weeks no longer pile up hundreds of clicks; workers put forward hear back at the host\'s next check.',
        proposal: 'Keep: bulk confirm/decline grouped per shift; optional auto-confirm per host already exists.',
      });
      return;
    }
  }
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
  if (requests.length >= 15 && world.features.bulkConfirm === false) {
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
  for (const o of listOf(offers)) {
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
  const open = listOf(posted).filter((s) => s.pendingRequests === 0 && new Date(s.startsAt).getTime() - clock.now.getTime() < 3 * DAY);
  if (open.length === 0) return;
  const shift = rng.pick(open);
  const cands = await api.task('Search candidates for a shift', 'rota manager', () => api.get(`/api/v1/shifts/${shift.id}/candidates`, org.managerToken));
  api.countTask('Search candidates for a shift');
  const list = listOf(cands);
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
  for (const a of listOf(supplied)) {
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
    for (const s of listOf(posted)) {
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
  for (const ts of listOf(receivable)) {
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
    for (const a of listOf(incoming)) {
      const start = new Date(a.shift.startsAt).getTime();
      if (start > clock.now.getTime() || clock.now.getTime() - start > 4 * HOUR) continue;
      const supplier = ctx.world.org(a.supplierOrgId);
      if (!rng.chance((1 - (supplier?.reliability ?? 0.96)) * 0.5)) continue;
      const res = await api.task('Record a no-show', 'rota manager', () => api.post(`/api/v1/assignments/${a.id}/no-show`, org.managerToken));
      api.countTask('Record a no-show');
      if (res.status === 200) {
        stats.current.noShows++;
        if (supplier) supplier.noShowsCaused++;
        if (rng.chance(0.8)) {
          const rep = await api.task('Report a concern to the employer', 'rota manager', () => api.post('/api/v1/trust/reports', org.managerToken, { workerId: a.workerId, assignmentId: a.id, category: 'ATTENDANCE', description: 'Did not attend and did not call.' }));
          if (rep.status === 201) {
            api.countTask('Report a concern to the employer');
            stats.current.reportsRaised++;
            ctx.world.features.reports = true;
          } else if (rep.status === 404) ctx.world.features.reports = false;
        }
        if (supplier && supplier.noShowsCaused >= 2 && rng.chance(0.5)) {
          const bar = await api.task('Bar a worker from our shifts', 'rota manager', () => api.post('/api/v1/trust/bars', org.managerToken, { workerId: a.workerId, reason: 'Repeated non-attendance' }));
          if (bar.status === 201) {
            api.countTask('Bar a worker from our shifts');
            stats.current.barsCreated++;
          }
        }
      }
    }
  }
  if (submitted >= 20 && ctx.world.features.bulkApprove === false) {
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
  const { api, rng, stats, world, gaps, clock } = ctx;
  if (!rng.chance(org.responsiveness * 0.7)) return;
  const payable = await api.task('Review submitted timesheets', 'finance clerk', () => api.get('/api/v1/timesheets?scope=payable&status=SUBMITTED', org.managerToken));
  api.countTask('Review submitted timesheets');
  const rows = listOf(payable);
  let toApprove: any[] = [];
  const toDispute: any[] = [];
  for (const ts of rows) {
    const roll = rng.next();
    if (roll < 0.9) toApprove.push(ts);
    else if (roll < 0.95) toDispute.push(ts);
  }
  // A sitting of five or more: the clerk signs the clean ones off in one action and looks at the rest one by one.
  if (toApprove.length >= 5 && world.features.bulkApprove !== false) {
    const bulk = await api.task('Approve timesheets in bulk', 'finance clerk', () => api.post('/api/v1/timesheets/bulk-approve', org.managerToken, { ids: toApprove.map((t) => t.id) }));
    if (bulk.status === 404) world.features.bulkApprove = false;
    else {
      api.countTask('Approve timesheets in bulk');
      world.features.bulkApprove = true;
      const okIds = new Set(((bulk.body?.results as any[]) ?? []).filter((r) => r.ok).map((r) => r.id as string));
      for (const ts of toApprove) {
        if (!okIds.has(ts.id)) continue;
        stats.current.timesheetsApproved++;
        stats.current.hoursTraded += ts.paidHours ?? 0;
        stats.current.chargeTraded += ts.hostCost ?? 0;
        stats.current.platformFee += ts.platformFee ?? 0;
      }
      runTotals.bulkApproveCalls++;
      runTotals.bulkApproved += okIds.size;
      const flagged = toApprove.filter((t) => (t.exceptions ?? []).length > 0).length;
      gaps.record({
        id: 'FIN-02',
        title: 'Bulk approval with exceptions flagged; undecided timesheets auto-approve after 14 days',
        category: 'Finance',
        severity: 'high',
        persona: 'finance clerk',
        month: monthOf(clock.now),
        status: 'fixed',
        evidence: `${org.name} had ${rows.length} submitted timesheets at one sitting and approved ${okIds.size} of ${toApprove.length} in a single POST /timesheets/bulk-approve; ${flagged} row(s) carried exception flags (late clock-in, over length, missing clock-out, submitted late) for the clerk to look at first. Across the run ${runTotals.bulkApproved} timesheets were approved in ${runTotals.bulkApproveCalls} bulk calls and ${runTotals.autoApproved} were approved automatically after 14 days of host silence so remittances were not held up. Submission stays one per shift, as a clock-in and clock-out are.`,
        impact: 'Weekly admin no longer scales with volume on the host side, and suppliers are not left waiting on a host that never looks.',
        proposal: 'Keep: bulk approve, exception flags and the 14-day auto-approval; a weekly grid view is a UI matter.',
      });
      if (bulk.status === 200) toApprove = []; // rows the bulk call refused had a reason; nobody retries them one by one
    }
  }
  for (const ts of toApprove) {
    const r = await api.task('Approve a timesheet', 'finance clerk', () => api.post(`/api/v1/timesheets/${ts.id}/approve`, org.managerToken));
    api.countTask('Approve a timesheet');
    if (r.status === 200) {
      stats.current.timesheetsApproved++;
      stats.current.hoursTraded += r.body.paidHours;
      stats.current.chargeTraded += r.body.hostCost;
      stats.current.platformFee += r.body.platformFee;
    } else stats.apiError(r.status, 'POST /timesheets/:id/approve');
  }
  for (const ts of toDispute) {
    const r = await api.task('Dispute a timesheet', 'finance clerk', () => api.post(`/api/v1/timesheets/${ts.id}/dispute`, org.managerToken, { reason: rng.pick(['Left early', 'Break not deducted', 'Did not attend handover']) }));
    api.countTask('Dispute a timesheet');
    if (r.status === 200) stats.current.timesheetsDisputed++;
  }
}

/** Suppliers correct disputed timesheets. */
export async function resolveDisputes(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, rng } = ctx;
  if (!rng.chance(0.5)) return;
  const disputed = await api.task('Review disputed timesheets', 'rota manager', () => api.get('/api/v1/timesheets?scope=receivable&status=DISPUTED', org.managerToken));
  api.countTask('Review disputed timesheets');
  for (const ts of listOf(disputed)) {
    const start = new Date(ts.shift.startsAt).getTime();
    const end = new Date(ts.shift.endsAt).getTime();
    await api.task('Correct a disputed timesheet', 'rota manager', () => api.post(`/api/v1/timesheets/${ts.id}/submit`, org.managerToken, { clockInAt: iso(new Date(start)), clockOutAt: iso(new Date(end - rng.int(0, 30) * 60_000)), breakMinutes: ts.breakMinutes, notes: 'Corrected after dispute' }));
    api.countTask('Correct a disputed timesheet');
  }
}

/** Capacity flags: raise when spare, withdraw when the balance flips. */
export async function manageFlags(ctx: SimContext, org: SimOrg, week: number): Promise<void> {
  const { api, rng, clock, stats, gaps, world } = ctx;
  const groups: RoleGroup[] = ['CARE', 'SENIOR', 'NURSE'];
  for (const g of groups) {
    const base = org.balance[g];
    const season = seasonal(week);
    let balance = base < 0 ? base * season : base * (2 - season);
    if (org.shock) balance = balance < 0 ? balance * org.shock.factor : balance / org.shock.factor;
    const spare = org.workers.filter((w) => w.group === g && w.shareable && w.active);
    if (balance >= 1 && spare.length > 0 && !org.activeSurplusFlag[g]) {
      const headcount = Math.max(1, Math.round(balance));
      const hours = Math.min(headcount * 8 * 2, spare.length * 24);
      // Decision 8: contracted hours count against the 48-hour limit unless the employer names who is spare.
      const released = rng.shuffle(spare).slice(0, Math.min(spare.length, Math.max(headcount, Math.ceil(hours / 12))));
      const flag = { kind: 'SURPLUS', jobRole: g === 'CARE' ? 'CARE_ASSISTANT' : g === 'SENIOR' ? 'SENIOR_CARER' : 'NURSE', headcount, hoursRequested: hours, startsAt: iso(clock.now), endsAt: iso(clock.plusDays(14)), radiusKm: 30, note: 'Staff short of hours this fortnight' };
      const withNames = world.features.flagWorkers !== false;
      let res = await api.task('Raise a surplus flag', 'rota manager', () => api.post('/api/v1/capacity/flags', org.managerToken, withNames ? { ...flag, workerIds: released.map((w) => w.id) } : flag));
      if (withNames && res.status === 400) {
        world.features.flagWorkers = false; // an older API that does not take named staff
        res = await api.task('Raise a surplus flag', 'rota manager', () => api.post('/api/v1/capacity/flags', org.managerToken, flag));
      }
      api.countTask('Raise a surplus flag');
      if (res.status === 201) {
        org.activeSurplusFlag[g] = res.body.id;
        if (world.features.flagWorkers !== false) {
          world.features.flagWorkers = true;
          stats.current.workersReleased += res.body.workersReleased ?? released.length;
        }
      }
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
  const activeIds = new Set(listOf(mine).map((f) => f.id));
  for (const g of groups) if (org.activeSurplusFlag[g] && !activeIds.has(org.activeSurplusFlag[g])) delete org.activeSurplusFlag[g];
  if (week > 2 && Object.keys(org.activeSurplusFlag).length === 0 && groups.some((g) => org.balance[g] >= 2) && !gaps.gaps.has('DSP-03')) {
    // Was the manager told when the flag ran out, or did it lapse silently? Only meaningful once a flag has actually expired.
    const inbox = await api.task('Check notifications', 'rota manager', () => api.get('/api/v1/notifications?limit=200', org.managerToken));
    api.countTask('Check notifications');
    const expired = ((inbox.body?.notifications as any[]) ?? []).filter((n) => n.type === 'FLAG_EXPIRED');
    const flags = await api.task('Check my capacity flags', 'rota manager', () => api.get('/api/v1/capacity/flags?kind=SURPLUS&status=EXPIRED', org.managerToken));
    const lapsed = listOf(flags).length;
    if (expired.length === 0 && lapsed === 0) {
      /* nothing has lapsed yet; look again next week */
    } else if (expired.length > 0) {
      const latest = expired[0];
      gaps.record({
        id: 'DSP-03',
        title: 'A supplier is told when its surplus flag runs out and can re-raise it in one call',
        category: 'Shifts & dispatch',
        severity: 'medium',
        persona: 'rota manager at a supplier',
        month: monthOf(clock.now),
        status: 'fixed',
        evidence: `${org.name} had spare staff and no active flag; its inbox held ${expired.length} FLAG_EXPIRED notice(s), the latest "${latest.title}" on ${String(latest.createdAt).slice(0, 10)} (sent by email at once as an immediate type), so the lapse was not silent. Re-raising is one POST /capacity/flags naming the staff freed, which also records their internal hours for the fortnight.`,
        impact: 'Priority no longer depends on a manager remembering the fortnight; it depends on them answering a reminder.',
        proposal: 'Keep: expiry and fulfilment notices; recurring flags and a nudge when idle staff are repeatedly eligible would round it off.',
      });
    } else {
      gaps.record({
        id: 'DSP-03',
        title: 'Flags must be re-raised by hand every fortnight; nothing nudges a supplier whose flag lapsed',
        category: 'Shifts & dispatch',
        severity: 'medium',
        persona: 'rota manager at a supplier',
        month: monthOf(clock.now),
        evidence: `${org.name} still had spare staff but no active flag after ${lapsed} of its flags expired, so it had dropped to network timing without noticing (GET /notifications → ${inbox.status}, no FLAG_EXPIRED notice among ${((inbox.body?.notifications as any[]) ?? []).length}).`,
        impact: 'The priority mechanism depends on managers remembering to flag; in practice flags lapse and priority goes to whoever is most diligent, not most in need.',
        proposal: 'Expiry and fulfilment reminders, one-click re-raise, recurring flags (e.g. "every week until occupancy recovers"), and a suggestion to flag when the platform sees a supplier\'s workers repeatedly eligible but idle.',
      });
    }
  }
}

/** Compliance renewals: officers renew expiring documents with a lag; some slip through. */
export async function complianceRound(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, rng, clock, gaps, stats } = ctx;
  const list = await api.task('Review compliance list', 'compliance officer', () => api.get('/api/v1/workers', org.adminToken));
  api.countTask('Review compliance list');
  if (list.status !== 200) return;
  let blocked = 0;
  let renewed = 0;
  for (const w of listOf(list)) {
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
  if (blocked >= 5 && org.workers.length >= 40 && !ctx.world.deferred.cmp02) {
    ctx.world.deferred.cmp02 = { orgName: org.name, blocked, renewed, month: monthOf(clock.now) };
    recordWorkerExpiryGap(ctx, false); // settled now if it can be, otherwise at the end of the run
  }
}

/**
 * CMP-02: workers must hear about expiring documents themselves (their line in the daily digest) and be able to
 * upload the renewal. A missing alert early in the run is "not yet", not a failure, so the open verdict waits
 * until the end of the run (`final`).
 */
export function recordWorkerExpiryGap(ctx: SimContext, final: boolean): void {
  const { gaps, world } = ctx;
  const snap = world.deferred.cmp02;
  if (!snap || gaps.gaps.has('CMP-02')) return;
  const workerEmails = new Set(world.orgs.flatMap((o) => o.workers.map((w) => w.email)).filter((e): e is string => !!e));
  const workerAlerts = ctx.countEmails((m) => workerEmails.has(m.to) && /• Your .+ expires (today|in \d+ day)/.test(m.body));
  const selfUpload = world.features.workerSelfUpload === true;
  if (selfUpload && workerAlerts > 0) {
    gaps.record({
      id: 'CMP-02',
      title: 'Workers hear about expiring documents by email and can upload the renewal themselves',
      category: 'Compliance',
      severity: 'high',
      persona: 'compliance officer',
      month: snap.month,
      status: 'fixed',
      evidence: `${snap.orgName} had ${snap.blocked} active workers blocked by expired or missing documents at one point and the officer renewed ${snap.renewed} that round; ${workerAlerts} digest email(s) carrying a "Your … expires in N days" line reached workers' own addresses (one alert per document per week, the employer told too), and a worker's own login can add the renewed certificate for the employer to verify (checked by probe). SMS reminders wait on the provider decision (decision 15).`,
      impact: 'The officer stops being the only route for hundreds of certificates a year.',
      proposal: 'Keep: worker alerts and self-upload; a per-organisation expiries-by-month view (GET /compliance/expiring) exists for the dashboard.',
    });
  } else if (final || !selfUpload) {
    gaps.record({
      id: 'CMP-02',
      title: 'Expiry alerts only reach the employer, and only in-app; workers cannot renew themselves',
      category: 'Compliance',
      severity: 'high',
      persona: 'compliance officer',
      month: snap.month,
      evidence: `${snap.orgName} had ${snap.blocked} active workers blocked by expired or missing documents at one point; renewals are entered by the officer after the fact (${snap.renewed} that round)${selfUpload ? '' : ' because workers have no way to upload a renewed certificate'}; ${workerAlerts} expiry email(s) reached a worker's own address over the run.`,
      impact: 'Supply is lost exactly when it is needed; the officer becomes the bottleneck for hundreds of certificates a year.',
      proposal: 'Worker self-upload with manager verification, email/SMS reminders to the worker at 60/30/7 days, and a compliance dashboard per organisation with upcoming expiries by month.',
    });
  }
}

/** Monthly statements and payment behaviour. */
export async function monthEnd(ctx: SimContext, periodStart: Date, periodEnd: Date): Promise<void> {
  const { api, world, rng, clock, gaps } = ctx;
  let run = await api.task('Run monthly settlement', 'agency finance', () => api.post('/api/v1/finance/run', world.platformAdminToken, { periodStart: iso(periodStart), periodEnd: iso(periodEnd) }));
  let created: any[];
  if (run.status === 404) {
    world.features.settlement = false;
    run = await api.task('Generate monthly statements', 'agency finance', () => api.post('/api/v1/invoices/generate', world.platformAdminToken, { periodStart: iso(periodStart), periodEnd: iso(periodEnd) }));
    api.countTask('Generate monthly statements');
    created = listOf(run);
    for (const inv of created) {
      const host = world.org(inv.hostOrgId);
      pendingPayments.push({ invoiceId: inv.id, hostOrgId: inv.hostOrgId, dueAt: new Date(clock.now.getTime() + (host?.payLagDays ?? 30) * DAY), kind: 'pair' });
    }
  } else {
    world.features.settlement = true;
    api.countTask('Run monthly settlement');
    created = (run.body?.lines as any[]) ?? [];
    const hostInvoices = (run.body?.hostInvoices as any[]) ?? [];
    const remittances = (run.body?.remittances as any[]) ?? [];
    ctx.log(`${fmtDate(clock.now)} settlement for ${fmtDate(periodStart)}–${fmtDate(periodEnd)}: ${hostInvoices.length} host invoice(s) £${hostInvoices.reduce((s, i) => s + (i.total ?? 0), 0).toFixed(0)}, ${remittances.length} remittance(s) £${remittances.reduce((s, i) => s + (i.total ?? 0), 0).toFixed(0)}, agency sales £${created.filter((l) => l.agencySale).reduce((s, l) => s + (l.subtotal ?? 0), 0).toFixed(0)}`);
    for (const inv of hostInvoices) {
      const host = world.org(inv.hostOrgId);
      pendingPayments.push({ invoiceId: inv.id, hostOrgId: inv.hostOrgId, dueAt: new Date(clock.now.getTime() + (host?.payLagDays ?? 30) * DAY), kind: 'host' });
    }
    runTotals.hostInvoices += hostInvoices.length;
    runTotals.hostInvoiceValue += hostInvoices.reduce((s, i) => s + (i.total ?? 0), 0);
    runTotals.remittances += remittances.length;
    runTotals.remittanceValue += remittances.reduce((s, i) => s + (i.total ?? 0), 0);
    // Who is on credit hold this morning: the agency's finance team reads it off the directory.
    const directory = await api.task('Review credit holds', 'agency finance', () => api.get('/api/v1/organisations', world.platformAdminToken));
    const onHold = listOf(directory).filter((o) => o.creditHold === true).map((o) => o.name);
    gaps.record({
      id: 'FIN-01',
      title: 'Settlement: hosts are invoiced by the platform, suppliers get remittances, payments and reminders are tracked',
      category: 'Finance',
      severity: 'high',
      persona: 'agency finance',
      month: monthOf(clock.now),
      status: 'fixed',
      evidence: `Monthly runs so far issued ${runTotals.hostInvoices} host invoice(s) (MH-) worth £${Math.round(runTotals.hostInvoiceValue).toLocaleString()} and ${runTotals.remittances} remittance(s) (MR-) worth £${Math.round(runTotals.remittanceValue).toLocaleString()}; the platform's finance team recorded ${runTotals.hostPaymentsRecorded} host payment(s) with a bank reference (POST /finance/host-invoices/:id/mark-paid). The daily finance job marked ${runTotals.markedOverdue} invoice(s) overdue, sent ${runTotals.financeReminders} reminder(s) and applied ${runTotals.creditHoldsApplied} credit hold(s); ${onHold.length ? `${onHold.join(', ')} ${onHold.length === 1 ? 'is' : 'are'} on hold today` : 'nobody is on hold today'}. Credits net off the next invoice and remittance (decision 5); Direct Debit or card collection and an accounts-package export remain outside the platform.`,
      impact: 'The agency sees its float, who owes what and who is late without re-keying into its accounts package.',
      proposal: 'Keep: hosts pay the platform, the platform pays suppliers (decision 1); CSV exports exist for the accounts package.',
    });
  }
  if (!world.features.settlement) ctx.log(`${fmtDate(clock.now)} statements for ${fmtDate(periodStart)}–${fmtDate(periodEnd)}: ${created.length} issued, £${created.reduce((s, i) => s + i.subtotal, 0).toFixed(0)} billed, £${created.reduce((s, i) => s + i.platformFee, 0).toFixed(0)} platform fee`);
  if (created.length > 0 && !world.features.settlement) {
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

export const pendingPayments: Array<{ invoiceId: string; hostOrgId: string; dueAt: Date; kind: 'pair' | 'host' }> = [];

export async function settlePayments(ctx: SimContext): Promise<void> {
  const { api, world, clock } = ctx;
  for (let i = pendingPayments.length - 1; i >= 0; i--) {
    const p = pendingPayments[i]!;
    if (p.dueAt > clock.now) continue;
    const host = world.org(p.hostOrgId);
    if (!host || host.status === 'LEFT' || host.payLagDays >= 90) continue; // the chronic late payer never pays
    if (p.kind === 'host') {
      // Decision 1: the host pays the platform; the platform's finance team records the receipt.
      const paid = await api.task('Record a host payment', 'agency finance', () => api.post(`/api/v1/finance/host-invoices/${p.invoiceId}/mark-paid`, world.platformAdminToken, { reference: `BACS-${p.invoiceId.slice(-6)}` }));
      api.countTask('Record a host payment');
      if (paid.status === 200) runTotals.hostPaymentsRecorded++;
    } else {
      await api.task('Mark a statement paid', 'host finance', () => api.post(`/api/v1/invoices/${p.invoiceId}/mark-paid`, host.adminToken));
      api.countTask('Mark a statement paid');
    }
    pendingPayments.splice(i, 1);
  }
}

export async function refreshFloorRate(ctx: SimContext): Promise<void> {
  const res = await ctx.api.get('/api/v1/shifts/floor-rate', ctx.world.platformAdminToken);
  ctx.world.floorRate = res.status === 200 ? Number(res.body.floor) || 0 : 0;
  ctx.world.features.floorRate = res.status === 200;
}

/**
 * Decision ONB-01: large employers onboard by spreadsheet. Builds the import file the HR manager would
 * export from their HR system, previews it, applies it with email invitations, and has the invited
 * workers click their links. Returns false when the import endpoint does not exist.
 */
export async function importWorkers(ctx: SimContext, org: SimOrg, count: number, opts: { loginShare: number; nurses?: boolean }): Promise<boolean> {
  const { api, rng, clock, world } = ctx;
  const template = await api.task('Download the import template', 'HR manager', () => api.get('/api/v1/onboarding/import/template.csv', org.adminToken));
  if (template.status === 404) {
    world.features.import = false;
    return false;
  }
  world.features.import = true;
  api.countTask('Download the import template');
  const rows: Record<string, string>[] = [];
  const generated: Array<{ email: string; invite: boolean; firstName: string; lastName: string }> = [];
  const siteNames = org.sites.map((s) => s.name);
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
    const email = `${name.firstName}.${name.lastName}.${i}@${org.name.toLowerCase().replace(/[^a-z]+/g, '-')}.example`.toLowerCase();
    const invite = rng.chance(opts.loginShare);
    const row: Record<string, string> = {
      firstName: name.firstName,
      lastName: name.lastName,
      email,
      phone: `07${rng.int(100000000, 999999999)}`,
      jobRole,
      skills: [...skills].join(';'),
      contractedHoursPerWeek: String(rng.pick([0, 16, 24, 30, 36, 37.5, 40])),
      maxHoursPerWeek: '48',
      postcode: pc.postcode,
      travelRadiusKm: String(rng.pick([10, 15, 20, 25, 35])),
      homeSite: rng.pick(siteNames) ?? '',
      shareable: rng.chance(0.78) ? 'yes' : 'no',
      verified: rng.chance(0.988) ? 'yes' : 'no', // the same share the one-at-a-time path verifies
      invite: invite ? 'yes' : 'no',
    };
    for (const type of requiredDocumentsForRole(jobRole)) {
      const soon = rng.chance(type === 'DBS' ? 0.08 : 0.14);
      row[`${type}_reference`] = `${type.slice(0, 3)}-${rng.int(100000, 999999)}`;
      row[`${type}_expiresAt`] = iso(new Date(clock.now.getTime() + (soon ? rng.int(20, 170) : rng.int(200, 1000)) * DAY)).slice(0, 10);
    }
    rows.push(row);
    generated.push({ email, invite, firstName: name.firstName, lastName: name.lastName });
  }
  const headers = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => `"${(r[h] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
  const upload = { fileName: 'staff.csv', contentBase64: Buffer.from(csv).toString('base64') };
  const preview = await api.task('Preview a worker import', 'HR manager', () => api.post('/api/v1/onboarding/import/preview', org.adminToken, upload));
  api.countTask('Preview a worker import');
  if (preview.status !== 200 && preview.status !== 201) {
    ctx.log(`import preview failed for ${org.name}: ${preview.status} ${JSON.stringify(preview.body).slice(0, 200)}`);
    return false;
  }
  const apply = await api.task('Apply a worker import', 'HR manager', () => api.post(`/api/v1/onboarding/import/${preview.body.jobId}/apply`, org.adminToken, { ...upload, invite: true }));
  api.countTask('Apply a worker import');
  if (apply.status !== 200 && apply.status !== 201) {
    ctx.log(`import apply failed for ${org.name}: ${apply.status} ${JSON.stringify(apply.body).slice(0, 200)}`);
    return false;
  }
  // Rows the spreadsheet did not attest as checked land in the verification queue; the compliance officer clears it in bulk.
  const queue = await api.task('Review verification queue', 'compliance officer', () => api.get('/api/v1/compliance/verification-queue', org.adminToken));
  if (queue.status === 200) {
    api.countTask('Review verification queue');
    const ids = listOf(queue).map((d) => d.document?.id ?? d.id).filter(Boolean);
    for (let i = 0; i < ids.length; i += 200) {
      await api.task('Verify documents in bulk', 'compliance officer', () => api.post('/api/v1/compliance/verify', org.adminToken, { documentIds: ids.slice(i, i + 200) }));
      api.countTask('Verify documents in bulk');
    }
  }
  // Load what was created so the rest of the simulation can use it.
  const list = await api.get('/api/v1/workers', org.adminToken);
  for (const w of listOf(list)) {
    const group = GROUP_OF_ROLE[w.jobRole as JobRole];
    org.workers.push({ id: w.id, orgId: org.id, name: `${w.firstName} ${w.lastName}`, jobRole: w.jobRole, group, skills: w.skills ?? [], shareable: !!w.shareable, token: null, email: w.email ?? null, contractedHours: w.contractedHoursPerWeek ?? 0, active: w.status === 'ACTIVE' });
  }
  // Invited workers open their email and set a password (decision ONB-02).
  let accepted = 0;
  for (const g of generated) {
    if (!g.invite) continue;
    const mail = ctx.mailbox(g.email);
    const token = mail?.match(/\/invite\/([A-Za-z0-9_-]+)/)?.[1];
    if (!token) continue;
    const res = await api.task('Worker accepts an invitation', 'care worker (phone)', () => api.post(`/api/v1/onboarding/invitations/${token}/accept`, null, { password: `Welcome-${rng.int(100000, 999999)}-ok` }));
    api.countTask('Worker accepts an invitation');
    if (res.status === 200 || res.status === 201) {
      const w = org.workers.find((x) => x.email === g.email);
      if (w) {
        w.token = res.body.token ?? null;
        accepted++;
      }
    }
  }
  world.features.invitations = accepted > 0;
  runTotals.invited += apply.body?.invited ?? generated.filter((g) => g.invite).length;
  runTotals.accepted += accepted;
  ctx.log(`${fmtDate(clock.now)} ${org.name}: imported ${org.workers.length} workers from a spreadsheet; ${generated.filter((g) => g.invite).length} invited by email, ${accepted} accepted`);
  return true;
}

export function monthOf(d: Date): number {
  return Math.floor((d.getTime() - SIM_START.getTime()) / (30 * DAY));
}
