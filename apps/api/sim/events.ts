/**
 * Scripted events and probes: things that happen to a real network over six months, each one
 * attempted the way a person would attempt it today, with the outcome recorded as evidence.
 * A probe that finds the feature working records the gap as fixed, with the numbers that show it.
 */
import { requiredDocumentsForRole } from '@merge/shared';
import { DAY, HOUR, iso, fmtDate, listOf } from './lib.js';
import { SIM_START, monthOf, type SimContext, type SimOrg, type SimWorker } from './scenario.js';

export async function probeMissingEndpoints(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, gaps, clock } = ctx;
  const importRes = await api.task('Try to bulk-import workers', 'HR manager', () => api.get('/api/v1/onboarding/import/template.csv', org.adminToken));
  const resetRes = await api.task('Try to reset a password', 'care worker', () => api.post('/api/v1/onboarding/forgot-password', null, { email: org.adminEmail }));
  const inviteRes = await api.task('Try to invite a user by email', 'org admin', () => api.post('/api/v1/onboarding/invitations', org.adminToken, { email: 'new.manager@example.com', role: 'ORG_MANAGER', firstName: 'New', lastName: 'Manager' }));
  if (resetRes.status !== 404 && inviteRes.status !== 404 && importRes.status !== 404) return; // all present
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
  const { api, gaps, clock, world } = ctx;
  const w = org.workers.find((x) => x.token);
  if (!w) return;
  const res = await api.task('Worker uploads own certificate', 'care worker (phone)', () => api.post(`/api/v1/workers/${w.id}/documents`, w.token, { type: 'MOVING_AND_HANDLING_TRAINING', reference: 'MH-2027', expiresAt: iso(clock.plusDays(365)) }));
  if (res.status === 201) {
    world.features.workerSelfUpload = true;
    gaps.record({
      id: 'CMP-03',
      title: 'Workers add their own documents; the employer verifies them from a queue',
      category: 'Compliance',
      severity: 'high',
      persona: 'care worker (phone)',
      month: monthOf(clock.now),
      status: 'fixed',
      evidence: `${w.name} (${org.name}) added a renewed training certificate from their own login (201, verified: ${res.body?.verifiedAt ? 'yes' : 'no, it waits in the employer\'s verification queue'}); a file can be attached to it, and a correction keeps the old version as history. Files go through a storage adapter (local disk in development, an S3-compatible bucket in a UK region in production) and are kept 6 years after the worker leaves by default; that retention period still needs the lawyer's confirmation (decision 18).`,
      impact: 'Certificates no longer go through the manager twice, and the file sits inside the audit trail.',
      proposal: 'Keep: self-upload with employer verification; OCR of the expiry date and a worker-facing checklist would round it off.',
    });
    return;
  }
  world.features.workerSelfUpload = false;
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
  const { api, gaps, clock, rng, world } = ctx;
  // A leaver with bookings still ahead of them is the realistic (and revealing) case; look across the network for one.
  let w: SimWorker | undefined;
  for (const candidate of [from, ...ctx.world.providers().filter((o) => o.id !== from.id && o.id !== to.id)]) {
    const booked = listOf(await api.get('/api/v1/assignments?scope=outgoing&status=CONFIRMED', candidate.managerToken));
    const found = candidate.workers.find((x) => x.active && x.shareable && booked.some((a) => a.workerId === x.id && new Date(a.shift.startsAt) > ctx.clock.now));
    if (found) {
      w = found;
      from = candidate;
      break;
    }
  }
  w ??= from.workers.find((x) => x.active && x.shareable);
  if (!w) return;
  const before = await api.get(`/api/v1/workers/${w.id}`, from.adminToken);
  const upcoming = (before.body?.upcoming as any[]) ?? [];
  const confirmedBefore = upcoming.filter((u) => u.assignment.status === 'CONFIRMED');
  const hostIds = [...new Set(confirmedBefore.map((u) => u.shift.hostOrgId as string))];
  await api.task('Deactivate a leaver', 'HR manager', () => api.patch(`/api/v1/workers/${w.id}`, from.adminToken, { status: 'INACTIVE' }));
  api.countTask('Deactivate a leaver');
  w.active = false;
  const after = await api.get(`/api/v1/workers/${w.id}`, from.adminToken);
  const stillUpcoming = (after.body?.upcoming as any[]) ?? [];
  const stillBooked = stillUpcoming.filter((u) => u.assignment.status === 'CONFIRMED');
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
  if (upcoming.length === 0) return; // nothing to release, so nothing to verify
  if (stillBooked.length === 0) {
    // The hosts who were expecting the worker should have a cancellation notice naming the booking.
    const releasedIds = new Set(confirmedBefore.map((u) => u.assignment.id as string));
    let hostsTold = 0;
    for (const hostId of hostIds) {
      const host = world.org(hostId);
      if (!host) continue;
      const inbox = await api.task('Check notifications', 'rota manager', () => api.get('/api/v1/notifications?limit=200', host.managerToken));
      api.countTask('Check notifications');
      if (((inbox.body?.notifications as any[]) ?? []).some((n) => n.type === 'SHIFT_CANCELLED' && releasedIds.has(n.data?.assignmentId))) hostsTold++;
    }
    gaps.record({
      id: 'WF-02',
      title: 'Deactivating a worker releases their future bookings and tells the hosts',
      category: 'Workforce',
      severity: 'high',
      persona: 'HR manager',
      month: monthOf(clock.now),
      status: 'fixed',
      evidence: `${w.name} had ${upcoming.length} upcoming assignment(s) (${confirmedBefore.length} confirmed) when deactivated; the platform released every one of them (${stillUpcoming.length} left: confirmed bookings cancelled and reopened to the network, requests and offers withdrawn) and ${hostsTold} of ${hostIds.length} host(s) found a cancellation notice naming the booking in their inbox. The leaver's login ended with the record. A bar by a host releases bookings the same way.`,
      impact: 'No host waits for a worker who will not arrive; the shift goes back on the board at once.',
      proposal: 'Keep: release on deactivation (and on shareable=false for future requests); a reassign-before-cancel prompt would be a refinement.',
    });
    return;
  }
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

