import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { JOB_ROLE_LABELS, type JobRole } from '@merge/shared';
import { api } from '../api/client';
import { useAction } from '../api/hooks';
import { REPORT_CATEGORY_LABELS, type Reliability, type WorkerBar, type WorkerReport } from '../api/types.dispatch';
import { useAuth } from '../auth/AuthContext';
import { StatusBadge } from '../components/badges';
import { Badge, Button, Card, DescriptionList, EmptyState, ErrorBanner, Field, InfoBanner, Loading, Modal, PageHeader, StatCard, Table, Tabs, Textarea } from '../components/ui';
import { fmtDate, fmtDateTime } from '../lib/format';

type Tab = 'reliability' | 'bars' | 'reports';

export function TrustPage() {
  const { isWorker } = useAuth();
  const [tab, setTab] = useState<Tab>('reliability');
  if (isWorker) return <WorkerTrustPage />;
  return (
    <div className="space-y-5">
      <PageHeader title="Trust" description="Your organisation's reliability record, workers barred by hosts, and concerns raised about lent workers." />
      <Tabs tabs={[{ value: 'reliability', label: 'Reliability' }, { value: 'bars', label: 'Barred workers' }, { value: 'reports', label: 'Reports' }]} value={tab} onChange={setTab} />
      {tab === 'reliability' && <ReliabilityPanel />}
      {tab === 'bars' && <BarsPanel />}
      {tab === 'reports' && <ReportsPanel />}
    </div>
  );
}

function ReliabilityPanel() {
  const { organisation } = useAuth();
  const q = useQuery({ queryKey: ['reliability', organisation?.id], queryFn: () => api.get<Reliability>(`/trust/reliability/${organisation!.id}`), enabled: !!organisation });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBanner error={q.error} />;
  const r = q.data;
  const penalised = !!r.priorityPenaltyUntil && new Date(r.priorityPenaltyUntil).getTime() > Date.now();
  return (
    <div className="space-y-4">
      {penalised && <InfoBanner tone="amber">Priority access is suspended until {fmtDate(r.priorityPenaltyUntil)} after repeated no-shows. Your surplus flags do not give first access until then. Another no-show may lead to suspension from the network.</InfoBanner>}
      {r.status === 'SUSPENDED' && <InfoBanner tone="red">Your organisation is suspended from the network. Contact the platform to discuss reinstatement.</InfoBanner>}
      <div className="grid gap-3 sm:grid-cols-4">
        <StatCard label="Reliability score" value={`${r.score}/100`} tone={r.score >= 85 ? 'green' : r.score >= 60 ? 'amber' : 'red'} hint={`Last ${r.windowDays} days`} />
        <StatCard label="No-shows" value={r.noShows} tone={r.noShows === 0 ? 'green' : 'red'} hint="Recorded by hosts" />
        <StatCard label="Late cancellations" value={r.lateCancellations} tone={r.lateCancellations === 0 ? 'green' : 'amber'} />
        <StatCard label="Bookings honoured" value={r.confirmedOrCompleted} tone="slate" />
      </div>
      <Card title="How this is used">
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
          <li>Hosts see your score and no-show count next to each of your workers when they search for cover.</li>
          <li>No-shows are a disciplinary matter for you as the employer. The platform counts them per organisation over a rolling {r.windowDays}-day window.</li>
          <li>Repeated no-shows first remove priority access from your surplus flags, then suspend the organisation until the platform reinstates it.</li>
        </ul>
      </Card>
    </div>
  );
}

