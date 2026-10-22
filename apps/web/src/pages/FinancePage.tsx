import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, getToken } from '../api/client';
import type { Credit, ReportResult } from '../api/types.finance';
import { useAuth } from '../auth/AuthContext';
import { StatusBadge } from '../components/badges';
import { Button, Card, ErrorBanner, Field, InfoBanner, Input, Loading, PageHeader, Select, StatCard, Table, Tabs } from '../components/ui';
import { fmtDate, fmtHours, fmtMoney, toDateInput } from '../lib/format';

/** Fetch an authenticated CSV endpoint and hand it to the browser as a download. */
export async function downloadCsv(path: string, filename: string): Promise<void> {
  const res = await fetch(`/api/v1${path}`, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  saveBlob(await res.blob(), filename);
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function rowsToCsv(rows: Array<Array<string | number | null | undefined>>): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Date-only inputs become a half-open [from, to) range in the browser's local frame. */
export function rangeParams(from: string, to: string): { from: string; to: string } {
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function defaultRange(): { from: string; to: string } {
  const now = new Date();
  return { from: toDateInput(new Date(now.getFullYear(), now.getMonth() - 2, 1)), to: toDateInput(now) };
}

type Report = 'spend' | 'earnings';
const GROUPS: Record<Report, Array<{ value: string; label: string }>> = {
  spend: [{ value: 'site', label: 'Site' }, { value: 'supplier', label: 'Supplier' }, { value: 'month', label: 'Month' }],
  earnings: [{ value: 'host', label: 'Host' }, { value: 'worker', label: 'Worker' }, { value: 'month', label: 'Month' }],
};

export function FinancePage() {
  const { me } = useAuth();
  const [report, setReport] = useState<Report>('spend');
  const [groupBy, setGroupBy] = useState('site');
  const [range, setRange] = useState(defaultRange());
  const params = { ...rangeParams(range.from, range.to), groupBy };
  const q = useQuery({ queryKey: ['finance-report', report, params], queryFn: () => api.get<ReportResult>(`/finance/${report}`, params) });
  const credits = useQuery({ queryKey: ['credits', 'payable'], queryFn: () => api.get<Credit[]>('/finance/credits', { scope: 'payable' }) });
  const switchReport = (r: Report) => {
    setReport(r);
    setGroupBy(GROUPS[r][0]!.value);
  };
  const groupLabel = GROUPS[report].find((g) => g.value === groupBy)?.label ?? groupBy;
  const exportRows = () => {
    const rows = q.data?.rows ?? [];
    saveBlob(new Blob([rowsToCsv([[groupLabel, 'Shifts', 'Hours', report === 'spend' ? 'Spend' : 'Earnings'], ...rows.map((r) => [r.label, r.shifts, r.hours, r.amount]), ['Total', q.data?.totals.shifts ?? 0, q.data?.totals.hours ?? 0, q.data?.totals.amount ?? 0]])], { type: 'text/csv' }), `${report}-by-${groupBy}-${range.from}-to-${range.to}.csv`);
  };
  const isSpend = report === 'spend';
  return (
    <div className="space-y-5">
      <PageHeader title="Finance" description={`What ${me?.organisation?.name ?? 'your organisation'} has spent on cover and earned from lending staff, from approved timesheets. Invoices and remittances are under Statements.`} />
      <Card>
        <Tabs tabs={[{ value: 'spend', label: 'Spend (shifts we hosted)' }, { value: 'earnings', label: 'Earnings (shifts we covered)' }]} value={report} onChange={switchReport} />
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="From"><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
          <Field label="To"><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
          <Field label="Group by">
            <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
              {GROUPS[report].map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
            </Select>
          </Field>
          <div className="flex items-end"><Button variant="secondary" onClick={exportRows} disabled={!q.data?.rows.length}>Download CSV</Button></div>
        </div>
        <ErrorBanner error={q.error} className="mb-3" />
        {q.data && (
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard label={isSpend ? 'Total spend' : 'Total earnings'} value={fmtMoney(q.data.totals.amount)} tone="brand" />
            <StatCard label="Hours" value={fmtHours(q.data.totals.hours)} />
            <StatCard label="Shifts" value={q.data.totals.shifts} />
          </div>
        )}
        {q.isLoading ? <Loading /> : (
          <Table
            rows={q.data?.rows ?? []}
            rowKey={(r) => r.key}
            empty={<p className="py-6 text-center text-sm text-slate-500">No approved timesheets in this range.</p>}
            columns={[
              { key: 'label', header: groupLabel, render: (r) => <span className="font-medium text-slate-900">{r.label}</span> },
              { key: 'shifts', header: 'Shifts', align: 'right', render: (r) => r.shifts },
              { key: 'hours', header: 'Hours', align: 'right', render: (r) => fmtHours(r.hours) },
              { key: 'amount', header: isSpend ? 'Spend' : 'Earnings', align: 'right', render: (r) => <span className="font-medium">{fmtMoney(r.amount)}</span> },
              { key: 'avg', header: 'Avg £/h', align: 'right', render: (r) => (r.hours ? fmtMoney(r.amount / r.hours) : '–') },
            ]}
          />
        )}
      </Card>
      <Card title="Credits we have requested" description="Queries raised on statement lines. Approved credits come off the next invoice.">
        <ErrorBanner error={credits.error} className="mb-3" />
        {credits.isLoading ? <Loading /> : (
          <Table
            rows={credits.data ?? []}
            rowKey={(c) => c.id}
            empty={<p className="py-4 text-sm text-slate-500">No credits requested. Open an invoice under Statements to query a line.</p>}
            columns={[
              { key: 'line', header: 'Statement line', render: (c) => <span className="font-mono text-xs">{c.lineNumber}</span> },
              { key: 'supplier', header: 'Supplier', render: (c) => c.supplierName },
              { key: 'amount', header: 'Amount', align: 'right', render: (c) => fmtMoney(c.amount) },
              { key: 'reason', header: 'Reason', render: (c) => <span className="text-xs text-slate-600">{c.reason}</span> },
              { key: 'requested', header: 'Requested', render: (c) => fmtDate(c.createdAt) },
              { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
            ]}
          />
        )}
        {credits.data?.some((c) => c.status === 'APPROVED') && <InfoBanner tone="green" className="mt-3">Approved credits are deducted automatically on the next settlement run.</InfoBanner>}
      </Card>
    </div>
  );
}