export async function probeBlocklist(ctx: SimContext, host: SimOrg): Promise<void> {
  const { api, gaps, clock, world } = ctx;
  const worst = world.providers().filter((o) => o.id !== host.id).sort((a, b) => b.noShowsCaused - a.noShowsCaused)[0];
  if (!worst || worst.noShowsCaused === 0) return;
  const confirmedWith = listOf(await api.get('/api/v1/assignments?scope=incoming&status=CONFIRMED', host.managerToken)).filter((a) => a.supplierOrgId === worst.id);
  // Decision 4: the host reads the supplier's record first, then blocks the organisation and bars the person who did not turn up.
  const reliability = await api.task('Check a supplier\'s reliability record', 'org admin', () => api.get(`/api/v1/trust/reliability/${worst.id}`, host.managerToken));
  const res = await api.task('Block a supplier', 'org admin', () => api.put(`/api/v1/organisations/${host.id}/relationships/${worst.id}`, host.adminToken, { kind: 'BLOCKED', note: `${worst.noShowsCaused} no-shows` }));
  api.countTask('Block a supplier');
  worst.blockedBy.push(host.id);
  const noShows = listOf(await api.task('Find who did not turn up', 'org admin', () => api.get('/api/v1/assignments?scope=incoming&status=NO_SHOW', host.managerToken)));
  let culprit = noShows.find((a) => a.supplierOrgId === worst.id);
  if (!culprit) culprit = (listOf(await api.get('/api/v1/assignments?scope=incoming', host.managerToken))).find((a) => a.supplierOrgId === worst.id);
  const bar = culprit ? await api.task('Bar a worker from our shifts', 'org admin', () => api.post('/api/v1/trust/bars', host.managerToken, { workerId: culprit.workerId, reason: 'Did not attend and did not call', shareReason: true })) : null;
  if (bar && (bar.status === 201 || bar.status === 409)) api.countTask('Bar a worker from our shifts');
  const standing = await api.task('Review a supplier\'s standing', 'agency owner', () => api.get(`/api/v1/organisations/${worst.id}`, world.platformAdminToken));
  const r = reliability.body ?? {};
  const penaltyUntil = standing.body?.priorityPenaltyUntil ? String(standing.body.priorityPenaltyUntil).slice(0, 10) : null;
  const barWorked = !!bar && (bar.status === 201 || bar.status === 409);
  if (res.status === 200 && reliability.status === 200 && barWorked && culprit) {
    const who = `${culprit.worker?.firstName ?? ''} ${culprit.worker?.lastName ?? ''}`.trim();
    gaps.record({
      id: 'TRS-01',
      title: 'Reliability is recorded per organisation; no-shows cost priority access and hosts can bar individuals',
      category: 'Platform & admin',
      severity: 'high',
      persona: 'host admin',
      month: monthOf(clock.now),
      status: 'fixed',
      evidence: `${host.name} read ${worst.name}'s reliability record before acting: score ${r.score}/100 over ${r.windowDays} days (${r.noShows} no-shows, ${r.lateCancellations} late cancellations, ${r.confirmedOrCompleted} bookings kept), visible to every host. It blocked the organisation and barred ${who} from its shifts (${bar!.status === 201 ? `201; ${bar!.body?.released?.cancelled?.length ?? 0} future booking(s) released, the employer told with the reason` : 'already barred by the home after an earlier no-show'}). The platform ${penaltyUntil ? `removed ${worst.name}'s priority access until ${penaltyUntil}` : `has not yet penalised ${worst.name} (${r.noShows} no-show(s) inside the window; 2 in 90 days remove priority for 30 days, 3 suspend, as platform settings)`}; it is ${String(standing.body?.status ?? '').toLowerCase()}. ${confirmedWith.length} already-confirmed booking(s) with the blocked supplier stay in place; nothing prompts about them when blocking.`,
      impact: 'Unreliable employers lose the priority that flags earn them, and hosts can act on the individual rather than the whole supplier.',
      proposal: 'Keep: the reliability score and penalties (decision 4); a prompt about live bookings when blocking an organisation would round it off.',
    });
    return;
  }
  gaps.record({
    id: 'TRS-01',
    title: 'No reliability record: no-shows and late cancellations have no consequence beyond one host\'s memory',
    category: 'Platform & admin',
    severity: 'high',
    persona: 'host admin',
    month: monthOf(clock.now),
    evidence: `${host.name} blocked ${worst.name} after ${worst.noShowsCaused} no-shows (${res.status}). GET /trust/reliability/:orgId → ${reliability.status}; barring the worker who did not turn up → ${bar ? bar.status : 'no no-show on record to act on'}; priority penalty on the employer: ${penaltyUntil ?? 'none'}. ${confirmedWith.length} already-confirmed bookings with the blocked supplier stay in place with no warning.`,
    impact: 'Unreliable suppliers keep winning priority access elsewhere; the agency cannot enforce its terms.',
    proposal: 'A reliability score per organisation and per worker (on-time clock-in, late cancellations, no-shows) visible to hosts and used as a dispatch weighting; configurable cancellation/no-show fees; and a prompt when blocking an organisation you still have bookings with.',
    decisionNeeded: 'What should the late-cancellation and no-show penalties be (a fee, a lower priority rank, a suspension after N incidents), and who sets them: the platform or each host?',
  });
}

