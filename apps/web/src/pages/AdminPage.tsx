import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AgencyPosition, JOB_ROLE_LABELS } from '@merge/shared';
import { api } from '../api/client';
import { useAction } from '../api/hooks';
import type { AdminOverview, AllShift, DirectoryOrg, PlatformSettings } from '../api/types';
import type { AdminOrganisation, AdminUser, AuditEntryWithActor } from '../api/types.compliance';
import { StatusBadge, UrgentBadge } from '../components/badges';
import { Badge, Button, Card, Checkbox, EmptyState, ErrorBanner, Field, InfoBanner, Input, Loading, Modal, PageHeader, Select, StatCard, Table, Tabs, Textarea } from '../components/ui';
import { fmtDate, fmtDateTime, fmtMoney, fmtShiftWindow, humanise } from '../lib/format';

const AGENCY_POSITION_HELP: Record<AgencyPosition, string> = {
  FIRST: 'Agency bank sees every shift before anyone else (agency-first model: maximise margin by filling with your own bank).',
  WITH_PRIORITY: 'Agency bank is released at the same time as surplus-flagged organisations.',
  AFTER_PRIORITY: 'Surplus-flagged organisations first, then the agency bank, then the network (default, network-first).',
  WITH_NETWORK: 'Agency bank is released with the rest of the network.',
  LAST: 'Agency bank is the safety net: only after the whole network has had its window.',
};

type Tab = 'approvals' | 'settings' | 'organisations' | 'shifts' | 'audit';

/** Settings beyond the original dispatch/money fields (all optional so older API responses still type). */
type FullSettings = PlatformSettings & { twoFactorRequiredForManagers?: boolean; mouVersion?: string; documentRetentionYears?: number; defaultEscalationMode?: 'MANUAL' | 'AUTO'; nationalMinimumWage?: number; employerOnCostPct?: number; noShowWindowDays?: number; noShowPriorityPenaltyThreshold?: number; noShowPriorityPenaltyDays?: number; noShowSuspensionThreshold?: number; noShowRateThresholdPct?: number; requestReminderHours?: number; requestReminderBeforeStartHours?: number };

export function AdminPage() {
  const [tab, setTab] = useState<Tab>('approvals');
  const overview = useQuery({ queryKey: ['admin-overview'], queryFn: () => api.get<AdminOverview>('/admin/overview') });
  const pending = useQuery({ queryKey: ['admin-orgs', 'PENDING'], queryFn: () => api.get<AdminOrganisation[]>('/admin/organisations', { status: 'PENDING' }) });
  const tick = useAction(() => api.post<Record<string, unknown>>('/admin/scheduler/tick'));
  const o = overview.data;
  return (
    <div className="space-y-5">
      <PageHeader title="Platform administration" description="Dispatch windows, fees, working-time rules and network oversight." actions={<Button variant="secondary" onClick={() => tick.mutate()} loading={tick.isPending}>▶ Run scheduler now</Button>} />
      <ErrorBanner error={tick.error} />
      {tick.data && <InfoBanner tone="green">Scheduler ran: <code className="text-xs">{JSON.stringify(tick.data)}</code></InfoBanner>}
      {o && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          <StatCard label="Organisations" value={o.organisations.active} hint={`${o.organisations.total} total`} />
          <StatCard label="Open shifts" value={o.shifts.open} hint={`${o.shifts.fillRatePct ?? '—'}% fill rate`} />
          <StatCard label="Surplus hours" value={o.capacity.surplusHours} tone="brand" />
          <StatCard label="Shortage hours" value={o.capacity.shortageHours} tone="amber" />
          <StatCard label="Platform fee (30d)" value={fmtMoney(o.money.platformFeeLast30d)} tone="green" hint={`on ${fmtMoney(o.money.approvedChargeLast30d)}`} />
          <StatCard label="Awaiting approval" value={o.money.timesheetsAwaitingApproval} hint="timesheets" />
        </div>
      )}
      <Tabs tabs={[{ value: 'approvals', label: 'Approvals', count: pending.data?.length }, { value: 'settings', label: 'Settings' }, { value: 'organisations', label: 'Organisations' }, { value: 'shifts', label: 'All shifts' }, { value: 'audit', label: 'Audit log' }]} value={tab} onChange={setTab} />
      {tab === 'approvals' && <ApprovalQueue />}
      {tab === 'settings' && <SettingsForm />}
      {tab === 'organisations' && <OrganisationsTable />}
      {tab === 'shifts' && <AllShiftsTable />}
      {tab === 'audit' && <AuditTable />}
    </div>
  );
}

