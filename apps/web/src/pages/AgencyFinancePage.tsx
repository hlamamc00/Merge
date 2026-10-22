import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import { useAction } from '../api/hooks';
import type { AgencyPnl, BankUtilisation, FinanceJobsResult } from '../api/types.finance';
import { Button, Card, ErrorBanner, Field, InfoBanner, Input, Loading, PageHeader, Progress, StatCard, Table } from '../components/ui';
import { fmtDate, fmtHours, fmtMoney } from '../lib/format';
import { defaultRange, downloadCsv, rangeParams } from './FinancePage';

export function AgencyFinancePage() {
  const [range, setRange] = useState(defaultRange());
  const params = rangeParams(range.from, range.to);
  const pnl = useQuery({ queryKey: ['agency-pnl', params], queryFn: () => api.get<AgencyPnl>('/finance/agency/pnl', params) });
  const util = useQuery({ queryKey: ['bank-utilisation', params], queryFn: () => api.get<BankUtilisation>('/finance/agency/bank-utilisation', params) });
  const [jobs, setJobs] = useState<FinanceJobsResult | null>(null);
  const runJobs = useAction(() => api.post<FinanceJobsResult>('/finance/jobs/run'), (r) => setJobs(r));
  const [dlError, setDlError] = useState<unknown>(null);
  const exportNetwork = (type: 'lines' | 'host-invoices' | 'remittances') => downloadCsv(`/finance/export.csv?type=${type}&from=${encodeURIComponent(params.from)}&to=${encodeURIComponent(params.to)}`, `merge-${type}-${range.from}-to-${range.to}.csv`).catch((e) => setDlError(e));
  const p = pnl.data;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Agency finance"
        description="Our margin as the platform owner: fees on third-party exchanges plus sales of our own bank, less what we pay our bank workers. Utilisation shows whether contracted bank hours are being sold."
        actions={<Button variant="secondary" onClick={() => runJobs.mutate()} loading={runJobs.isPending}>Run overdue checks now</Button>}
      />
      {jobs && <InfoBanner tone="blue">Overdue checks: {jobs.markedOverdue} invoice(s) marked overdue · {jobs.reminders} reminder(s) sent · {jobs.holdsApplied} credit hold(s) applied · {jobs.holdsCleared} released.</InfoBanner>}
      <Card>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="From"><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
          <Field label="To"><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
          <div className="col-span-2 flex flex-wrap items-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => void exportNetwork('lines')}>Export lines CSV</Button>
            <Button size="sm" variant="ghost" onClick={() => void exportNetwork('host-invoices')}>Export invoices CSV</Button>
            <Button size="sm" variant="ghost" onClick={() => void exportNetwork('remittances')}>Export remittances CSV</Button>
          </div>
        </div>
        <ErrorBanner error={dlError ?? runJobs.error} className="mt-3" />
      </Card>

      <Card title="Profit and loss" description={p?.note}>
        <ErrorBanner error={pnl.error} className="mb-3" />
        {pnl.isLoading || !p ? <Loading /> : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <StatCard label="Platform fees" value={fmtMoney(p.revenue.platformFees)} hint={`${fmtHours(p.hours.thirdParty)} third-party`} />
              <StatCard label="Agency sales" value={fmtMoney(p.revenue.agencySales)} hint={`${fmtHours(p.hours.agencyBank)} own bank`} />
              <StatCard label="Revenue" value={fmtMoney(p.revenue.total)} tone="brand" />
              <StatCard label="Bank worker pay" value={`−${fmtMoney(p.costOfSales.bankWorkerPay)}`} tone="amber" />
              <StatCard label="Gross margin" value={fmtMoney(p.grossMargin)} hint={p.grossMarginPct != null ? `${p.grossMarginPct}% of revenue` : undefined} tone={p.grossMargin >= 0 ? 'green' : 'red'} />
            </div>
            <Table
              rows={p.byClient}
              rowKey={(c) => c.hostOrgId}
              empty={<p className="py-4 text-sm text-slate-500">No approved timesheets in this range.</p>}
              columns={[
                { key: 'host', header: 'Client (host)', render: (c) => <span className="font-medium text-slate-900">{c.hostName}</span> },
                { key: 'tp', header: 'Third-party charges', align: 'right', render: (c) => fmtMoney(c.thirdPartyCharge) },
                { key: 'fees', header: 'Our fees', align: 'right', render: (c) => fmtMoney(c.platformFees) },
                { key: 'sales', header: 'Agency sales', align: 'right', render: (c) => <div>{fmtMoney(c.agencySales)}<div className="text-xs text-slate-400">{fmtHours(c.agencyHours)}</div></div> },
                { key: 'pay', header: 'Bank pay', align: 'right', render: (c) => `−${fmtMoney(c.bankPay)}` },
                { key: 'margin', header: 'Margin', align: 'right', render: (c) => <span className={c.margin >= 0 ? 'font-semibold text-emerald-700' : 'font-semibold text-rose-700'}>{fmtMoney(c.margin)}</span> },
              ]}
            />
          </div>
        )}
      </Card>

      <Card title="Bank utilisation" description={util.data ? `Hours sold against contracted hours over ${util.data.weeks} week(s). Zero-hours workers have no target and are listed by hours alone.` : undefined}>
        <ErrorBanner error={util.error} className="mb-3" />
        {util.isLoading ? <Loading /> : (
          <Table
            rows={util.data?.rows ?? []}
            rowKey={(r) => r.workerId}
            empty={<p className="py-4 text-sm text-slate-500">No bank workers yet. Add workers to the agency organisation with an hourly pay rate and contracted hours.</p>}
            columns={[
              { key: 'name', header: 'Worker', render: (r) => <div className="font-medium text-slate-900">{r.name}<div className="text-xs font-normal text-slate-500">{r.jobRole.replace(/_/g, ' ').toLowerCase()} · {r.status.toLowerCase()}</div></div> },
              { key: 'contract', header: 'Contracted / wk', align: 'right', render: (r) => (r.contractedHoursPerWeek != null ? fmtHours(r.contractedHoursPerWeek) : <span className="text-slate-400">zero-hours</span>) },
              { key: 'worked', header: 'Worked', align: 'right', render: (r) => <div>{fmtHours(r.hoursWorked)}<div className="text-xs text-slate-400">{r.shifts} shift(s)</div></div> },
              { key: 'util', header: 'Utilisation', render: (r) => (r.utilisationPct == null ? <span className="text-xs text-slate-400">n/a</span> : <div className="w-36"><div className="mb-1 text-xs">{r.utilisationPct}% of {fmtHours(r.availableHours)}</div><Progress value={Math.min(r.utilisationPct, 100)} max={100} tone={r.utilisationPct >= 70 ? 'green' : r.utilisationPct >= 40 ? 'amber' : 'red'} /></div>) },
              { key: 'last', header: 'Last shift', render: (r) => (r.lastShiftAt ? fmtDate(r.lastShiftAt) : <span className="text-slate-400">never</span>) },
              { key: 'idle', header: 'Idle', align: 'right', render: (r) => (r.idleDays == null ? '–' : <span className={r.idleDays > 14 ? 'font-medium text-rose-700' : ''}>{r.idleDays}d</span>) },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