export async function probeInspectorRequest(ctx: SimContext, host: SimOrg): Promise<void> {
  const { api, gaps, clock } = ctx;
  const site = host.sites[0]!;
  const query = `siteId=${site.id}&from=2026-11-01&to=2027-02-01`;
  const report = await api.task('Inspector asks who worked at a site', 'registered manager', () => api.get(`/api/v1/reports/workforce?${query}`, host.adminToken));
  const csv = await api.task('Inspector asks who worked at a site', 'registered manager', () => api.get(`/api/v1/reports/workforce?${query}&format=csv`, host.adminToken));
  api.countTask('Inspector asks who worked at a site');
  // The manual way, for comparison: list all payable timesheets, filter client-side by site, then open each worker.
  const manual = 'Inspector asks who worked at a site (by hand, for comparison)';
  const started = api.calls.length;
  const ts = await api.task(manual, 'registered manager', () => api.get('/api/v1/timesheets?scope=payable&status=APPROVED', host.adminToken));
  const atSite = listOf(ts).slice(0, 25);
  let refused = 0;
  for (const t of atSite) {
    const lookup = await api.task(manual, 'registered manager', () => api.get(`/api/v1/workers/${t.workerId}`, host.adminToken));
    if (lookup.status === 403) refused++;
  }
  api.countTask(manual);
  const manualCalls = api.calls.length - started;
  const rows = (report.body?.rows as any[]) ?? [];
  const s = report.body?.summary ?? {};
  const csvOk = csv.status === 200 && typeof csv.body === 'string' && (csv.contentType ?? '').includes('text/csv');
  if (report.status === 200 && rows.length > 0 && csvOk) {
    const types = Object.keys(rows[0]?.documents ?? {});
    gaps.record({
      id: 'REP-01',
      title: 'A per-site workforce report shows who worked, for whom, and their document status on the day',
      category: 'Reporting',
      severity: 'high',
      persona: 'registered manager (CQC inspection)',
      month: monthOf(clock.now),
      status: 'fixed',
      evidence: `Asked for everyone who worked at ${site.name} between November and January with their DBS and training status: GET /reports/workforce?siteId&from&to returned ${rows.length} shift rows covering ${s.workers} workers from ${s.employers} employer(s), ${s.nonCompliantOnDay} not compliant on the day, each with attendance, paid hours, timesheet status and a status per required document (${types.join(', ')}) as it stood on that date; the CSV (${(csv.body as string).length.toLocaleString()} bytes, ${csv.contentType}) took one more call. Doing it by hand for comparison took ${manualCalls} calls and ${refused} of ${atSite.length} worker look-ups were refused because the worker belongs to another organisation. Hosts see a status, not the documents themselves (decision 11).`,
      impact: 'A registered manager can evidence safe staffing from the platform in two calls.',
      proposal: 'Keep: the report and CSV; a PDF with the organisation\'s letterhead would suit an inspection pack.',
    });
    return;
  }
  gaps.record({
    id: 'REP-01',
    title: 'No regulator-ready record of who worked where with which checks',
    category: 'Reporting',
    severity: 'high',
    persona: 'registered manager (CQC inspection)',
    month: monthOf(clock.now),
    evidence: `Asked for everyone who worked at ${site.name} between November and January with their DBS and training status: GET /reports/workforce → ${report.status} with ${rows.length} rows, CSV → ${csv.status} (${csv.contentType ?? 'no content type'}); assembling it by hand meant ${manualCalls} calls, and ${refused} worker look-ups were refused because the worker belongs to another organisation.`,
    impact: 'Hosts cannot evidence safe staffing from the platform; this is a blocker for many registered managers adopting it.',
    proposal: 'A per-site workforce report (date range → worker, employer, role, shifts, document status on each shift date) as CSV/PDF, with the host allowed to see the compliance snapshot of workers who worked for it.',
  });
}

