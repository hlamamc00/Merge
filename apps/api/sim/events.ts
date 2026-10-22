/**
 * Scripted events and probes: things that happen to a real network over six months, each one
 * attempted the way a person would attempt it today, with the outcome recorded as evidence.
 */
import { requiredDocumentsForRole } from '@merge/shared';
import { DAY, HOUR, iso, fmtDate } from './lib.js';
import { monthOf, type SimContext, type SimOrg, type SimWorker } from './scenario.js';

export async function probeMissingEndpoints(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, gaps, clock } = ctx;
  const importRes = await api.task('Try to bulk-import workers', 'HR manager', () => api.post('/api/v1/workers/import', org.adminToken, { rows: [] }));
  const resetRes = await api.task('Try to reset a password', 'care worker', () => api.post('/api/v1/auth/forgot-password', null, { email: org.adminEmail }));
  const inviteRes = await api.task('Try to invite a user by email', 'org admin', () => api.post(`/api/v1/organisations/${org.id}/invitations`, org.adminToken, { email: 'new.manager@example.com', role: 'ORG_MANAGER' }));
  gaps.record({
    id: 'ONB-04',
    title: 'No password reset or email invitations',
    category: 'Onboarding',
    severity: 'high',
    persona: 'org admin / care worker',
    month: monthOf(clock.now),
    evidence: `POST /workers/import → ${importRes.status}; POST /auth/forgot-password → ${resetRes.status}; POST /organisations/:id/invitations → ${inviteRes.status}. All three are routes a user would expect and none exist.`,
    impact: 'Every lock-out becomes a support call to the agency; every new manager is created by hand with a shared password.',
    proposal: 'Invitation tokens and password-reset tokens delivered by email, with expiry and single use.',
  });
}

export async function probeWorkerSelfUpload(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, gaps, clock } = ctx;
  const w = org.workers.find((x) => x.token);
  if (!w) return;
  const res = await api.task('Worker uploads own certificate', 'care worker (phone)', () => api.post(`/api/v1/workers/${w.id}/documents`, w.token, { type: 'MOVING_AND_HANDLING_TRAINING', reference: 'MH-2027', expiresAt: iso(clock.plusDays(365)) }));
  gaps.record({
    id: 'CMP-03',
    title: 'Workers cannot upload their own documents or see their compliance status clearly',
    category: 'Compliance',
    severity: 'high',
    persona: 'care worker (phone)',
    month: monthOf(clock.now),
    evidence: `${w.name} tried to add a renewed training certificate from their own login: HTTP ${res.status} (${res.body?.error}). Documents are metadata only; there is no file upload at all.`,
    impact: 'Every certificate goes through the manager, twice (receive it, type it in). Files live in email and shared drives, outside the audit trail.',
    proposal: 'Worker self-upload (photo/PDF) to object storage, OCR of the expiry date, manager verification queue, and a worker-facing compliance checklist.',
    decisionNeeded: 'Where should document files be stored (e.g. S3-compatible bucket in the UK region) and how long should they be retained after a worker leaves?',
  });
}

