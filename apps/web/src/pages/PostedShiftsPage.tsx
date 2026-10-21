import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { JOB_ROLE_LABELS } from '@merge/shared';
import { api } from '../api/client';
import type { PostedShift } from '../api/types';
import { StatusBadge, UrgentBadge } from '../components/badges';
import { Badge, Card, ErrorBanner, LinkButton, Loading, PageHeader, Table, Tabs } from '../components/ui';
import { fmtMoney, fmtShiftWindow } from '../lib/format';

export function PostedShiftsPage() {
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['shifts', 'posted', tab], queryFn: () => api.get<PostedShift[]>('/shifts', { scope: 'posted', includePast: tab === 'past' }) });
  const rows = (q.data ?? []).filter((s) => (tab === 'past' ? new Date(s.endsAt).getTime() < Date.now() : true)).sort((a, b) => (tab === 'past' ? b.startsAt.localeCompare(a.startsAt) : a.startsAt.localeCompare(b.startsAt)));
  return (
    <div className="space-y-5">
      <PageHeader title="Posted shifts" description="Shifts your organisation needs covered." actions={<LinkButton to="/shifts/new">＋ Post a shift</LinkButton>} />
      <Card>
        <Tabs tabs={[{ value: 'upcoming', label: 'Upcoming' }, { value: 'past', label: 'Past' }]} value={tab} onChange={setTab} />
        <ErrorBanner error={q.error} />
        {q.isLoading ? <Loading /> : (
          <Table
            rows={rows}
            rowKey={(s) => s.id}
            onRowClick={(s) => navigate(`/shifts/${s.id}`)}
            columns={[
              { key: 'title', header: 'Shift', render: (s) => <div><div className="font-medium text-slate-900">{s.title} <UrgentBadge urgent={s.urgent} /></div><div className="text-xs text-slate-500">{JOB_ROLE_LABELS[s.jobRole]} · {s.site.name}</div></div> },
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