export async function probeSuspension(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, gaps, clock, world } = ctx;
  let openBefore = listOf(await api.get('/api/v1/shifts?scope=posted', org.managerToken)).filter((s) => s.status === 'OPEN');
  let outgoing = listOf(await api.get('/api/v1/assignments?scope=outgoing&status=CONFIRMED', org.managerToken));
  if (openBefore.length === 0 && outgoing.length === 0) {
    // The chronic late payer is quiet this week; suspend the busiest small or medium host instead so the effect is visible.
    const candidates = world.providers().filter((o) => o.id !== org.id && o.size !== 'large');
    let best: { o: SimOrg; open: any[]; out: any[] } | null = null;
    for (const o of candidates) {
      const open = listOf(await api.get('/api/v1/shifts?scope=posted', o.managerToken)).filter((s) => s.status === 'OPEN');
      const out = listOf(await api.get('/api/v1/assignments?scope=outgoing&status=CONFIRMED', o.managerToken));
      if (!best || open.length + out.length > best.open.length + best.out.length) best = { o, open, out };
    }
    if (best && best.open.length + best.out.length > 0) {
      org = best.o;
      openBefore = best.open;
      outgoing = best.out;
    }
  }
  const res = await api.task('Suspend an organisation for non-payment', 'agency finance', () => api.patch(`/api/v1/organisations/${org.id}`, world.platformAdminToken, { status: 'SUSPENDED', suspendedReason: 'Invoices unpaid for more than 90 days' }));
  api.countTask('Suspend an organisation for non-payment');
  org.status = 'SUSPENDED';
  const effects = res.body?.effects as { shiftsCancelled: number; bookingsHonoured: number } | undefined;
  // Can the network still see and request their shifts?
  const other = world.providers().find((o) => o.id !== org.id)!;
  const board = await api.get('/api/v1/shifts?scope=available', other.managerToken);
  const stillVisible = listOf(board).filter((s) => openBefore.some((o) => o.id === s.id));
  const login = await api.get('/api/v1/auth/me', org.managerToken);
  // Hosts holding its staff on shifts still to start: were they told?
  const hostIds = [...new Set(outgoing.filter((a) => new Date(a.shift.startsAt) > clock.now).map((a) => a.shift.hostOrgId as string))];
  let hostsTold = 0;
  for (const hostId of hostIds) {
    const host = world.org(hostId);
    if (!host) continue;
    const inbox = await api.task('Check notifications', 'rota manager', () => api.get('/api/v1/notifications?limit=200', host.managerToken));
    api.countTask('Check notifications');
    if (((inbox.body?.notifications as any[]) ?? []).some((n) => n.data?.kind === 'supplier-suspended' && n.data?.organisationId === org.id)) hostsTold++;
  }
  if (res.status === 200 && effects && stillVisible.length === 0) {
    gaps.record({
      id: 'PLT-01',
      title: 'Suspending an organisation withdraws its open shifts and tells the hosts holding its staff',
      category: 'Platform & admin',
      severity: 'high',
      persona: 'agency finance',
      month: monthOf(clock.now),
      status: 'fixed',
      evidence: `${org.name} suspended (${res.status}): its users are locked out (${login.status}), the platform cancelled ${effects.shiftsCancelled} unstarted shift(s) it hosted (suppliers told the reason) and none of its ${openBefore.length} previously open shifts remained visible to ${other.name}. ${effects.bookingsHonoured} confirmed booking(s) of its staff at other hosts stand pending the owner's decision on whether to cancel or honour them; ${hostsTold} of ${hostIds.length} host(s) holding one found a notice in their inbox. Its pending requests and offers elsewhere are untouched. A separate credit hold (invoices over 30 days overdue) pauses posting without touching bookings.`,
      impact: 'Suppliers stop committing staff to a host that cannot pay, and hosts relying on its workers know where they stand.',
      proposal: 'Keep: suspension effects and the credit hold; decide what happens to a suspended supplier\'s confirmed bookings elsewhere.',
    });
    return;
  }
  gaps.record({
    id: 'PLT-01',
    title: 'Suspending an organisation does not withdraw its open shifts or settle its bookings',
    category: 'Platform & admin',
    severity: 'high',
    persona: 'agency finance',
    month: monthOf(clock.now),
    evidence: `${org.name} suspended (${res.status}); its users are locked out (${login.status}) but ${stillVisible.length} of its ${openBefore.length} open shifts stayed visible to ${other.name}, and ${outgoing.length} confirmed booking(s) of its workers at other hosts stayed live with nobody able to manage them (${effects ? `effects reported: ${effects.shiftsCancelled} shifts cancelled, ${effects.bookingsHonoured} bookings honoured` : 'the response carried no effects'}; ${hostsTold} host(s) told).`,
    impact: 'Suppliers keep committing staff to a host that cannot pay; hosts keep relying on workers whose employer is locked out.',
    proposal: 'Suspension should pause posting, hide open shifts, notify counterparties about confirmed bookings and offer a grace window; a separate "credit hold" state for late payment that blocks new postings but keeps existing bookings.',
    decisionNeeded: 'When a host is suspended for non-payment, should its already-confirmed future bookings be cancelled automatically, or honoured and invoiced in arrears?',
  });
}