/** A worker moves employer. Today the only way is deactivate + recreate + re-enter every document. */
export async function probeWorkerTransfer(ctx: SimContext, from: SimOrg, to: SimOrg): Promise<void> {
  const { api, gaps, clock, rng } = ctx;
  const w = from.workers.find((x) => x.active && x.shareable);
  if (!w) return;
  const before = await api.get(`/api/v1/workers/${w.id}`, from.adminToken);
  const upcoming = (before.body?.upcoming as any[]) ?? [];
  await api.task('Deactivate a leaver', 'HR manager', () => api.patch(`/api/v1/workers/${w.id}`, from.adminToken, { status: 'INACTIVE' }));
  api.countTask('Deactivate a leaver');
  w.active = false;
  const after = await api.get(`/api/v1/workers/${w.id}`, from.adminToken);
  const stillBooked = ((after.body?.upcoming as any[]) ?? []).filter((u) => u.assignment.status === 'CONFIRMED');
  // Re-create at the new employer, re-entering documents.
  const callsBefore = api.calls.length;
  const created = await api.task('Re-create a transferred worker', 'HR manager (new employer)', () => api.post('/api/v1/workers', to.adminToken, { firstName: w.name.split(' ')[0], lastName: w.name.split(' ')[1], jobRole: w.jobRole, skills: w.skills, shareable: true, contractedHoursPerWeek: w.contractedHours }));
  if (created.status === 201) {
    for (const type of requiredDocumentsForRole(w.jobRole)) {
      const doc = await api.post(`/api/v1/workers/${created.body.id}/documents`, to.adminToken, { type, reference: `${type.slice(0, 3)}-${rng.int(100000, 999999)}`, expiresAt: iso(clock.plusDays(400)) });
      await api.patch(`/api/v1/workers/${created.body.id}/documents/${doc.body.id}`, to.adminToken, { verified: true });
    }
    const nw: SimWorker = { ...w, id: created.body.id, orgId: to.id, active: true, token: null, email: null };
    to.workers.push(nw);
  }
  api.countTask('Re-create a transferred worker');
  gaps.record({
    id: 'WF-01',
    title: 'Worker records are not portable between employers',
    category: 'Workforce',
    severity: 'high',
    persona: 'HR manager',
    month: monthOf(clock.now),
    evidence: `${w.name} moved from ${from.name} to ${to.name}: the old record was deactivated and a new one typed in with ${api.calls.length - callsBefore} calls, re-entering ${requiredDocumentsForRole(w.jobRole).length} documents that had already been verified once. Ratings and history stayed with the old record.`,
    impact: 'Duplicate identities, lost history, and repeated compliance work; the sector has high churn so this happens constantly.',
    proposal: 'A worker identity that is independent of employer (a "passport"), with an employment history; transfer with the worker\'s consent carries verified documents and ratings across.',
    decisionNeeded: 'Should a worker\'s verified documents and ratings follow them to a new employer automatically (with their consent), or does each employer re-verify?',
  });
  if (stillBooked.length > 0 || upcoming.length > 0) {
    gaps.record({
      id: 'WF-02',
      title: 'Deactivating a worker leaves their future bookings in place',
      category: 'Workforce',
      severity: 'high',
      persona: 'HR manager',
      month: monthOf(clock.now),
      evidence: `${w.name} had ${upcoming.length} upcoming assignment(s) when deactivated; ${stillBooked.length} confirmed booking(s) stayed confirmed and the host was not told.`,
      impact: 'The host expects a worker who will not arrive; it surfaces as a no-show on the day.',
      proposal: 'On deactivation (or shareable=false), cancel future requests/offers, warn about confirmed bookings and require the manager to reassign or cancel them, notifying hosts.',
    });
  }
}

export async function probeBlocklist(ctx: SimContext, host: SimOrg): Promise<void> {
  const { api, gaps, clock, world } = ctx;
  const worst = world.providers().filter((o) => o.id !== host.id).sort((a, b) => b.noShowsCaused - a.noShowsCaused)[0];
  if (!worst || worst.noShowsCaused === 0) return;
  const confirmedWith = ((await api.get('/api/v1/assignments?scope=incoming&status=CONFIRMED', host.managerToken)).body as any[]).filter((a) => a.supplierOrgId === worst.id);
  const res = await api.task('Block a supplier', 'org admin', () => api.put(`/api/v1/organisations/${host.id}/relationships/${worst.id}`, host.adminToken, { kind: 'BLOCKED', note: `${worst.noShowsCaused} no-shows` }));
  api.countTask('Block a supplier');
  worst.blockedBy.push(host.id);
  if (res.status === 200) {
    gaps.record({
      id: 'TRS-01',
      title: 'No reliability record: no-shows and late cancellations have no consequence beyond one host\'s memory',
      category: 'Platform & admin',
      severity: 'high',
      persona: 'host admin',
      month: monthOf(clock.now),
      evidence: `${host.name} blocked ${worst.name} after ${worst.noShowsCaused} no-shows. Other hosts cannot see that history; the platform charges nothing for it; ${confirmedWith.length} already-confirmed bookings with the blocked supplier stay in place with no warning.`,
      impact: 'Unreliable suppliers keep winning priority access elsewhere; the agency cannot enforce its terms.',
      proposal: 'A reliability score per organisation and per worker (on-time clock-in, late cancellations, no-shows) visible to hosts and used as a dispatch weighting; configurable cancellation/no-show fees; and a prompt when blocking an organisation you still have bookings with.',
      decisionNeeded: 'What should the late-cancellation and no-show penalties be (a fee, a lower priority rank, a suspension after N incidents), and who sets them: the platform or each host?',
    });
  }
}