function BarsPanel() {
  const q = useQuery({ queryKey: ['bars'], queryFn: () => api.get<WorkerBar[]>('/trust/bars') });
  const lift = useAction((id: string) => api.delete(`/trust/bars/${id}`));
  const rows = q.data ?? [];
  const asHost = rows.filter((b) => b.role === 'host');
  const asEmployer = rows.filter((b) => b.role === 'employer');
  return (
    <div className="space-y-4">
      <ErrorBanner error={q.error ?? lift.error} />
      <Card title="Workers you have barred" description="They cannot be put forward for your shifts. Bar a worker from their booking on the shift page.">
        {q.isLoading ? <Loading /> : asHost.length === 0 ? <EmptyState title="No barred workers" /> : (
          <Table
            rows={asHost}
            rowKey={(b) => b.id}
            columns={[
              { key: 'worker', header: 'Worker', render: (b) => <div className="font-medium text-slate-900">{b.worker.firstName} {b.worker.lastName}<div className="text-xs font-normal text-slate-500">{JOB_ROLE_LABELS[b.worker.jobRole as JobRole] ?? b.worker.jobRole}</div></div> },
              { key: 'scope', header: 'Scope', render: (b) => (b.siteName ? b.siteName : <Badge>All sites</Badge>) },
              { key: 'reason', header: 'Reason', render: (b) => <span className="text-sm text-slate-700">{b.reason}{b.shared && <Badge tone="blue" className="ml-2">Shared with employer</Badge>}</span> },
              { key: 'since', header: 'Since', render: (b) => fmtDate(b.createdAt) },
              { key: 'act', header: '', align: 'right', render: (b) => <Button size="sm" variant="secondary" loading={lift.isPending} onClick={() => lift.mutate(b.id)}>Lift bar</Button> },
            ]}
          />
        )}
      </Card>
      <Card title="Your workers barred by hosts" description="Hosts may decline to take a named worker again. The reason is shown only when the host chose to share it.">
        {q.isLoading ? <Loading /> : asEmployer.length === 0 ? <EmptyState title="None of your workers are barred" /> : (
          <Table
            rows={asEmployer}
            rowKey={(b) => b.id}
            columns={[
              { key: 'worker', header: 'Worker', render: (b) => <Link className="font-medium text-brand-700 hover:underline" to={`/workers/${b.worker.id}`}>{b.worker.firstName} {b.worker.lastName}</Link> },
              { key: 'host', header: 'Host', render: (b) => <span>{b.hostName}{b.siteName ? <span className="text-xs text-slate-500"> · {b.siteName}</span> : ''}</span> },
              { key: 'reason', header: 'Reason', render: (b) => (b.reason ? b.reason : <span className="text-xs text-slate-400">Not shared</span>) },
              { key: 'since', header: 'Since', render: (b) => fmtDate(b.createdAt) },
            ]}
          />
        )}
      </Card>
    </div>
  );
}