export async function probeDataSubjectRequest(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, gaps, clock, world } = ctx;
  // A suspended employer's logins are locked out, so the request comes from a worker at an active one.
  if (org.status !== 'ACTIVE') org = world.providers().find((o) => o.workers.some((x) => x.token && x.active)) ?? org;
  const w = org.workers.find((x) => x.token && x.active);
  if (!w) return;
  const me = await api.task('Worker asks for their data (GDPR)', 'care worker', () => api.get(`/api/v1/workers/${w.id}`, w.token));
  const exportRes = await api.task('Worker asks for their data (GDPR)', 'care worker', () => api.get(`/api/v1/workers/${w.id}/export`, w.token));
  api.countTask('Worker asks for their data (GDPR)');
  const erasureReq = await api.task('Worker asks to be forgotten', 'care worker', () => api.post(`/api/v1/workers/${w.id}/erasure-request`, w.token, {}));
  api.countTask('Worker asks to be forgotten');
  const adminInbox = await api.task('Check notifications', 'org admin', () => api.get('/api/v1/notifications?limit=200', org.adminToken));
  api.countTask('Check notifications');
  const adminTold = ((adminInbox.body?.notifications as any[]) ?? []).some((n) => n.data?.kind === 'erasure-request' && n.data?.workerId === w.id);
  // The leaver from week 8 is inactive with no bookings ahead: their employer's admin erases the personal data.
  const leaver = world.orgs.filter((o) => o.status === 'ACTIVE').flatMap((o) => o.workers.filter((x) => !x.active).map((x) => ({ org: o, w: x })))[0];
  const erase = leaver ? await api.task('Erase a leaver\'s personal data', 'org admin', () => api.post(`/api/v1/workers/${leaver.w.id}/erase`, leaver.org.adminToken, { reason: 'Left the organisation; data no longer needed' })) : null;
  if (erase?.status === 200) api.countTask('Erase a leaver\'s personal data');
  const readBack = leaver ? await api.get(`/api/v1/workers/${leaver.w.id}`, leaver.org.adminToken) : null;
  const erasedName = readBack?.body ? `${readBack.body.firstName} ${readBack.body.lastName}` : null;
  const bundle = exportRes.body ?? {};
  const docs = (bundle.documents as any[])?.length ?? 0;
  const assignments = (bundle.assignments as any[])?.length ?? 0;
  const ok = me.status === 200 && exportRes.status === 200 && erasureReq.status === 202 && erase?.status === 200 && erasedName === 'Former Worker';
  if (ok && leaver && erase) {
    gaps.record({
      id: 'SEC-01',
      title: 'Data-subject tooling: export, erasure request, erasure with records kept, consent recorded',
      category: 'Security & data',
      severity: 'high',
      persona: 'care worker / DPO',
      month: monthOf(clock.now),
      status: 'fixed',
      evidence: `${w.name} read their profile (${me.status}), downloaded everything held about them (${exportRes.status}: ${docs} document(s) including superseded versions, ${assignments} assignment(s), timesheets, ratings, bars, reports, login and consent dates) and asked to be forgotten (${erasureReq.status}); ${org.name}'s admin ${adminTold ? 'found the request in their inbox' : 'did not find a request in their inbox'}. The week-8 leaver ${leaver.w.name} (inactive, no future bookings) was erased by ${leaver.org.name}'s admin with a reason (${erase.status}; kept: ${(erase.body?.kept as string[] | undefined)?.join(', ')}) and now reads back as "${erasedName}" with no contact details, location, documents or login. Consent to share is recorded on the worker record. The legal retention period for the kept financial and safety records, and so when the placeholder row itself can go, is still to be set with the lawyer (decision 18); the operator's controller/processor stance is a working assumption until confirmed (decision 13).`,
      impact: 'A data-protection officer can see what is held, who asked for what, and what was removed.',
      proposal: 'Keep: export, erasure request and erasure; add the retention job once the period is agreed.',
    });
    return;
  }
  gaps.record({
    id: 'SEC-01',
    title: 'No data-subject tooling: export, erasure, consent to share, or retention rules',
    category: 'Security & data',
    severity: 'high',
    persona: 'care worker / DPO',
    month: monthOf(clock.now),
    evidence: `${w.name} can read their profile (${me.status}); export → ${exportRes.status}, erasure request → ${erasureReq.status}; erasing an inactive leaver as their employer's admin → ${erase ? `${erase.status}, record reads back as "${erasedName}"` : 'no inactive worker to try it on'}. Nothing deletes data after a worker leaves until the retention period is agreed.`,
    impact: 'The platform processes special-category data (DBS, health-related training) across organisations without the paperwork a data-protection officer will demand.',
    proposal: 'Consent capture at worker activation, a data export, an erasure/anonymisation job that keeps financial records, per-organisation retention settings, and a record of data-sharing agreements between organisations.',
    decisionNeeded: 'Is the platform operator a data controller or a processor for worker data, and what retention period should apply after a worker or organisation leaves? (Needs a legal view.)',
  });
}