export async function probeInspectorRequest(ctx: SimContext, host: SimOrg): Promise<void> {
  const { api, gaps, clock } = ctx;
  const site = host.sites[0]!;
  const started = api.calls.length;
  const exportRes = await api.task('Inspector asks who worked at a site', 'registered manager', () => api.get(`/api/v1/organisations/${host.id}/sites/${site.id}/workforce-report?from=2026-11-01&to=2027-02-01`, host.adminToken));
  // The manual way: list all payable timesheets, filter client-side by site, then open each worker.
  const ts = await api.task('Inspector asks who worked at a site', 'registered manager', () => api.get('/api/v1/timesheets?scope=payable&status=APPROVED', host.adminToken));
  const atSite = ((ts.body as any[]) ?? []).slice(0, 25);
  for (const t of atSite) await api.task('Inspector asks who worked at a site', 'registered manager', () => api.get(`/api/v1/workers/${t.workerId}`, host.adminToken));
  gaps.record({
    id: 'REP-01',
    title: 'No regulator-ready record of who worked where with which checks',
    category: 'Reporting',
    severity: 'high',
    persona: 'registered manager (CQC inspection)',
    month: monthOf(clock.now),
    evidence: `Asked for everyone who worked at ${site.name} between November and January with their DBS and training status: the report endpoint does not exist (${exportRes.status}); assembling it by hand meant ${api.calls.length - started} calls, and each worker lookup was refused because the worker belongs to another organisation.`,
    impact: 'Hosts cannot evidence safe staffing from the platform; this is a blocker for many registered managers adopting it.',
    proposal: 'A per-site workforce report (date range → worker, employer, role, shifts, document status on each shift date) as CSV/PDF, with the host allowed to see the compliance snapshot of workers who worked for it.',
  });
}

export async function probeSuspension(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, gaps, clock, world } = ctx;
  const openBefore = ((await api.get('/api/v1/shifts?scope=posted', org.managerToken)).body as any[]).filter((s) => s.status === 'OPEN');
  const outgoing = ((await api.get('/api/v1/assignments?scope=outgoing&status=CONFIRMED', org.managerToken)).body as any[]) ?? [];
  const res = await api.task('Suspend an organisation for non-payment', 'agency finance', () => api.patch(`/api/v1/organisations/${org.id}`, world.platformAdminToken, { status: 'SUSPENDED' }));
  api.countTask('Suspend an organisation for non-payment');
  org.status = 'SUSPENDED';
  // Can the network still see and request their shifts?
  const other = world.providers().find((o) => o.id !== org.id)!;
  const board = await api.get('/api/v1/shifts?scope=available', other.managerToken);
  const stillVisible = ((board.body as any[]) ?? []).filter((s) => openBefore.some((o) => o.id === s.id));
  const login = await api.get('/api/v1/auth/me', org.managerToken);
  gaps.record({
    id: 'PLT-01',
    title: 'Suspending an organisation does not withdraw its open shifts or settle its bookings',
    category: 'Platform & admin',
    severity: 'high',
    persona: 'agency finance',
    month: monthOf(clock.now),
    evidence: `${org.name} suspended (${res.status}); its users are locked out (${login.status}) but ${stillVisible.length} of its ${openBefore.length} open shifts stayed visible to ${other.name}, and ${outgoing.length} confirmed booking(s) of its workers at other hosts stayed live with nobody able to manage them.`,
    impact: 'Suppliers keep committing staff to a host that cannot pay; hosts keep relying on workers whose employer is locked out.',
    proposal: 'Suspension should pause posting, hide open shifts, notify counterparties about confirmed bookings and offer a grace window; a separate "credit hold" state for late payment that blocks new postings but keeps existing bookings.',
    decisionNeeded: 'When a host is suspended for non-payment, should its already-confirmed future bookings be cancelled automatically, or honoured and invoiced in arrears?',
  });
}

