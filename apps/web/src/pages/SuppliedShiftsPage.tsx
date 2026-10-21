import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { JOB_ROLE_LABELS } from '@merge/shared';
import { api } from '../api/client';
import type { SuppliedShift } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { StatusBadge, TierBadge } from '../components/badges';
import { Card, ErrorBanner, Loading, PageHeader, Table, Tabs } from '../components/ui';
import { fmtMoney, fmtShiftWindow } from '../lib/format';

export function SuppliedShiftsPage() {
  const { isWorker } = useAuth();
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['shifts', 'supplied', tab], queryFn: () => api.get<SuppliedShift[]>('/shifts', { scope: 'supplied', includePast: tab === 'past' }) });
  const rows = (q.data ?? []).filter((s) => (tab === 'past' ? new Date(s.endsAt).getTime() < Date.now() : true)).sort((a, b) => (tab === 'past' ? b.startsAt.localeCompare(a.startsAt) : a.startsAt.localeCompare(b.startsAt)));
  return (
    <div className="space-y-5">
      <PageHeader title={isWorker ? 'My shifts' : 'Shifts we cover'} description={isWorker ? 'Shifts you have requested or been booked on.' : 'Shifts at other organisations that your workers have requested or been booked on.'} />
      <Card>
        <Tabs tabs={[{ value: 'upcoming', label: 'Upcoming' }, { value: 'past', label: 'Past' }]} value={tab} onChange={setTab} />
        <ErrorBanner error={q.error} />
        {q.isLoading ? <Loading /> : (
          <Table
            rows={rows}
            rowKey={(s) => s.assignment.id}
            onRowClick={(s) => navigate(`/shifts/${s.id}`)}
            columns={[
              { key: 'worker', header: 'Worker', render: (s) => <div className="font-medium text-slate-900">{s.worker.firstName} {s.worker.lastName}<div className="text-xs font-normal text-slate-500">{JOB_ROLE_LABELS[s.worker.jobRole]}</div></div> },
              { key: 'shift', header: 'Shift', render: (s) => <div>{s.title}<div className="text-xs text-slate-500">{s.hostName} · {s.site.name}, {s.site.postcode}</div></div> },
              { key: 'when', header: 'When', render: (s) => fmtShiftWindow(s.startsAt, s.endsAt, s.breakMinutes) },
              { key: 'rate', header: 'Rate', align: 'right', render: (s) => `${fmtMoney(s.chargeRate)}/h` },
              { key: 'tier', header: 'Via', render: (s) => <TierBadge tier={s.assignment.tierAtRequest} /> },
              { key: 'status', header: 'Status', render: (s) => <span className="flex flex-col gap-1"><StatusBadge status={s.assignment.status} />{s.assignment.lateCancellation && <span className="text-xs text-rose-600">late</span>}</span> },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