function ReportsPanel() {
  const { isPlatformAdmin } = useAuth();
  const [scope, setScope] = useState<'received' | 'raised' | 'all'>('received');
  const q = useQuery({ queryKey: ['reports', scope], queryFn: () => api.get<WorkerReport[]>('/trust/reports', { scope }) });
  const [closing, setClosing] = useState<WorkerReport | null>(null);
  const [response, setResponse] = useState('');
  const [open, setOpen] = useState<WorkerReport | null>(null);
  const ack = useAction((id: string) => api.post(`/trust/reports/${id}/acknowledge`));
  const close = useAction((id: string) => api.post(`/trust/reports/${id}/close`, { employerResponse: response }), () => { setClosing(null); setResponse(''); });
  const rows = q.data ?? [];
  const tabs: { value: 'received' | 'raised' | 'all'; label: string }[] = [
    { value: 'received', label: 'About our workers' },
    { value: 'raised', label: 'Raised by us' },
    ...(isPlatformAdmin ? [{ value: 'all' as const, label: 'All (platform)' }] : []),
  ];
  return (
    <div className="space-y-4">
      <ErrorBanner error={q.error ?? ack.error ?? close.error} />
      <Card
        title="Reports"
        description="A host raises a concern about a lent worker; the employer handles it under its own frameworks and records the outcome. Safeguarding reports are also seen by the platform."
      >
        <Tabs tabs={tabs} value={scope} onChange={setScope} />
        {q.isLoading ? <Loading /> : rows.length === 0 ? <EmptyState title="No reports" /> : (
          <Table
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => setOpen(r)}
            columns={[
              { key: 'when', header: 'Raised', render: (r) => fmtDateTime(r.createdAt) },
              { key: 'worker', header: 'Worker', render: (r) => <div className="font-medium text-slate-900">{r.worker.firstName} {r.worker.lastName}<div className="text-xs font-normal text-slate-500">{scope === 'raised' ? `employed by ${r.supplierName}` : `at ${r.hostName}`}</div></div> },
              { key: 'cat', header: 'Category', render: (r) => <Badge tone={r.category === 'SAFEGUARDING' ? 'red' : 'slate'}>{REPORT_CATEGORY_LABELS[r.category]}</Badge> },
              { key: 'desc', header: 'Concern', render: (r) => <span className="line-clamp-2 text-sm text-slate-700">{r.description}</span> },
              { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
              {
                key: 'act',
                header: '',
                align: 'right',
                render: (r) =>
                  scope !== 'raised' && r.status !== 'CLOSED' ? (
                    <span className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                      {r.status === 'OPEN' && <Button size="sm" variant="secondary" loading={ack.isPending} onClick={() => ack.mutate(r.id)}>Acknowledge</Button>}
                      <Button size="sm" onClick={() => setClosing(r)}>Record outcome</Button>
                    </span>
                  ) : null,
              },
            ]}
          />
        )}
      </Card>
      <Modal open={!!open} onClose={() => setOpen(null)} title={open ? `${REPORT_CATEGORY_LABELS[open.category]} concern about ${open.worker.firstName} ${open.worker.lastName}` : ''}>
        {open && (
          <DescriptionList
            items={[
              { label: 'Raised by', value: `${open.hostName}${open.raisedBy ? ` (${open.raisedBy})` : ''} on ${fmtDateTime(open.createdAt)}` },
              { label: 'Employer', value: open.supplierName },
              { label: 'Status', value: <StatusBadge status={open.status} /> },
              { label: 'Concern', value: <span className="whitespace-pre-line">{open.description}</span> },
              { label: 'Employer response', value: open.employerResponse ? <span className="whitespace-pre-line">{open.employerResponse}</span> : <span className="text-slate-400">Not yet recorded</span> },
            ]}
          />
        )}
      </Modal>
      <Modal open={!!closing} onClose={() => setClosing(null)} title="Record the outcome" footer={<><Button variant="secondary" onClick={() => setClosing(null)}>Back</Button><Button loading={close.isPending} disabled={response.trim().length < 5} onClick={() => closing && close.mutate(closing.id)}>Close report</Button></>}>
        <p className="mb-3 text-sm text-slate-600">Your response is shared with the host that raised the concern. Say what you did under your own procedures (investigation, retraining, disciplinary action) without personal data beyond what is needed.</p>
        <Field label="Outcome" required><Textarea value={response} onChange={(e) => setResponse(e.target.value)} rows={5} /></Field>
      </Modal>
    </div>
  );
}

function WorkerTrustPage() {
  const q = useQuery({ queryKey: ['my-bars'], queryFn: () => api.get<{ id: string; hostName: string; createdAt: string }[]>('/trust/me/bars') });
  return (
    <div className="space-y-5">
      <PageHeader title="Trust" description="Where you stand with the organisations you have worked for." />
      <Card title="Organisations that will not take you again">
        {q.isLoading ? <Loading /> : (q.data ?? []).length === 0 ? <EmptyState title="None" description="Every host you have worked for will take you again." /> : (
          <ul className="divide-y divide-slate-100 text-sm">
            {(q.data ?? []).map((b) => (
              <li key={b.id} className="flex justify-between py-2"><span>{b.hostName}</span><span className="text-xs text-slate-500">since {fmtDate(b.createdAt)}</span></li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-slate-500">Reasons are shared with your employer, not through the platform. Speak to your manager if you think a bar is unfair.</p>
      </Card>
    </div>
  );
}