export async function probeDataSubjectRequest(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, gaps, clock } = ctx;
  const w = org.workers.find((x) => x.token && x.active);
  if (!w) return;
  const me = await api.task('Worker asks for their data (GDPR)', 'care worker', () => api.get(`/api/v1/workers/${w.id}`, w.token));
  const exportRes = await api.task('Worker asks for their data (GDPR)', 'care worker', () => api.get(`/api/v1/workers/${w.id}/export`, w.token));
  const del = await api.task('Worker asks to be forgotten', 'care worker', () => api.del(`/api/v1/workers/${w.id}`, w.token));
  gaps.record({
    id: 'SEC-01',
    title: 'No data-subject tooling: export, erasure, consent to share, or retention rules',
    category: 'Security & data',
    severity: 'high',
    persona: 'care worker / DPO',
    month: monthOf(clock.now),
    evidence: `${w.name} can read their profile (${me.status}) but there is no export (${exportRes.status}) and no erasure (${del.status}). Nothing records that the worker consented to their profile, documents and ratings being shown to other organisations, and nothing deletes data after a worker leaves.`,
    impact: 'The platform processes special-category data (DBS, health-related training) across organisations without the paperwork a data-protection officer will demand.',
    proposal: 'Consent capture at worker activation, a data export, an erasure/anonymisation job that keeps financial records, per-organisation retention settings, and a record of data-sharing agreements between organisations.',
    decisionNeeded: 'Is the platform operator a data controller or a processor for worker data, and what retention period should apply after a worker or organisation leaves? (Needs a legal view.)',
  });
}

export async function probeOffboarding(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, gaps, clock, world } = ctx;
  const close = await api.task('Organisation leaves the network', 'org admin', () => api.post(`/api/v1/organisations/${org.id}/close`, org.adminToken, { reason: 'Moving to another platform' }));
  const selfStatus = await api.task('Organisation leaves the network', 'org admin', () => api.patch(`/api/v1/organisations/${org.id}`, org.adminToken, { status: 'SUSPENDED' }));
  const outstanding = ((await api.get('/api/v1/invoices?scope=payable', org.adminToken)).body as any[]).filter((i) => i.status === 'ISSUED');
  await api.patch(`/api/v1/organisations/${org.id}`, world.platformAdminToken, { status: 'SUSPENDED' });
  org.status = 'LEFT';
  gaps.record({
    id: 'PLT-02',
    title: 'No self-service offboarding; leaving means asking the agency to suspend you',
    category: 'Platform & admin',
    severity: 'medium',
    persona: 'org admin',
    month: monthOf(clock.now),
    evidence: `${org.name} tried to leave: POST /organisations/:id/close → ${close.status}; setting its own status → ${selfStatus.status}. The agency had to suspend it, with ${outstanding.length} statement(s) still unpaid and no final reconciliation, data export or retention step.`,
    impact: 'Messy exits, disputes over final statements, and data kept indefinitely.',
    proposal: 'A "leave the network" flow: stop new activity, run out existing bookings, final statement, data export, then archive after the retention period.',
  });
}

export async function probeReporting(ctx: SimContext, host: SimOrg): Promise<void> {
  const { api, gaps, clock, world } = ctx;
  const stats = await api.task('Monthly spend report by site', 'finance clerk', () => api.get(`/api/v1/organisations/${host.id}/stats`, host.adminToken));
  const csv = await api.task('Monthly spend report by site', 'finance clerk', () => api.get('/api/v1/timesheets?scope=payable&status=APPROVED&format=csv', host.adminToken));
  const overview = await api.task('Agency margin by client', 'agency owner', () => api.get('/api/v1/admin/overview', world.platformAdminToken));
  gaps.record({
    id: 'REP-02',
    title: 'Reporting stops at a 30-day headline; no date ranges, no breakdown by site, role or counterparty, no CSV',
    category: 'Reporting',
    severity: 'high',
    persona: 'finance clerk / agency owner',
    month: monthOf(clock.now),
    evidence: `Host stats return ${Object.keys(stats.body ?? {}).length} fixed figures for the last 30 days only; format=csv is ignored (${csv.status}, JSON). The agency overview (${overview.status}) has network totals and fee for 30 days, with no per-client margin, no monthly series and no export.`,
    impact: 'Finance teams rebuild the numbers in spreadsheets from statement PDFs; the agency cannot see which clients make money.',
    proposal: 'Report endpoints with date ranges and group-by (site, role, supplier/host, month), CSV export everywhere a table is shown, and a margin report for the agency.',
  });
}

