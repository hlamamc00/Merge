import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { JOB_ROLE_LABELS } from '@merge/shared';
import { api } from '../api/client';
import { useAction, useAssignments } from '../api/hooks';
import type { AssignmentListItem } from '../api/types';
import type { BulkResult, PostedShiftPlus } from '../api/types.dispatch';
import { StatusBadge, TierBadge, UrgentBadge } from '../components/badges';
import { Badge, Button, Card, Checkbox, EmptyState, ErrorBanner, Field, InfoBanner, LinkButton, Loading, Modal, PageHeader, Table, Tabs, Textarea } from '../components/ui';
import { fmtDateTime, fmtMoney, fmtShiftWindow } from '../lib/format';

export function PostedShiftsPage() {
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [params, setParams] = useSearchParams();
  const seriesFilter = params.get('seriesId') ?? '';
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['shifts', 'posted', tab], queryFn: () => api.get<PostedShiftPlus[]>('/shifts', { scope: 'posted', includePast: tab === 'past' }) });
  const all = q.data ?? [];
  const rows = all
    .filter((s) => (tab === 'past' ? new Date(s.endsAt).getTime() < Date.now() : true))
    .filter((s) => !seriesFilter || s.seriesId === seriesFilter)
    .sort((a, b) => (tab === 'past' ? b.startsAt.localeCompare(a.startsAt) : a.startsAt.localeCompare(b.startsAt)));
  const series = useMemo(() => {
    const map = new Map<string, PostedShiftPlus[]>();
    for (const s of all) if (s.seriesId) map.set(s.seriesId, [...(map.get(s.seriesId) ?? []), s]);
    return [...map.entries()].filter(([, list]) => list.length > 1).map(([id, list]) => ({ id, shifts: list.sort((a, b) => a.startsAt.localeCompare(b.startsAt)) }));
  }, [all]);
  const needAttention = rows.filter((s) => s.escalationDue).length;

  return (
    <div className="space-y-5">
      <PageHeader title="Posted shifts" description="Shifts your organisation needs covered." actions={<LinkButton to="/shifts/new">＋ Post a shift</LinkButton>} />
      {needAttention > 0 && tab === 'upcoming' && <InfoBanner tone="amber">{needAttention} open shift{needAttention === 1 ? '' : 's'} start within 48 hours with places still unfilled. Open them to escalate: raise the rate or release to every organisation at once.</InfoBanner>}
      <PendingRequestsPanel />
      {series.length > 0 && tab === 'upcoming' && <SeriesPanel series={series} active={seriesFilter} onFilter={(id) => setParams(id ? { seriesId: id } : {})} />}
      <Card>
        <Tabs tabs={[{ value: 'upcoming', label: 'Upcoming' }, { value: 'past', label: 'Past' }]} value={tab} onChange={setTab} />
        {seriesFilter && <div className="mb-2 text-xs text-slate-500">Showing one series only. <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => setParams({})}>Show all</button></div>}
        <ErrorBanner error={q.error} />
        {q.isLoading ? <Loading /> : (
          <Table
            rows={rows}
            rowKey={(s) => s.id}
            onRowClick={(s) => navigate(`/shifts/${s.id}`)}
            columns={[
              {
                key: 'title',
                header: 'Shift',
                render: (s) => (
                  <div>
                    <div className="flex flex-wrap items-center gap-1.5 font-medium text-slate-900">
                      {s.title} <UrgentBadge urgent={s.urgent} />
                      {s.seriesId && <Badge tone="violet">Series</Badge>}
                      {s.escalationDue && <Badge tone="amber">Needs attention</Badge>}
                    </div>
                    <div className="text-xs text-slate-500">{JOB_ROLE_LABELS[s.jobRole]} · {s.site.name}</div>
                  </div>
                ),
              },
              { key: 'when', header: 'When', render: (s) => fmtShiftWindow(s.startsAt, s.endsAt, s.breakMinutes) },
              { key: 'rate', header: 'Rate', align: 'right', render: (s) => `${fmtMoney(s.chargeRate)}/h` },
              { key: 'filled', header: 'Filled', render: (s) => <span>{s.filledCount}/{s.headcount}</span> },
              { key: 'pending', header: 'Requests', render: (s) => (s.pendingRequests > 0 ? <Badge tone="amber">{s.pendingRequests} waiting</Badge> : <span className="text-slate-400">—</span>) },
              { key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
            ]}
          />
        )}
      </Card>
    </div>
  );
}

