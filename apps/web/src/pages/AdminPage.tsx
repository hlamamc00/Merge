import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AgencyPosition, JOB_ROLE_LABELS } from '@merge/shared';
import { api } from '../api/client';
import { useAction } from '../api/hooks';
import type { AdminOverview, AllShift, AuditEntry, DirectoryOrg, PlatformSettings } from '../api/types';
import { StatusBadge, UrgentBadge } from '../components/badges';
import { Badge, Button, Card, Checkbox, ErrorBanner, Field, InfoBanner, Input, Loading, PageHeader, Select, StatCard, Table, Tabs } from '../components/ui';
import { fmtDateTime, fmtMoney, fmtShiftWindow, humanise } from '../lib/format';

const AGENCY_POSITION_HELP: Record<AgencyPosition, string> = {
  FIRST: 'Agency bank sees every shift before anyone else (agency-first model: maximise margin by filling with your own bank).',
  WITH_PRIORITY: 'Agency bank is released at the same time as surplus-flagged organisations.',
  AFTER_PRIORITY: 'Surplus-flagged organisations first, then the agency bank, then the network (default, network-first).',
  WITH_NETWORK: 'Agency bank is released with the rest of the network.',
  LAST: 'Agency bank is the safety net: only after the whole network has had its window.',
};

type Tab = 'settings' | 'organisations' | 'shifts' | 'audit';

export function AdminPage() {
  const [tab, setTab] = useState<Tab>('settings');
  const overview = useQuery({ queryKey: ['admin-overview'], queryFn: () => api.get<AdminOverview>('/admin/overview') });
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
      <Tabs tabs={[{ value: 'settings', label: 'Settings' }, { value: 'organisations', label: 'Organisations' }, { value: 'shifts', label: 'All shifts' }, { value: 'audit', label: 'Audit log' }]} value={tab} onChange={setTab} />
      {tab === 'settings' && <SettingsForm />}
      {tab === 'organisations' && <OrganisationsTable />}
      {tab === 'shifts' && <AllShiftsTable />}
      {tab === 'audit' && <AuditTable />}
    </div>
  );
}

function SettingsForm() {
  const q = useQuery({ queryKey: ['admin-settings'], queryFn: () => api.get<PlatformSettings>('/admin/settings') });
  const [form, setForm] = useState<Partial<PlatformSettings>>({});
  useEffect(() => {
    if (q.data) setForm(q.data);
  }, [q.data]);
  const save = useAction(() => {
    const { id: _id, ownerOrgId: _o, updatedAt: _u, ...body } = form as PlatformSettings;
    return api.patch('/admin/settings', body);
  });
  if (q.isLoading || !form.agencyPosition) return <Loading />;
  const num = (k: keyof PlatformSettings) => ({ value: String(form[k] ?? ''), onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: Number(e.target.value) }) });
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

function OrganisationsTable() {
  const q = useQuery({ queryKey: ['organisations', 'admin'], queryFn: () => api.get<DirectoryOrg[]>('/organisations') });
  const setStatus = useAction((args: { id: string; status: string }) => api.patch(`/organisations/${args.id}`, { status: args.status }));
  return (
    <Card title="Organisations">
      <ErrorBanner error={setStatus.error} className="mb-3" />
      {q.isLoading ? <Loading /> : (
        <Table
          rows={q.data ?? []}
          rowKey={(o) => o.id}
          columns={[
            { key: 'name', header: 'Organisation', render: (o) => <span className="font-medium text-slate-900">{o.name}</span> },
            { key: 'type', header: 'Type', render: (o) => <Badge tone={o.type === 'AGENCY' ? 'violet' : 'slate'}>{humanise(o.type)}</Badge> },
            { key: 'loc', header: 'Location', render: (o) => [o.city, o.postcode].filter(Boolean).join(' · ') },
            { key: 'status', header: 'Status', render: (o) => <StatusBadge status={o.status} /> },
            { key: 'actions', header: '', align: 'right', render: (o) => o.type !== 'AGENCY' && (o.status === 'ACTIVE' ? <Button size="sm" variant="danger" onClick={() => setStatus.mutate({ id: o.id, status: 'SUSPENDED' })}>Suspend</Button> : <Button size="sm" variant="success" onClick={() => setStatus.mutate({ id: o.id, status: 'ACTIVE' })}>Activate</Button>) },
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
  const q = useQuery({ queryKey: ['audit', entityType], queryFn: () => api.get<AuditEntry[]>('/admin/audit', { entityType: entityType || undefined, limit: 200 }) });
  return (
    <Card title="Audit log" actions={<Select value={entityType} onChange={(e) => setEntityType(e.target.value)} className="w-auto py-1 text-xs"><option value="">All entities</option>{['organisation', 'user', 'worker', 'worker_document', 'capacity_flag', 'shift', 'shift_assignment', 'timesheet', 'invoice', 'platform_settings', 'relationship', 'site'].map((t) => <option key={t} value={t}>{t}</option>)}</Select>}>
      {q.isLoading ? <Loading /> : (
        <Table
          rows={q.data ?? []}
          rowKey={(a) => a.id}
          columns={[
            { key: 'at', header: 'When', render: (a) => <span className="whitespace-nowrap text-xs">{fmtDateTime(a.createdAt)}</span> },
            { key: 'action', header: 'Action', render: (a) => <Badge>{a.action}</Badge> },
            { key: 'entity', header: 'Entity', render: (a) => <span className="text-xs">{a.entityType} <span className="font-mono text-slate-500">{a.entityId}</span></span> },
            { key: 'actor', header: 'Actor', render: (a) => <span className="font-mono text-xs text-slate-500">{a.actorUserId ?? 'system'}</span> },
            { key: 'data', header: 'Data', render: (a) => <code className="block max-w-md truncate text-xs text-slate-500" title={JSON.stringify(a.data)}>{a.data ? JSON.stringify(a.data) : ''}</code> },
          ]}
        />
      )}
    </Card>
  );
}