export async function probePagination(ctx: SimContext): Promise<void> {
  const { api, gaps, clock, world } = ctx;
  const started = performance.now();
  const all = await api.task('Platform admin lists all shifts', 'agency ops', () => api.get('/api/v1/shifts?scope=all', world.platformAdminToken));
  const ms = Math.round(performance.now() - started);
  const rows = ((all.body as any[]) ?? []).length;
  const large = world.providers().find((o) => o.size === 'large');
  let posted = 0;
  let postedMs = 0;
  if (large) {
    const t = performance.now();
    const res = await api.task('Rota manager lists posted shifts', 'rota manager', () => api.get('/api/v1/shifts?scope=posted&includePast=true', large.managerToken));
    postedMs = Math.round(performance.now() - t);
    posted = ((res.body as any[]) ?? []).length;
  }
  if (rows > 1000 || ms > 500 || postedMs > 500) {
    gaps.record({
      id: 'SCL-01',
      title: 'List endpoints return everything: no pagination, no date windows by default',
      category: 'Scale & performance',
      severity: 'medium',
      persona: 'agency ops / rota manager',
      month: monthOf(clock.now),
      evidence: `GET /shifts?scope=all returned ${rows} rows in ${ms} ms; a large host's posted list with history returned ${posted} rows in ${postedMs} ms. Notifications, audit log, timesheets and assignments behave the same way.`,
      impact: 'Pages get slower every month; on a real database over a network these become multi-second loads and large payloads on phones.',
      proposal: 'Cursor pagination with sensible default windows (e.g. this week), server-side filters, and summary endpoints for dashboards.',
    });
  }
}

export async function probeDaylightSaving(ctx: SimContext): Promise<void> {
  const { gaps, world, clock } = ctx;
  const change = new Date('2027-03-28T01:00:00Z'); // BST starts
  const straddling = [...world.shifts.values()].filter((s) => s.startsAt < change && s.endsAt > change);
  if (straddling.length === 0) return;
  gaps.record({
    id: 'DSP-06',
    title: 'Shift times are instants, not local wall-clock times; the clock change silently changes shift lengths',
    category: 'Shifts & dispatch',
    severity: 'medium',
    persona: 'rota manager',
    month: monthOf(clock.now),
    evidence: `${straddling.length} shift(s) straddled the switch to BST on 28 March 2027. A "19:00–07:00" night entered before the change is stored as instants, so after the change the UI shows it as 20:00–08:00 and pays 12 hours, while a real night across the change is 11 hours.`,
    impact: 'Wrong paid hours twice a year, and confusion between what the rota says and what the platform shows.',
    proposal: 'Store shift times as local date-time plus the site time zone, compute instants on the fly, and show paid hours derived from the real elapsed time.',
  });
}

export async function probeNotificationVolume(ctx: SimContext, perOrgDay: Map<string, number>, byType: Map<string, number>, world = ctx.world): Promise<void> {
  const { gaps, clock } = ctx;
  let worst: { key: string; n: number } = { key: '', n: 0 };
  for (const [key, n] of perOrgDay) if (n > worst.n) worst = { key, n };
  const [orgId, day] = worst.key.split('|');
  const org = orgId ? world.org(orgId) : undefined;
  const total = [...byType.values()].reduce((s, n) => s + n, 0);
  const top = [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t} ${n}`).join(', ');
  gaps.record({
    id: 'COM-01',
    title: 'Notifications are in-app only, unbatched and unprioritised',
    category: 'Communication',
    severity: 'blocker',
    persona: 'everyone',
    month: monthOf(clock.now),
    evidence: `${total.toLocaleString()} notifications were generated over the run (${top}). ${org?.name ?? 'One organisation'} received ${worst.n} on ${day}. None left the app: no email, SMS or push exists, so an urgent shift released at 20:00 is only seen when someone next logs in.`,
    impact: 'Urgent cover fails; important events (a late cancellation, a dispute) drown in release notices; people stop reading the bell.',
    proposal: 'Email/SMS/push channels with per-user preferences and quiet hours; digests for low-priority events (new shifts, statements) and immediate delivery for high-priority ones (urgent shift, cancellation, no-show, dispute); per-role routing so finance gets finance events.',
    decisionNeeded: 'Which SMS provider and sender ID, and who pays for SMS (platform fee, or passed through to the organisation that opted in)?',
  });
}

export function describeWeek(ctx: SimContext, week: number): string {
  const s = ctx.stats.current;
  return `${fmtDate(new Date(ctx.clock.now.getTime() - 7 * DAY))} wk${week}: providers ${s.providers}, workers ${s.workers}, posted ${s.shiftsPosted} (${s.urgentPosted} urgent), confirmed ${s.confirmations} [P${s.confirmedViaPriority}/A${s.confirmedViaAgency}/N${s.confirmedViaNetwork}], expired unfilled ${s.shiftsExpiredUnfilled}, late cancels ${s.lateCancellations}, no-shows ${s.noShows}, approved ${s.timesheetsApproved}, £${Math.round(s.chargeTraded)} traded`;
}

export { HOUR };