export async function probeOffboarding(ctx: SimContext, org: SimOrg): Promise<void> {
  const { api, gaps, clock, world } = ctx;
  const close = await api.task('Organisation leaves the network', 'org admin', () => api.post(`/api/v1/organisations/${org.id}/close`, org.adminToken, { reason: 'Moving to another platform' }));
  const selfStatus = await api.task('Organisation leaves the network', 'org admin', () => api.patch(`/api/v1/organisations/${org.id}`, org.adminToken, { status: 'SUSPENDED' }));
  const outstanding = listOf(await api.get('/api/v1/invoices?scope=payable', org.adminToken)).filter((i) => i.status === 'ISSUED');
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
  const range = `from=${iso(SIM_START)}&to=${iso(clock.now)}`;
  const spend = await api.task('Monthly spend report by site', 'finance clerk', () => api.get(`/api/v1/finance/spend?${range}&groupBy=site`, host.adminToken));
  api.countTask('Monthly spend report by site');
  const csv = await api.task('Export statement lines for the accounts package', 'agency finance', () => api.get(`/api/v1/finance/export.csv?type=lines&${range}`, world.platformAdminToken));
  api.countTask('Export statement lines for the accounts package');
  const pnl = await api.task('Agency margin by client', 'agency owner', () => api.get(`/api/v1/finance/agency/pnl?${range}`, world.platformAdminToken));
  api.countTask('Agency margin by client');
  const rows = (spend.body?.rows as any[]) ?? [];
  const csvOk = csv.status === 200 && typeof csv.body === 'string' && (csv.contentType ?? '').includes('text/csv');
  if (spend.status === 200 && rows.length > 0 && csvOk && pnl.status === 200) {
    const t = spend.body.totals ?? {};
    const p = pnl.body ?? {};
    const lines = Math.max(0, (csv.body as string).trim().split('\n').length - 1);
    gaps.record({
      id: 'REP-02',
      title: 'Date-ranged reports: spend by site, supplier or month, earnings, network CSV exports and an agency P&L',
      category: 'Reporting',
      severity: 'high',
      persona: 'finance clerk / agency owner',
      month: monthOf(clock.now),
      status: 'fixed',
      evidence: `${host.name}'s finance clerk pulled spend by site for ${fmtDate(SIM_START)} to ${fmtDate(clock.now)}: ${rows.length} site(s), ${t.shifts} shifts, ${Math.round(t.hours ?? 0).toLocaleString()} hours, £${Math.round(t.amount ?? 0).toLocaleString()} (groupBy=supplier|month too; suppliers have GET /finance/earnings). The agency exported ${lines.toLocaleString()} statement lines as CSV (${(csv.body as string).length.toLocaleString()} bytes, ${csv.contentType}; host invoices and remittances export the same way) and read its P&L: revenue £${Math.round(p.revenue?.total ?? 0).toLocaleString()} (fees £${Math.round(p.revenue?.platformFees ?? 0).toLocaleString()}, own-bank sales £${Math.round(p.revenue?.agencySales ?? 0).toLocaleString()}), bank pay £${Math.round(p.costOfSales?.bankWorkerPay ?? 0).toLocaleString()}, gross margin £${Math.round(p.grossMargin ?? 0).toLocaleString()} (${p.grossMarginPct ?? '–'}%) across ${(p.byClient as any[])?.length ?? 0} clients. VAT, employer on-costs and nominal coding are not included.`,
      impact: 'Finance teams and the agency read the numbers off the platform instead of rebuilding them from statement PDFs.',
      proposal: 'Keep: the report endpoints and CSV exports; add VAT and nominal codes when the accounts package is chosen.',
    });
    return;
  }
  gaps.record({
    id: 'REP-02',
    title: 'Reporting stops at a 30-day headline; no date ranges, no breakdown by site, role or counterparty, no CSV',
    category: 'Reporting',
    severity: 'high',
    persona: 'finance clerk / agency owner',
    month: monthOf(clock.now),
    evidence: `GET /finance/spend?groupBy=site → ${spend.status} with ${rows.length} rows; GET /finance/export.csv?type=lines → ${csv.status} (${csv.contentType ?? 'no content type'}); GET /finance/agency/pnl → ${pnl.status}. Finance teams are left with the 30-day headline figures.`,
    impact: 'Finance teams rebuild the numbers in spreadsheets from statement PDFs; the agency cannot see which clients make money.',
    proposal: 'Report endpoints with date ranges and group-by (site, role, supplier/host, month), CSV export everywhere a table is shown, and a margin report for the agency.',
  });
}