/** DSP-02: answer many requests at once. */
function PendingRequestsPanel() {
  const q = useAssignments('incoming', 'REQUESTED');
  const [selected, setSelected] = useState<string[]>([]);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState<BulkResult['results'] | null>(null);
  const bulk = useAction(
    (args: { action: 'confirm' | 'decline'; reason?: string }) => api.post<BulkResult>('/assignments/bulk', { ids: selected, action: args.action, reason: args.reason || null }),
    (r) => {
      setOutcome(r.results);
      setSelected([]);
      setDeclining(false);
      setReason('');
    },
  );
  const rows = (q.data ?? []).filter((a) => new Date(a.shift.startsAt).getTime() > Date.now()).sort((a, b) => a.shift.startsAt.localeCompare(b.shift.startsAt));
  if (q.isLoading || rows.length === 0) return null;
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const allSelected = selected.length === rows.length;
  const failures = (outcome ?? []).filter((r) => !r.ok);
  return (
    <Card
      title={`Pending requests (${rows.length})`}
      description="Workers put forward by other organisations, across all your shifts. Tick several and answer them together."
      actions={
        <div className="flex gap-1.5">
          <Button size="sm" variant="success" disabled={selected.length === 0} loading={bulk.isPending} onClick={() => bulk.mutate({ action: 'confirm' })}>Confirm {selected.length || ''}</Button>
          <Button size="sm" variant="secondary" disabled={selected.length === 0} onClick={() => setDeclining(true)}>Decline {selected.length || ''}</Button>
        </div>
      }
    >
      <ErrorBanner error={bulk.error} className="mb-3" />
      {outcome && (
        <InfoBanner tone={failures.length ? 'amber' : 'green'} className="mb-3">
          {outcome.length - failures.length} done{failures.length ? `, ${failures.length} failed: ${failures.map((f) => f.error).join('; ')}` : '.'}
        </InfoBanner>
      )}
      <Table<AssignmentListItem>
        rows={rows}
        rowKey={(a) => a.id}
        columns={[
          { key: 'pick', header: <Checkbox label="" checked={allSelected} onChange={() => setSelected(allSelected ? [] : rows.map((r) => r.id))} aria-label="Select all" />, render: (a) => <Checkbox label="" checked={selected.includes(a.id)} onChange={() => toggle(a.id)} aria-label={`Select ${a.worker.firstName}`} /> },
          { key: 'worker', header: 'Worker', render: (a) => <div className="font-medium text-slate-900">{a.worker.firstName} {a.worker.lastName}<div className="text-xs font-normal text-slate-500">{JOB_ROLE_LABELS[a.worker.jobRole]} · {a.supplierName}</div></div> },
          { key: 'shift', header: 'Shift', render: (a) => <Link className="text-brand-700 hover:underline" to={`/shifts/${a.shift.id}`}>{a.shift.title}<div className="text-xs text-slate-500">{a.shift.siteName} · {fmtShiftWindow(a.shift.startsAt, a.shift.endsAt)}</div></Link> },
          { key: 'via', header: 'Via', render: (a) => <TierBadge tier={a.tierAtRequest} /> },
          { key: 'asked', header: 'Requested', render: (a) => <span className="text-xs text-slate-500">{fmtDateTime(a.requestedAt)}{a.note && <> · “{a.note}”</>}</span> },
        ]}
      />
      <Modal open={declining} onClose={() => setDeclining(false)} title={`Decline ${selected.length} request${selected.length === 1 ? '' : 's'}`} footer={<><Button variant="secondary" onClick={() => setDeclining(false)}>Back</Button><Button variant="danger" loading={bulk.isPending} onClick={() => bulk.mutate({ action: 'decline', reason })}>Decline</Button></>}>
        <Field label="Reason (optional, shared with the suppliers)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
    </Card>
  );
}

/** PR-05: recurring postings grouped by series. */
function SeriesPanel({ series, active, onFilter }: { series: { id: string; shifts: PostedShiftPlus[] }[]; active: string; onFilter: (id: string | null) => void }) {
  const [cancelFor, setCancelFor] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const cancel = useAction((id: string) => api.post(`/shifts/series/${id}/cancel`, { reason: reason || null }), () => { setCancelFor(null); setReason(''); });
  return (
    <Card title="Recurring postings" description="Shifts posted together from one pattern. Each one is managed on its own; cancel the series to cancel every one that has not started.">
      <ErrorBanner error={cancel.error} className="mb-3" />
      {series.length === 0 ? <EmptyState title="No series" /> : (
        <ul className="divide-y divide-slate-100">
          {series.map((s) => {
            const live = s.shifts.filter((x) => ['DRAFT', 'OPEN', 'FILLED'].includes(x.status));
            const filled = s.shifts.reduce((n, x) => n + x.filledCount, 0);
            const places = s.shifts.reduce((n, x) => n + x.headcount, 0);
            const first = s.shifts[0]!;
            return (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-slate-900">{first.title}</span>
                    <Badge tone="violet">{s.shifts.length} shifts</Badge>
                    <span className="text-xs text-slate-500">{JOB_ROLE_LABELS[first.jobRole]} · {first.site.name}</span>
                  </div>
                  <div className="text-xs text-slate-500">
                    {fmtDateTime(first.startsAt)} → {fmtDateTime(s.shifts[s.shifts.length - 1]!.startsAt)} · {filled}/{places} places filled · {live.length} still live
                  </div>
                </div>
                <div className="flex gap-1.5">
                  <Button size="sm" variant={active === s.id ? 'primary' : 'secondary'} onClick={() => onFilter(active === s.id ? null : s.id)}>{active === s.id ? 'Showing' : 'Show only'}</Button>
                  {live.length > 0 && <Button size="sm" variant="danger" onClick={() => setCancelFor(s.id)}>Cancel series</Button>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Modal open={!!cancelFor} onClose={() => setCancelFor(null)} title="Cancel the whole series?" footer={<><Button variant="secondary" onClick={() => setCancelFor(null)}>Keep</Button><Button variant="danger" loading={cancel.isPending} onClick={() => cancelFor && cancel.mutate(cancelFor)}>Cancel series</Button></>}>
        <p className="mb-3 text-sm text-slate-600">Every shift in the series that has not started will be cancelled and confirmed workers released. Shifts already in progress or completed are untouched.</p>
        <Field label="Reason (shared with suppliers)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
    </Card>
  );
}