function SettingsForm() {
  const q = useQuery({ queryKey: ['admin-settings'], queryFn: () => api.get<FullSettings>('/admin/settings') });
  const [form, setForm] = useState<Partial<FullSettings>>({});
  useEffect(() => {
    if (q.data) setForm(q.data);
  }, [q.data]);
  const save = useAction(() => {
    const { id: _id, ownerOrgId: _o, updatedAt: _u, ...body } = form as FullSettings;
    return api.patch('/admin/settings', body);
  });
  if (q.isLoading || !form.agencyPosition) return <Loading />;
  const num = (k: keyof FullSettings) => ({ value: String(form[k] ?? ''), onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: Number(e.target.value) }) });
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="Release order & windows" description="How shifts flow from the host to the network.">
        <div className="space-y-3">
          <Field label="Agency bank position" hint={AGENCY_POSITION_HELP[form.agencyPosition as AgencyPosition]}>
            <Select value={form.agencyPosition} onChange={(e) => setForm({ ...form, agencyPosition: e.target.value })}>
              {Object.values(AgencyPosition).map((p) => <option key={p} value={p}>{humanise(p)}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Priority window (min)" hint="Exclusive access for surplus-flagged orgs."><Input type="number" min="0" {...num('priorityWindowMinutes')} /></Field>
            <Field label="Agency window (min)" hint="Exclusive agency window when FIRST / AFTER_PRIORITY."><Input type="number" min="0" {...num('agencyWindowMinutes')} /></Field>
            <Field label="Urgent threshold (min)" hint="Shifts starting sooner open to everyone at once."><Input type="number" min="0" {...num('urgentThresholdMinutes')} /></Field>
            <Field label="Min lead before start (min)" hint="No stage opens later than this before the shift."><Input type="number" min="0" {...num('minLeadBeforeStartMinutes')} /></Field>
          </div>
          <Checkbox label="Preferred partners get priority" hint="Hosts' preferred partners join the priority tier even without a surplus flag." checked={!!form.preferredPartnersGetPriority} onChange={(e) => setForm({ ...form, preferredPartnersGetPriority: e.target.checked })} />
        </div>
      </Card>
      <Card title="Money & working time">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Platform name"><Input value={form.platformName ?? ''} onChange={(e) => setForm({ ...form, platformName: e.target.value })} /></Field>
            <Field label="Platform fee (%)" hint="Taken from the host's charge before the supplier is paid."><Input type="number" min="0" max="50" step="0.5" {...num('platformFeePct')} /></Field>
            <Field label="Currency"><Input value={form.currency ?? ''} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} maxLength={3} /></Field>
            <Field label="Late cancellation (hours)" hint="Supplier cancellations inside this window are flagged."><Input type="number" min="0" {...num('lateCancellationHours')} /></Field>
            <Field label="Min rest between shifts (h)"><Input type="number" min="0" step="0.5" {...num('minRestHours')} /></Field>
            <Field label="Max weekly hours"><Input type="number" min="1" {...num('maxWeeklyHours')} /></Field>
            <Field label="Max shift length (h)"><Input type="number" min="1" step="0.5" {...num('maxShiftHours')} /></Field>
          </div>
        </div>
      </Card>
      <Card title="Security, vetting & records" description="Decisions 12, 16 and 18.">
        <div className="space-y-3">
          <Checkbox label="Require an authenticator app for managers and administrators" hint="When on, every manager must enrol before they can do anything else. Workers are never required to." checked={!!form.twoFactorRequiredForManagers} onChange={(e) => setForm({ ...form, twoFactorRequiredForManagers: e.target.checked })} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="MOU version" hint="Raise it when the memorandum changes; organisations are asked to accept the new version."><Input value={form.mouVersion ?? ''} onChange={(e) => setForm({ ...form, mouVersion: e.target.value })} /></Field>
            <Field label="Document retention (years)" hint="How long superseded compliance records are kept."><Input type="number" min="1" max="30" {...num('documentRetentionYears')} /></Field>
            <Field label="Default escalation for new hosts">
              <Select value={form.defaultEscalationMode ?? 'MANUAL'} onChange={(e) => setForm({ ...form, defaultEscalationMode: e.target.value as 'MANUAL' | 'AUTO' })}><option value="MANUAL">Manual (remind the host)</option><option value="AUTO">Automatic rate uplift</option></Select>
            </Field>
          </div>
        </div>
      </Card>
      <Card title="Floor rates & reliability" description="Decisions 3 and 4.">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="National minimum wage (£/h)"><Input type="number" min="0" step="0.01" {...num('nationalMinimumWage')} /></Field>
            <Field label="Employer on-costs (%)" hint="NI, pension, holiday pay on top of the wage."><Input type="number" min="0" max="100" {...num('employerOnCostPct')} /></Field>
            <Field label="No-show window (days)"><Input type="number" min="1" {...num('noShowWindowDays')} /></Field>
            <Field label="No-shows before priority is removed"><Input type="number" min="1" {...num('noShowPriorityPenaltyThreshold')} /></Field>
            <Field label="Priority penalty length (days)"><Input type="number" min="1" {...num('noShowPriorityPenaltyDays')} /></Field>
            <Field label="No-shows before suspension"><Input type="number" min="1" {...num('noShowSuspensionThreshold')} /></Field>
            <Field label="…and at least this share of bookings (%)" hint="So a large supplier is judged on its rate, not a raw count."><Input type="number" min="0" max="100" step="0.5" {...num('noShowRateThresholdPct')} /></Field>
            <Field label="Remind operator after (hours)" hint="Unanswered requests (decision 7)."><Input type="number" min="0" step="0.5" {...num('requestReminderHours')} /></Field>
            <Field label="…or this long before the start (hours)"><Input type="number" min="0" step="0.5" {...num('requestReminderBeforeStartHours')} /></Field>
          </div>
          <ErrorBanner error={save.error} />
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500">Last updated {fmtDateTime(q.data?.updatedAt)}</span>
            <Button onClick={() => save.mutate()} loading={save.isPending}>Save settings</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** Decision 12: vet new organisations before they can trade. */
function ApprovalQueue() {
  const q = useQuery({ queryKey: ['admin-orgs', 'PENDING'], queryFn: () => api.get<AdminOrganisation[]>('/admin/organisations', { status: 'PENDING' }) });
  const [overriding, setOverriding] = useState<AdminOrganisation | null>(null);
  const [note, setNote] = useState('');
  const approve = useAction((args: { id: string; override?: boolean; note?: string }) => api.post(`/organisations/${args.id}/approve`, { override: args.override, note: args.note || undefined }), () => { setOverriding(null); setNote(''); });
  const reject = useAction((args: { id: string; reason: string }) => api.patch(`/organisations/${args.id}`, { status: 'SUSPENDED', suspendedReason: args.reason }));
  return (
    <Card title="Organisations awaiting approval" description="Check the CQC register for the registration number given, confirm the memorandum has been accepted, then approve. Override only with a reason; overrides are audited.">
      <ErrorBanner error={approve.error ?? reject.error} className="mb-3" />
      {q.isLoading ? <Loading /> : (
        <Table
          rows={q.data ?? []}
          rowKey={(o) => o.id}
          empty={<EmptyState title="Nothing waiting" description="New registrations appear here." />}
          columns={[
            { key: 'org', header: 'Organisation', render: (o) => <div><div className="font-medium text-slate-900">{o.name}</div><div className="text-xs text-slate-500">{[o.city, o.postcode].filter(Boolean).join(' · ')} · registered {fmtDate(o.createdAt)}</div></div> },
            { key: 'admin', header: 'Administrator', render: (o) => o.admin ? <span className="text-xs">{o.admin.name}<div className="text-slate-500">{o.admin.email}</div></span> : '—' },
            { key: 'cqc', header: 'CQC number', render: (o) => o.cqcRegistrationNumber ? <a className="font-mono text-xs text-brand-700 hover:underline" href={`https://www.cqc.org.uk/search/all?query=${encodeURIComponent(o.cqcRegistrationNumber)}`} target="_blank" rel="noreferrer">{o.cqcRegistrationNumber} ↗</a> : <Badge tone="amber">Missing</Badge> },
            { key: 'mou', header: 'MOU', render: (o) => o.mouAcceptedAt ? <Badge tone="green">v{o.mouVersion} · {fmtDate(o.mouAcceptedAt)}</Badge> : <Badge tone="amber">Not accepted</Badge> },
            { key: 'workers', header: 'Workers', align: 'right', render: (o) => o.workerCount },
            { key: 'actions', header: '', align: 'right', render: (o) => (
              <span className="flex justify-end gap-1">
                {o.blockers.length === 0 ? <Button size="sm" variant="success" onClick={() => approve.mutate({ id: o.id })} loading={approve.isPending}>Approve</Button> : <Button size="sm" variant="secondary" onClick={() => setOverriding(o)}>Approve with override…</Button>}
                <Button size="sm" variant="ghost" onClick={() => { const reason = window.prompt('Reason for declining (shown in the audit log):'); if (reason) reject.mutate({ id: o.id, reason }); }}>Decline</Button>
              </span>
            ) },
          ]}
        />
      )}
      <Modal open={!!overriding} onClose={() => setOverriding(null)} title={`Approve ${overriding?.name ?? ''} despite missing checks`} footer={<><Button variant="secondary" onClick={() => setOverriding(null)}>Cancel</Button><Button variant="danger" onClick={() => approve.mutate({ id: overriding!.id, override: true, note })} loading={approve.isPending} disabled={!note.trim()}>Approve with override</Button></>}>
        <div className="space-y-3">
          <InfoBanner tone="amber"><ul className="list-disc pl-5">{overriding?.blockers.map((b) => <li key={b}>{b}</li>)}</ul></InfoBanner>
          <Field label="Why are you overriding?" hint="Recorded in the audit log against your login." required><Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Evidence of registration received by email on …" /></Field>
        </div>
      </Modal>
    </Card>
  );
}

function OrganisationsTable() {
  const q = useQuery({ queryKey: ['organisations', 'admin'], queryFn: () => api.get<DirectoryOrg[]>('/organisations') });
  const setStatus = useAction((args: { id: string; status: string; reason?: string }) => api.patch(`/organisations/${args.id}`, { status: args.status, ...(args.reason ? { suspendedReason: args.reason } : {}) }));
  const approve = useAction((id: string) => api.post(`/organisations/${id}/approve`, { override: true, note: 'Activated from the organisations list' }));
  return (
    <Card title="Organisations" description="Suspending an organisation signs its users out of everything until it is reactivated.">
      <ErrorBanner error={setStatus.error ?? approve.error} className="mb-3" />
      {q.isLoading ? <Loading /> : (
        <Table
          rows={q.data ?? []}
          rowKey={(o) => o.id}
          columns={[
            { key: 'name', header: 'Organisation', render: (o) => <span className="font-medium text-slate-900">{o.name}{(o as { suspendedReason?: string | null }).suspendedReason && <div className="text-xs font-normal text-red-700">{(o as { suspendedReason?: string | null }).suspendedReason}</div>}</span> },
            { key: 'type', header: 'Type', render: (o) => <Badge tone={o.type === 'AGENCY' ? 'violet' : 'slate'}>{humanise(o.type)}</Badge> },
            { key: 'loc', header: 'Location', render: (o) => [o.city, o.postcode].filter(Boolean).join(' · ') },
            { key: 'status', header: 'Status', render: (o) => <StatusBadge status={o.status} /> },
            { key: 'actions', header: '', align: 'right', render: (o) => o.type !== 'AGENCY' && (o.status === 'ACTIVE' ? <Button size="sm" variant="danger" onClick={() => { const reason = window.prompt('Reason for suspension (shown to the organisation and in the audit log):'); if (reason) setStatus.mutate({ id: o.id, status: 'SUSPENDED', reason }); }}>Suspend</Button> : o.status === 'PENDING' ? <Button size="sm" variant="success" onClick={() => approve.mutate(o.id)}>Activate (override)</Button> : <Button size="sm" variant="success" onClick={() => setStatus.mutate({ id: o.id, status: 'ACTIVE' })}>Reactivate</Button>) },
          ]}
        />
      )}
    </Card>
  );
}

function AllShiftsTable() {
  const q = useQuery({ queryKey: ['shifts', 'all'], queryFn: () => api.get<AllShift[]>('/shifts', { scope: 'all' }) });
  const navigate = useNavigate();
  return (
    <Card title="All shifts">
      {q.isLoading ? <Loading /> : (
        <Table
          rows={q.data ?? []}
          rowKey={(s) => s.id}
          onRowClick={(s) => navigate(`/shifts/${s.id}`)}
          columns={[
            { key: 'title', header: 'Shift', render: (s) => <div className="font-medium text-slate-900">{s.title} <UrgentBadge urgent={s.urgent} /><div className="text-xs font-normal text-slate-500">{JOB_ROLE_LABELS[s.jobRole]} · {s.hostName} · {s.site.name}</div></div> },
            { key: 'when', header: 'When', render: (s) => fmtShiftWindow(s.startsAt, s.endsAt, s.breakMinutes) },
            { key: 'rate', header: 'Rate', align: 'right', render: (s) => `${fmtMoney(s.chargeRate)}/h` },
            { key: 'filled', header: 'Filled', render: (s) => `${s.filledCount}/${s.headcount}` },
            { key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
          ]}
        />
      )}
    </Card>
  );
}

function AuditTable() {
  const [entityType, setEntityType] = useState('');
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => api.get<AdminUser[]>('/admin/users') });
  const q = useQuery({ queryKey: ['audit', entityType, userId, from, to], queryFn: () => api.get<AuditEntryWithActor[]>('/admin/audit', { entityType: entityType || undefined, userId: userId || undefined, from: from ? new Date(from).toISOString() : undefined, to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined, limit: 200 }) });
  return (
    <Card title="Audit log" description="Every change on the platform, by whom and when. Filter by user to review one person's activity.">
      <div className="mb-3 grid gap-3 sm:grid-cols-4">
        <Field label="Entity"><Select value={entityType} onChange={(e) => setEntityType(e.target.value)}><option value="">All entities</option>{['organisation', 'user', 'worker', 'worker_document', 'host_requirement', 'worker_host_requirement', 'capacity_flag', 'shift', 'shift_assignment', 'timesheet', 'invoice', 'platform_settings', 'relationship', 'site'].map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
        <Field label="User"><Select value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">Anyone</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName} · {u.orgName}</option>)}</Select></Field>
        <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      {q.isLoading ? <Loading /> : (
        <Table
          rows={q.data ?? []}
          rowKey={(a) => a.id}
          columns={[
            { key: 'at', header: 'When', render: (a) => <span className="whitespace-nowrap text-xs">{fmtDateTime(a.createdAt)}</span> },
            { key: 'action', header: 'Action', render: (a) => <Badge>{a.action}</Badge> },
            { key: 'entity', header: 'Entity', render: (a) => <span className="text-xs">{a.entityType} <span className="font-mono text-slate-500">{a.entityId}</span></span> },
            { key: 'actor', header: 'Actor', render: (a) => a.actor ? <span className="text-xs">{a.actor.firstName} {a.actor.lastName}<div className="text-slate-500">{a.actor.email}</div></span> : <span className="text-xs text-slate-500">system</span> },
            { key: 'data', header: 'Data', render: (a) => <code className="block max-w-md truncate text-xs text-slate-500" title={JSON.stringify(a.data)}>{a.data ? JSON.stringify(a.data) : ''}</code> },
          ]}
        />
      )}
    </Card>
  );
}