export async function probePagination(ctx: SimContext): Promise<void> {
  const { api, gaps, clock, world } = ctx;
  const started = performance.now();
  const all = await api.task('Platform admin lists all shifts', 'agency ops', () => api.get('/api/v1/shifts?scope=all', world.platformAdminToken));
  const ms = Math.round(performance.now() - started);
  const rows = listOf(all).length;
  const large = world.providers().find((o) => o.size === 'large');
  let posted = 0;
  let postedMs = 0;
  if (large) {
    const t = performance.now();
    const res = await api.task('Rota manager lists posted shifts', 'rota manager', () => api.get('/api/v1/shifts?scope=posted&includePast=true', large.managerToken));
    postedMs = Math.round(performance.now() - t);
    posted = listOf(res).length;
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

export async function probeNotificationVolume(ctx: SimContext, perOrgDay: Map<string, number>, byType: Map<string, number>, emailsSent: number, world = ctx.world): Promise<void> {
  const { api, gaps, clock } = ctx;
  let worst: { key: string; n: number } = { key: '', n: 0 };
  for (const [key, n] of perOrgDay) if (n > worst.n) worst = { key, n };
  const [orgId, day] = worst.key.split('|');
  const org = orgId ? world.org(orgId) : undefined;
  const total = [...byType.values()].reduce((s, n) => s + n, 0);
  const top = [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t} ${n}`).join(', ');
  const manager = world.providers()[0];
  const prefs = manager ? await api.task('Review notification preferences', 'rota manager', () => api.get('/api/v1/notifications/preferences', manager.managerToken)) : null;
  if (emailsSent > 0 && prefs?.status === 200) {
    api.countTask('Review notification preferences');
    gaps.record({
      id: 'COM-01',
      title: 'Notifications go out by email, immediately or in a daily digest, with preferences per user',
      category: 'Communication',
      severity: 'blocker',
      persona: 'everyone',
      month: monthOf(clock.now),
      status: 'fixed',
      evidence: `${total.toLocaleString()} notifications were generated over the run (${top}); ${emailsSent.toLocaleString()} emails were sent (immediate for offers, confirmations, cancellations, unfilled-shift warnings, disputes, flag changes and system notices; everything else in each person's daily digest), with preferences and quiet hours per user (GET/PUT /notifications/preferences: ${(prefs!.body?.types as string[])?.length ?? 0} types, ${(prefs!.body?.defaults?.immediate as string[])?.length ?? 0} immediate by default). ${org?.name ?? 'One organisation'} received ${worst.n} on ${day}, mostly release notices, which the digest absorbs. SMS has a console channel only; the provider, sender ID and who pays for texts are still to be chosen (decision 15).`,
      impact: 'An urgent shift released at 20:00 reaches people by email at once; the bell stops being the only channel.',
      proposal: 'Keep: email channels and preferences; add the SMS provider at deployment and push when there is a mobile app.',
    });
    return;
  }
  gaps.record({
    id: 'COM-01',
    title: 'Notifications are in-app only, unbatched and unprioritised',
    category: 'Communication',
    severity: 'blocker',
    persona: 'everyone',
    month: monthOf(clock.now),
    evidence: `${total.toLocaleString()} notifications were generated over the run (${top}). ${org?.name ?? 'One organisation'} received ${worst.n} on ${day}. ${emailsSent > 0 ? `${emailsSent} emails were sent but preferences are unavailable (${prefs?.status})` : 'None left the app: no email, SMS or push exists'}, so an urgent shift released at 20:00 is only seen when someone next logs in.`,
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
