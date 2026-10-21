import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { JOB_ROLE_LABELS } from '@merge/shared';
import { api } from '../api/client';
import { useAssignments, useAvailableShifts, useFlags, useNetworkCapacity, useOrgStats, useTimesheets } from '../api/hooks';
import type { AdminOverview, SuppliedShift } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ShiftCard } from '../components/ShiftCard';
import { StatusBadge } from '../components/badges';
import { Card, EmptyState, LinkButton, Loading, PageHeader, Progress, StatCard } from '../components/ui';
import { fmtDate, fmtHours, fmtMoney, fmtShiftWindow, humanise } from '../lib/format';

export function DashboardPage() {
  const { isPlatformAdmin, isWorker } = useAuth();
  if (isPlatformAdmin) return <AdminDashboard />;
  if (isWorker) return <WorkerDashboard />;
  return <ManagerDashboard />;
}

function ManagerDashboard() {
  const { organisation, user } = useAuth();
  const stats = useOrgStats(organisation?.id);
  const flags = useFlags({ status: 'ACTIVE' });
  const incoming = useAssignments('incoming', 'REQUESTED');
  const offers = useAssignments('outgoing', 'OFFERED');
  const timesheets = useTimesheets('payable', 'SUBMITTED');
  const available = useAvailableShifts();
  const openNow = (available.data ?? []).filter((s) => s.access.open).slice(0, 6);
  const surplus = (flags.data ?? []).filter((f) => f.kind === 'SURPLUS');
  const shortage = (flags.data ?? []).filter((f) => f.kind === 'SHORTAGE');

  return (
    <div className="space-y-5">
      <PageHeader title={`Good ${greeting()}, ${user?.firstName}`} description={`${organisation?.name} · last ${stats.data?.periodDays ?? 30} days`} actions={<><LinkButton to="/capacity" variant="secondary">⚑ Raise a capacity flag</LinkButton><LinkButton to="/shifts/new">＋ Post a shift</LinkButton></>} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Open shifts" value={stats.data?.shiftsOpen ?? '…'} hint="posted by you" to="/shifts/posted" />
        <StatCard label="Fill rate" value={stats.data?.fillRatePct != null ? `${stats.data.fillRatePct}%` : '—'} hint="of closed shifts" />
        <StatCard label="Shifts covered" value={stats.data?.shiftsSupplied ?? '…'} hint={`${fmtHours(stats.data?.hoursSupplied)} supplied`} to="/shifts/supplied" />
        <StatCard label="Approved spend" value={fmtMoney(stats.data?.approvedSpend)} tone="amber" to="/timesheets" />
        <StatCard label="Approved earnings" value={fmtMoney(stats.data?.approvedEarnings)} tone="green" to="/timesheets" />
        <StatCard label="Late cancellations" value={stats.data?.lateCancellations ?? '…'} tone={stats.data?.lateCancellations ? 'red' : 'slate'} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card
          title="Capacity flags"
          description="Tell the network when you have staff short of hours, or when you are short-staffed."
          actions={<LinkButton to="/capacity" size="sm" variant="secondary">Manage</LinkButton>}
          className="lg:col-span-1"
        >
          {flags.isLoading ? (
            <Loading />
          ) : (flags.data ?? []).length === 0 ? (
            <EmptyState title="No active flags" description="Raise a SURPLUS flag and your organisation gets first access to matching shifts." action={<LinkButton to="/capacity" size="sm">Raise a flag</LinkButton>} />
          ) : (
            <ul className="space-y-3">
              {[...surplus, ...shortage].map((f) => (
                <li key={f.id} className="rounded-lg border border-slate-100 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <StatusBadge status={f.kind} />
                    <span className="text-xs text-slate-500">until {fmtDate(f.endsAt)}</span>
                  </div>
                  <div className="mt-1 text-sm font-medium text-slate-800">{f.jobRole ? JOB_ROLE_LABELS[f.jobRole] : 'Any role'} · {f.headcount} staff</div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                    <Progress value={f.hoursFilled} max={f.hoursRequested} tone={f.kind === 'SURPLUS' ? 'brand' : 'amber'} />
                    <span className="whitespace-nowrap">{f.hoursRemaining}h left</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Needs your attention" className="lg:col-span-2">
          <AttentionList
            items={[
              ...(incoming.data ?? []).map((a) => ({ key: a.id, to: `/shifts/${a.shift.id}`, label: `${a.supplierName} put forward ${a.worker.firstName} ${a.worker.lastName}`, sub: `${a.shift.title} · ${fmtShiftWindow(a.shift.startsAt, a.shift.endsAt)}`, tag: 'Confirm or decline', tone: 'amber' as const })),
              ...(offers.data ?? []).map((a) => ({ key: a.id, to: `/shifts/${a.shift.id}`, label: `Offer for ${a.worker.firstName} ${a.worker.lastName}`, sub: `${a.shift.title} · ${fmtShiftWindow(a.shift.startsAt, a.shift.endsAt)} · ${fmtMoney(a.shift.chargeRate)}/h`, tag: 'Accept or decline', tone: 'violet' as const })),
              ...(timesheets.data ?? []).map((t) => ({ key: t.id, to: '/timesheets', label: `Timesheet from ${t.supplierName}: ${t.worker.firstName} ${t.worker.lastName}`, sub: `${t.shift.title} · ${fmtHours(t.paidHours)} · ${fmtMoney(t.hostCost)}`, tag: 'Approve', tone: 'blue' as const })),
            ]}
            loading={incoming.isLoading || offers.isLoading || timesheets.isLoading}
          />
        </Card>
      </div>

      <Card title="Shifts open to you now" actions={<LinkButton to="/shifts" size="sm" variant="secondary">Shift board</LinkButton>}>
        {available.isLoading ? <Loading /> : openNow.length === 0 ? <EmptyState title="Nothing open right now" description="Shifts you have priority access to will appear here the moment they are published." /> : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {openNow.map((s) => (
              <ShiftCard key={s.id} shift={s} compact />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function AttentionList({ items, loading }: { items: { key: string; to: string; label: string; sub: string; tag: string; tone: 'amber' | 'violet' | 'blue' }[]; loading: boolean }) {
  if (loading) return <Loading />;
  if (items.length === 0) return <EmptyState title="All clear" description="No requests, offers or timesheets are waiting on you." />;
  const tones = { amber: 'bg-amber-50 text-amber-800', violet: 'bg-violet-50 text-violet-800', blue: 'bg-sky-50 text-sky-800' };
  return (
    <ul className="divide-y divide-slate-100">
      {items.map((i) => (
        <li key={i.key}>
          <Link to={i.to} className="flex items-center justify-between gap-3 py-2.5 hover:bg-slate-50">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-slate-900">{i.label}</div>
              <div className="truncate text-xs text-slate-500">{i.sub}</div>
            </div>
            <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${tones[i.tone]}`}>{i.tag}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function AdminDashboard() {
  const overview = useQuery({ queryKey: ['admin-overview'], queryFn: () => api.get<AdminOverview>('/admin/overview') });
  const network = useNetworkCapacity();
  const incoming = useAssignments('incoming', 'REQUESTED');
  const offers = useAssignments('outgoing', 'OFFERED');
  const timesheets = useTimesheets('payable', 'SUBMITTED');
  const available = useAvailableShifts();
  const o = overview.data;
  const openNow = (available.data ?? []).filter((s) => s.access.open).slice(0, 6);
  return (
    <div className="space-y-5">
      <PageHeader title="Platform overview" description="Live picture of the whole network, last 30 days." actions={<><LinkButton to="/admin" variant="secondary">Platform settings</LinkButton><LinkButton to="/shifts/new">＋ Post a shift</LinkButton></>} />
      {overview.isLoading || !o ? <Loading /> : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
          <StatCard label="Organisations" value={o.organisations.active} hint={`${o.organisations.total} total`} to="/admin" />
          <StatCard label="Shareable workers" value={o.workers.shareable} hint={`${o.workers.total} on platform`} />
          <StatCard label="Open shifts" value={o.shifts.open} hint={`${o.shifts.postedLast30d} posted`} to="/admin" />
          <StatCard label="Fill rate" value={o.shifts.fillRatePct != null ? `${o.shifts.fillRatePct}%` : '—'} hint={`${o.shifts.urgentLast30d} urgent`} />
          <StatCard label="Surplus hours" value={o.capacity.surplusHours} hint={`${o.capacity.surplusOrgs} org(s) flagged`} tone="brand" to="/capacity" />
          <StatCard label="Shortage hours" value={o.capacity.shortageHours} hint={`${o.capacity.shortageOrgs} org(s) flagged`} tone="amber" to="/capacity" />
          <StatCard label="Charge approved" value={fmtMoney(o.money.approvedChargeLast30d)} hint={`${fmtMoney(o.money.platformFeeLast30d)} platform fee`} tone="green" />
          <StatCard label="Reliability" value={o.bookings.confirmedLast30d} hint={`${o.bookings.lateCancellationsLast30d} late cancels · ${o.bookings.noShowsLast30d} no-shows`} />
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Network supply & demand" description="Active capacity flags across all organisations.">
          <NetworkTable data={network.data} loading={network.isLoading} showOrgs />
        </Card>
        <Card title="Agency bank – needs attention">
          <AttentionList
            items={[
              ...(incoming.data ?? []).map((a) => ({ key: a.id, to: `/shifts/${a.shift.id}`, label: `${a.supplierName} put forward ${a.worker.firstName} ${a.worker.lastName}`, sub: a.shift.title, tag: 'Confirm or decline', tone: 'amber' as const })),
              ...(offers.data ?? []).map((a) => ({ key: a.id, to: `/shifts/${a.shift.id}`, label: `Offer for ${a.worker.firstName} ${a.worker.lastName}`, sub: a.shift.title, tag: 'Accept or decline', tone: 'violet' as const })),
              ...(timesheets.data ?? []).map((t) => ({ key: t.id, to: '/timesheets', label: `Timesheet: ${t.worker.firstName} ${t.worker.lastName}`, sub: t.shift.title, tag: 'Approve', tone: 'blue' as const })),
            ]}
            loading={incoming.isLoading || offers.isLoading || timesheets.isLoading}
          />
        </Card>
      </div>
      <Card title="Shifts open to the agency bank now" actions={<LinkButton to="/shifts" size="sm" variant="secondary">Shift board</LinkButton>}>
        {available.isLoading ? <Loading /> : openNow.length === 0 ? <EmptyState title="Nothing open to the bank right now" /> : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {openNow.map((s) => (
              <ShiftCard key={s.id} shift={s} compact />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

export function NetworkTable({ data, loading, showOrgs }: { data: import('../api/types').NetworkCapacity | undefined; loading: boolean; showOrgs?: boolean }) {
  if (loading || !data) return <Loading />;
  if (data.summary.length === 0) return <EmptyState title="No active flags on the network" />;
  return (
    <div className="space-y-4">
      <div className="-mx-4 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 text-left">Role</th>
              <th className="px-4 py-2 text-right">Surplus hours</th>
              <th className="px-4 py-2 text-right">Orgs</th>
              <th className="px-4 py-2 text-right">Shortage hours</th>
              <th className="px-4 py-2 text-right">Orgs</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.summary.map((r) => (
              <tr key={r.jobRole}>
                <td className="px-4 py-2 font-medium text-slate-800">{r.jobRole === 'ANY' ? 'Any role' : JOB_ROLE_LABELS[r.jobRole]}</td>
                <td className="px-4 py-2 text-right text-brand-700">{r.surplusHoursRemaining}h</td>
                <td className="px-4 py-2 text-right text-slate-500">{r.surplusOrgs}</td>
                <td className="px-4 py-2 text-right text-amber-700">{r.shortageHoursRemaining}h</td>
                <td className="px-4 py-2 text-right text-slate-500">{r.shortageOrgs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showOrgs && data.flags && data.flags.length > 0 && (
        <ul className="space-y-2">
          {data.flags.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <StatusBadge status={f.kind} />
                <span className="font-medium text-slate-800">{f.orgName}</span>
                <span className="text-slate-500">{f.jobRole ? JOB_ROLE_LABELS[f.jobRole] : 'Any role'}</span>
              </div>
              <div className="text-xs text-slate-500">
                {f.hoursRemaining}h of {f.hoursRequested}h left · until {fmtDate(f.endsAt)}
                {f.postcodeAreas?.length ? ` · ${f.postcodeAreas.join(', ')}` : ''}
                {f.radiusKm ? ` · ${f.radiusKm}km` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WorkerDashboard() {
  const { me } = useAuth();
  const available = useAvailableShifts();
  const supplied = useQuery({ queryKey: ['shifts', 'supplied'], queryFn: () => api.get<SuppliedShift[]>('/shifts', { scope: 'supplied' }) });
  const timesheets = useTimesheets('receivable');
  const openNow = (available.data ?? []).filter((s) => s.access.open);
  const selfService = me?.organisation.workerSelfServiceAllowed;
  return (
    <div className="space-y-5">
      <PageHeader title={`Hello, ${me?.user.firstName}`} description={me?.worker ? `${JOB_ROLE_LABELS[me.worker.jobRole]} · ${me.organisation.name}` : me?.organisation.name} />
      {!selfService && <Card><p className="text-sm text-slate-600">Your employer assigns shifts on your behalf. You can see your bookings and timesheets here; contact your manager to be put forward for a shift.</p></Card>}
      <Card title="My upcoming shifts" actions={<LinkButton to="/shifts/supplied" size="sm" variant="secondary">All</LinkButton>}>
        {supplied.isLoading ? <Loading /> : (supplied.data ?? []).length === 0 ? <EmptyState title="No shifts booked yet" /> : (
          <ul className="divide-y divide-slate-100">
            {(supplied.data ?? []).slice(0, 6).map((s) => (
              <li key={s.assignment.id}>
                <Link to={`/shifts/${s.id}`} className="flex items-center justify-between gap-3 py-2.5 hover:bg-slate-50">
                  <div>
                    <div className="text-sm font-medium text-slate-900">{s.title} · {s.hostName}</div>
                    <div className="text-xs text-slate-500">{fmtShiftWindow(s.startsAt, s.endsAt, s.breakMinutes)} · {s.site.name}, {s.site.postcode}</div>
                  </div>
                  <StatusBadge status={s.assignment.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {selfService && (
        <Card title="Shifts open to you now" actions={<LinkButton to="/shifts" size="sm" variant="secondary">Shift board</LinkButton>}>
          {available.isLoading ? <Loading /> : openNow.length === 0 ? <EmptyState title="Nothing open right now" /> : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {openNow.slice(0, 6).map((s) => (
                <ShiftCard key={s.id} shift={s} compact />
              ))}
            </div>
          )}
        </Card>
      )}
      <Card title="My timesheets" actions={<LinkButton to="/timesheets" size="sm" variant="secondary">All</LinkButton>}>
        {timesheets.isLoading ? <Loading /> : (timesheets.data ?? []).length === 0 ? <EmptyState title="No timesheets yet" /> : (
          <ul className="divide-y divide-slate-100">
            {(timesheets.data ?? []).slice(0, 5).map((t) => (
              <li key={t.id} className="flex items-center justify-between py-2 text-sm">
                <span>{t.shift.title} · {fmtDate(t.shift.startsAt)}</span>
                <span className="flex items-center gap-2 text-xs text-slate-500">{t.paidHours ? fmtHours(t.paidHours) : humanise(t.status)} <StatusBadge status={t.status} /></span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
}
