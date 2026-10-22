import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import { useAction } from '../api/hooks';
import type { Credit, FinanceSummary, HostInvoice, HostInvoiceDetail, Remittance, RemittanceDetail, SettlementLine, SettlementRunResult } from '../api/types.finance';
import { useAuth } from '../auth/AuthContext';
import { StatusBadge } from '../components/badges';
import { Badge, Button, Card, DescriptionList, Drawer, ErrorBanner, Field, InfoBanner, Input, Loading, Modal, PageHeader, Select, StatCard, Table, Tabs, Textarea } from '../components/ui';
import { fmtDate, fmtHours, fmtMoney, fmtShiftWindow, toDateInput } from '../lib/format';
import { downloadCsv } from './FinancePage';

type Tab = 'invoices' | 'remittances' | 'credits' | 'lines';
const DAY = 86_400_000;

function daysOverdue(inv: HostInvoice): number {
  return Math.max(0, Math.floor((Date.now() - new Date(inv.dueAt).getTime()) / DAY));
}

function InvoiceStatusBadge({ inv }: { inv: HostInvoice }) {
  if (inv.status === 'OVERDUE') return <Badge tone="red">Overdue {daysOverdue(inv)}d</Badge>;
  if (inv.status === 'ISSUED') {
    const left = Math.ceil((new Date(inv.dueAt).getTime() - Date.now()) / DAY);
    return <Badge tone={left <= 7 ? 'amber' : 'blue'}>{left < 0 ? 'Due' : `Due in ${left}d`}</Badge>;
  }
  return <StatusBadge status={inv.status} />;
}

export function StatementsPage() {
  const { isPlatformAdmin } = useAuth();
  const [tab, setTab] = useState<Tab>('invoices');
  const [openInvoice, setOpenInvoice] = useState<string | null>(null);
  const [openRemittance, setOpenRemittance] = useState<string | null>(null);
  const [run, setRun] = useState(false);
  const [payFor, setPayFor] = useState<{ kind: 'host-invoices' | 'remittances'; id: string; number: string; total: number } | null>(null);
  const [dlError, setDlError] = useState<unknown>(null);
  const summary = useQuery({ queryKey: ['finance-summary'], queryFn: () => api.get<FinanceSummary>('/finance/summary') });
  const invoices = useQuery({ queryKey: ['host-invoices'], queryFn: () => api.get<HostInvoice[]>('/finance/host-invoices') });
  const remittances = useQuery({ queryKey: ['remittances'], queryFn: () => api.get<Remittance[]>('/finance/remittances') });
  const credits = useQuery({ queryKey: ['credits', isPlatformAdmin ? 'all' : 'payable'], queryFn: () => api.get<Credit[]>('/finance/credits', { scope: isPlatformAdmin ? 'all' : 'payable' }) });
  const lines = useQuery({ queryKey: ['invoices', 'all'], queryFn: () => api.get<SettlementLine[]>('/invoices', { scope: 'all' }), enabled: isPlatformAdmin && tab === 'lines' });
  const download = (path: string, name: string) => downloadCsv(path, name).catch((e) => setDlError(e));

  const tabs: { value: Tab; label: string; count?: number }[] = [
    { value: 'invoices', label: isPlatformAdmin ? 'Host invoices' : 'Invoices we pay', count: invoices.data?.filter((i) => i.status !== 'PAID' && i.status !== 'VOID').length },
    { value: 'remittances', label: isPlatformAdmin ? 'Supplier remittances' : 'Remittances to us', count: remittances.data?.filter((r) => r.status === 'ISSUED').length },
    { value: 'credits', label: isPlatformAdmin ? 'Credit queue' : 'Our credits', count: credits.data?.filter((c) => c.status === 'REQUESTED').length },
  ];
  if (isPlatformAdmin) tabs.push({ value: 'lines', label: 'Settlement lines' });
  const s = summary.data;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Statements"
        description={isPlatformAdmin ? 'Hosts pay the platform one invoice a period; the platform pays each supplier one remittance. Supply from our own bank is our own sale.' : 'Invoices for the cover you booked (payable to the platform) and remittances for the staff you lent (paid by the platform). Query a line to request a credit.'}
        actions={isPlatformAdmin && <Button onClick={() => setRun(true)}>Run settlement</Button>}
      />
      {s?.creditHold && <InfoBanner tone="red">Posting is paused: invoices are more than 30 days overdue. New shifts can be published again once they are paid.</InfoBanner>}
      {s && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label={isPlatformAdmin ? 'Outstanding from hosts' : 'Outstanding'} value={fmtMoney(s.outstanding)} />
          <StatCard label="Overdue" value={fmtMoney(s.overdue)} hint={s.overdueCount ? `${s.overdueCount} invoice(s)` : undefined} tone={s.overdue ? 'red' : 'slate'} />
          <StatCard label={isPlatformAdmin ? 'Remittances to pay' : 'Remittances due to us'} value={fmtMoney(s.remittancesDue)} tone="brand" />
          <StatCard label="Credits awaiting decision" value={s.pendingCredits} tone={s.pendingCredits ? 'amber' : 'slate'} />
        </div>
      )}
      <Card>
        <Tabs tabs={tabs} value={tab} onChange={setTab} />
        <ErrorBanner error={dlError ?? invoices.error ?? remittances.error ?? credits.error ?? lines.error} className="mb-3" />
        {tab === 'invoices' && (invoices.isLoading ? <Loading /> : (
          <Table
            rows={invoices.data ?? []}
            rowKey={(i) => i.id}
            onRowClick={(i) => setOpenInvoice(i.id)}
            empty={<p className="py-6 text-center text-sm text-slate-500">No invoices yet. They are issued by the settlement run at the end of each period.</p>}
            columns={[
              { key: 'number', header: 'Invoice', render: (i) => <span className="font-mono text-xs font-medium text-slate-900">{i.number}</span> },
              ...(isPlatformAdmin ? [{ key: 'host', header: 'Host', render: (i: HostInvoice) => i.hostName }] : []),
              { key: 'period', header: 'Period', render: (i) => `${fmtDate(i.periodStart)} – ${fmtDate(i.periodEnd)}` },
              { key: 'issued', header: 'Issued', render: (i) => fmtDate(i.issuedAt) },
              { key: 'due', header: 'Due', render: (i) => <div>{fmtDate(i.dueAt)}<div className="mt-0.5"><InvoiceStatusBadge inv={i} /></div></div> },
              { key: 'subtotal', header: 'Charges', align: 'right', render: (i) => fmtMoney(i.subtotal) },
              { key: 'credits', header: 'Credits', align: 'right', render: (i) => (i.credits ? <span className="text-emerald-700">−{fmtMoney(i.credits)}</span> : '–') },
              { key: 'total', header: 'Total', align: 'right', render: (i) => <span className="font-semibold">{fmtMoney(i.total)}</span> },
              { key: 'status', header: 'Status', render: (i) => <div><StatusBadge status={i.status} />{i.paymentReference && <div className="text-xs text-slate-500">ref {i.paymentReference}</div>}</div> },
              { key: 'actions', header: '', align: 'right', render: (i) => (
                <span className="flex justify-end gap-1">
                  <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); void download(`/finance/host-invoices/${i.id}/export.csv`, `${i.number}.csv`); }}>CSV</Button>
                  {isPlatformAdmin && (i.status === 'ISSUED' || i.status === 'OVERDUE') && <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); setPayFor({ kind: 'host-invoices', id: i.id, number: i.number, total: i.total }); }}>Mark paid</Button>}
                </span>
              ) },
            ]}
          />
        ))}
        {tab === 'remittances' && (remittances.isLoading ? <Loading /> : (
          <Table
            rows={remittances.data ?? []}
            rowKey={(r) => r.id}
            onRowClick={(r) => setOpenRemittance(r.id)}
            empty={<p className="py-6 text-center text-sm text-slate-500">No remittances yet. One is issued per period for the shifts your staff covered.</p>}
            columns={[
              { key: 'number', header: 'Remittance', render: (r) => <span className="font-mono text-xs font-medium text-slate-900">{r.number}</span> },
              ...(isPlatformAdmin ? [{ key: 'supplier', header: 'Supplier', render: (r: Remittance) => r.supplierName }] : []),
              { key: 'period', header: 'Period', render: (r) => `${fmtDate(r.periodStart)} – ${fmtDate(r.periodEnd)}` },
              { key: 'issued', header: 'Issued', render: (r) => fmtDate(r.issuedAt) },
              { key: 'amount', header: 'Earned', align: 'right', render: (r) => fmtMoney(r.amount) },
              { key: 'credits', header: 'Credits', align: 'right', render: (r) => (r.credits ? <span className="text-rose-700">−{fmtMoney(r.credits)}</span> : '–') },
              { key: 'total', header: 'Paid to supplier', align: 'right', render: (r) => <span className="font-semibold">{fmtMoney(r.total)}</span> },
              { key: 'status', header: 'Status', render: (r) => <div><StatusBadge status={r.status} />{r.paidAt && <div className="text-xs text-slate-500">{fmtDate(r.paidAt)}{r.paymentReference && ` · ${r.paymentReference}`}</div>}</div> },
              { key: 'actions', header: '', align: 'right', render: (r) => (
                <span className="flex justify-end gap-1">
                  <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); void download(`/finance/remittances/${r.id}/export.csv`, `${r.number}.csv`); }}>CSV</Button>
                  {isPlatformAdmin && r.status === 'ISSUED' && <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); setPayFor({ kind: 'remittances', id: r.id, number: r.number, total: r.total }); }}>Mark paid</Button>}
                </span>
              ) },
            ]}
          />
        ))}
        {tab === 'credits' && <CreditsTable credits={credits.data ?? []} loading={credits.isLoading} />}
        {tab === 'lines' && (lines.isLoading ? <Loading /> : (
          <Table
            rows={lines.data ?? []}
            rowKey={(l) => l.id}
            columns={[
              { key: 'number', header: 'Line', render: (l) => <span className="font-mono text-xs">{l.number}</span> },
              { key: 'parties', header: 'Host → Supplier', render: (l) => <span>{l.hostName} → {l.supplierName}{l.agencySale && <Badge tone="brand" className="ml-1">Agency sale</Badge>}</span> },
              { key: 'period', header: 'Period', render: (l) => `${fmtDate(l.periodStart)} – ${fmtDate(l.periodEnd)}` },
              { key: 'hours', header: 'Hours', align: 'right', render: (l) => fmtHours(l.totalHours) },
              { key: 'subtotal', header: 'Host pays', align: 'right', render: (l) => fmtMoney(l.subtotal) },
              { key: 'fee', header: 'Platform fee', align: 'right', render: (l) => fmtMoney(l.platformFee) },
              { key: 'supplier', header: 'Supplier receives', align: 'right', render: (l) => fmtMoney(l.supplierAmount) },
              { key: 'docs', header: 'Rolled into', render: (l) => <span className="text-xs text-slate-500">{l.hostInvoiceId ? 'invoice' : 'not yet'}{l.remittanceId ? ' · remittance' : ''}</span> },
              { key: 'status', header: 'Status', render: (l) => <StatusBadge status={l.status} /> },
            ]}
          />
        ))}
      </Card>
      <HostInvoiceDrawer id={openInvoice} onClose={() => setOpenInvoice(null)} />
      <RemittanceDrawer id={openRemittance} onClose={() => setOpenRemittance(null)} />
      {isPlatformAdmin && <RunSettlementModal open={run} onClose={() => setRun(false)} />}
      {payFor && <MarkPaidModal target={payFor} onClose={() => setPayFor(null)} />}
    </div>
  );
}

function CreditsTable({ credits, loading }: { credits: Credit[]; loading: boolean }) {
  const { isPlatformAdmin } = useAuth();
  const [decide, setDecide] = useState<{ credit: Credit; decision: 'approve' | 'reject' } | null>(null);
  const [note, setNote] = useState('');
  const act = useAction((a: { id: string; decision: 'approve' | 'reject' }) => api.post(`/finance/credits/${a.id}/${a.decision}`, { note: note || null }), () => { setDecide(null); setNote(''); });
  if (loading) return <Loading />;
  return (
    <>
      <ErrorBanner error={act.error} className="mb-3" />
      <Table
        rows={credits}
        rowKey={(c) => c.id}
        empty={<p className="py-6 text-center text-sm text-slate-500">{isPlatformAdmin ? 'No credit requests. Hosts raise them from an invoice line.' : 'No credits. Open an invoice and query a line to request one.'}</p>}
        columns={[
          { key: 'line', header: 'Statement line', render: (c) => <span className="font-mono text-xs">{c.lineNumber}</span> },
          { key: 'parties', header: 'Host / supplier', render: (c) => <div>{c.hostName}<div className="text-xs text-slate-500">{c.supplierName}</div></div> },
          { key: 'amount', header: 'Amount', align: 'right', render: (c) => <span className="font-medium">{fmtMoney(c.amount)}</span> },
          { key: 'reason', header: 'Reason', render: (c) => <span className="text-xs text-slate-600">{c.reason}</span> },
          { key: 'when', header: 'Requested', render: (c) => <div>{fmtDate(c.createdAt)}{c.decidedAt && <div className="text-xs text-slate-500">decided {fmtDate(c.decidedAt)}</div>}</div> },
          { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
          { key: 'actions', header: '', align: 'right', render: (c) => isPlatformAdmin && c.status === 'REQUESTED' && (
            <span className="flex justify-end gap-1">
              <Button size="sm" variant="success" onClick={() => setDecide({ credit: c, decision: 'approve' })}>Approve</Button>
              <Button size="sm" variant="ghost" onClick={() => setDecide({ credit: c, decision: 'reject' })}>Reject</Button>
            </span>
          ) },
        ]}
      />
      <Modal open={!!decide} onClose={() => setDecide(null)} title={decide?.decision === 'approve' ? `Approve credit of ${fmtMoney(decide?.credit.amount)}` : `Reject credit of ${fmtMoney(decide?.credit.amount)}`} footer={<><Button variant="secondary" onClick={() => setDecide(null)}>Back</Button><Button variant={decide?.decision === 'approve' ? 'success' : 'danger'} onClick={() => decide && act.mutate({ id: decide.credit.id, decision: decide.decision })} loading={act.isPending}>{decide?.decision === 'approve' ? 'Approve' : 'Reject'}</Button></>}>
        <p className="mb-3 text-sm text-slate-600">{decide?.decision === 'approve' ? 'The host pays less on its next invoice and the supplier receives proportionately less on its next remittance; the platform forgoes its fee share.' : 'The host is told the query was not upheld.'}</p>
        <Field label="Note to the host (optional)"><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Modal>
    </>
  );
}

function HostInvoiceDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { isPlatformAdmin } = useAuth();
  const q = useQuery({ queryKey: ['host-invoice', id], queryFn: () => api.get<HostInvoiceDetail>(`/finance/host-invoices/${id}`), enabled: !!id });
  const [queryLine, setQueryLine] = useState<HostInvoiceDetail['lines'][number] | null>(null);
  const inv = q.data;
  return (
    <Drawer open={!!id} onClose={onClose} title={inv ? `Invoice ${inv.number}` : 'Invoice'}>
      {q.isLoading || !inv ? <Loading /> : (
        <div className="space-y-4">
          <DescriptionList items={[{ label: 'Host', value: inv.hostName }, { label: 'Period', value: `${fmtDate(inv.periodStart)} – ${fmtDate(inv.periodEnd)}` }, { label: 'Issued', value: fmtDate(inv.issuedAt) }, { label: 'Due', value: <span>{fmtDate(inv.dueAt)} <InvoiceStatusBadge inv={inv} /></span> }, { label: 'Status', value: <StatusBadge status={inv.status} /> }, { label: 'Paid', value: inv.paidAt ? `${fmtDate(inv.paidAt)}${inv.paymentReference ? ` · ${inv.paymentReference}` : ''}` : '–' }]} />
          <div className="grid grid-cols-3 gap-2 text-center text-sm">
            <div className="rounded-lg bg-slate-50 p-2"><div className="text-xs text-slate-500">Charges</div><div className="font-semibold">{fmtMoney(inv.subtotal)}</div></div>
            <div className="rounded-lg bg-emerald-50 p-2"><div className="text-xs text-emerald-700">Credits</div><div className="font-semibold text-emerald-800">−{fmtMoney(inv.credits)}</div></div>
            <div className="rounded-lg bg-brand-50 p-2"><div className="text-xs text-brand-700">Total payable</div><div className="font-semibold text-brand-800">{fmtMoney(inv.total)}</div></div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => void downloadCsv(`/finance/host-invoices/${inv.id}/export.csv`, `${inv.number}.csv`)}>Download CSV for accounts</Button>
          </div>
          {inv.lines.map((line) => (
            <Card key={line.id} title={<span>{line.supplierName} <span className="ml-1 font-mono text-xs font-normal text-slate-500">{line.number}</span>{line.agencySale && <Badge tone="brand" className="ml-2">Agency bank</Badge>}</span>} actions={!isPlatformAdmin && <Button size="sm" variant="ghost" onClick={() => setQueryLine(line)}>Query this line</Button>}>
              <Table
                rows={line.timesheets}
                rowKey={(t) => t.id}
                columns={[
                  { key: 'shift', header: 'Shift', render: (t) => <div>{t.shiftTitle}<div className="text-xs text-slate-500">{t.siteName} · {fmtShiftWindow(t.shiftStartsAt, t.shiftEndsAt)}</div></div> },
                  { key: 'worker', header: 'Worker', render: (t) => t.workerName },
                  { key: 'hours', header: 'Hours', align: 'right', render: (t) => fmtHours(t.paidHours) },
                  { key: 'rate', header: 'Rate', align: 'right', render: (t) => `${fmtMoney(t.chargeRate)}/h` },
                  { key: 'cost', header: 'Charge', align: 'right', render: (t) => fmtMoney(t.hostCost) },
                ]}
              />
              <div className="mt-2 text-right text-sm font-medium">{fmtHours(line.totalHours)} · {fmtMoney(line.subtotal)}</div>
            </Card>
          ))}
          {inv.appliedCredits.length > 0 && (
            <Card title="Credits applied">
              <ul className="space-y-1 text-sm">
                {inv.appliedCredits.map((c) => <li key={c.id} className="flex justify-between gap-3"><span className="text-slate-600">{c.reason}</span><span className="font-medium text-emerald-700">−{fmtMoney(c.amount)}</span></li>)}
              </ul>
            </Card>
          )}
        </div>
      )}
      {queryLine && <CreditRequestModal line={queryLine} onClose={() => setQueryLine(null)} />}
    </Drawer>
  );
}

function CreditRequestModal({ line, onClose }: { line: HostInvoiceDetail['lines'][number]; onClose: () => void }) {
  const [form, setForm] = useState({ timesheetId: '', amount: '', reason: '' });
  const ts = line.timesheets.find((t) => t.id === form.timesheetId);
  const max = ts ? ts.hostCost : line.subtotal;
  const req = useAction(() => api.post<Credit>('/finance/credits', { invoiceId: line.id, timesheetId: form.timesheetId || null, amount: Number(form.amount), reason: form.reason }), onClose);
  return (
    <Modal open onClose={onClose} title={`Query line ${line.number}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => req.mutate()} loading={req.isPending} disabled={!form.amount || !form.reason}>Request credit</Button></>}>
      <div className="space-y-3">
        <ErrorBanner error={req.error} />
        <p className="text-sm text-slate-600">The platform reviews the query with the supplier. An approved credit is deducted from your next invoice.</p>
        <Field label="Timesheet (optional)">
          <Select value={form.timesheetId} onChange={(e) => setForm({ ...form, timesheetId: e.target.value })}>
            <option value="">Whole line</option>
            {line.timesheets.map((t) => <option key={t.id} value={t.id}>{t.workerName} · {fmtDate(t.shiftStartsAt)} · {fmtMoney(t.hostCost)}</option>)}
          </Select>
        </Field>
        <Field label={`Amount (up to ${fmtMoney(max)})`} required><Input type="number" min="0.01" step="0.01" max={max} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
        <Field label="Reason" required><Textarea value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. worker left 90 minutes early; agreed with their manager on the day" /></Field>
      </div>
    </Modal>
  );
}

function RemittanceDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['remittance', id], queryFn: () => api.get<RemittanceDetail>(`/finance/remittances/${id}`), enabled: !!id });
  const rem = q.data;
  return (
    <Drawer open={!!id} onClose={onClose} title={rem ? `Remittance ${rem.number}` : 'Remittance'}>
      {q.isLoading || !rem ? <Loading /> : (
        <div className="space-y-4">
          <DescriptionList items={[{ label: 'Supplier', value: rem.supplierName }, { label: 'Period', value: `${fmtDate(rem.periodStart)} – ${fmtDate(rem.periodEnd)}` }, { label: 'Issued', value: fmtDate(rem.issuedAt) }, { label: 'Status', value: <StatusBadge status={rem.status} /> }, { label: 'Paid', value: rem.paidAt ? `${fmtDate(rem.paidAt)}${rem.paymentReference ? ` · ${rem.paymentReference}` : ''}` : '–' }]} />
          <div className="grid grid-cols-3 gap-2 text-center text-sm">
            <div className="rounded-lg bg-slate-50 p-2"><div className="text-xs text-slate-500">Earned</div><div className="font-semibold">{fmtMoney(rem.amount)}</div></div>
            <div className="rounded-lg bg-rose-50 p-2"><div className="text-xs text-rose-700">Credits</div><div className="font-semibold text-rose-800">−{fmtMoney(rem.credits)}</div></div>
            <div className="rounded-lg bg-brand-50 p-2"><div className="text-xs text-brand-700">Paid to you</div><div className="font-semibold text-brand-800">{fmtMoney(rem.total)}</div></div>
          </div>
          <Button size="sm" variant="secondary" onClick={() => void downloadCsv(`/finance/remittances/${rem.id}/export.csv`, `${rem.number}.csv`)}>Download CSV</Button>
          {rem.lines.map((line) => (
            <Card key={line.id} title={<span>{line.hostName} <span className="ml-1 font-mono text-xs font-normal text-slate-500">{line.number}</span></span>}>
              <Table
                rows={line.timesheets}
                rowKey={(t) => t.id}
                columns={[
                  { key: 'shift', header: 'Shift', render: (t) => <div>{t.shiftTitle}<div className="text-xs text-slate-500">{t.siteName} · {fmtShiftWindow(t.shiftStartsAt, t.shiftEndsAt)}</div></div> },
                  { key: 'worker', header: 'Worker', render: (t) => t.workerName },
                  { key: 'hours', header: 'Hours', align: 'right', render: (t) => fmtHours(t.paidHours) },
                  { key: 'charge', header: 'Charge', align: 'right', render: (t) => fmtMoney(t.hostCost) },
                  { key: 'fee', header: 'Fee', align: 'right', render: (t) => fmtMoney(t.platformFee) },
                  { key: 'you', header: 'To you', align: 'right', render: (t) => <span className="font-medium">{fmtMoney(t.supplierAmount)}</span> },
                ]}
              />
            </Card>
          ))}
          {rem.appliedCredits.length > 0 && (
            <Card title="Credits deducted">
              <ul className="space-y-1 text-sm">
                {rem.appliedCredits.map((c) => <li key={c.id} className="flex justify-between gap-3"><span className="text-slate-600">{c.reason}</span><span className="font-medium text-rose-700">−{fmtMoney(c.amount)} (your share pro rata)</span></li>)}
              </ul>
            </Card>
          )}
        </div>
      )}
    </Drawer>
  );
}

function MarkPaidModal({ target, onClose }: { target: { kind: 'host-invoices' | 'remittances'; id: string; number: string; total: number }; onClose: () => void }) {
  const [reference, setReference] = useState('');
  const pay = useAction(() => api.post(`/finance/${target.kind}/${target.id}/mark-paid`, { reference: reference || null }), onClose);
  return (
    <Modal open onClose={onClose} title={`Mark ${target.number} paid`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => pay.mutate()} loading={pay.isPending}>Confirm {fmtMoney(target.total)} {target.kind === 'host-invoices' ? 'received' : 'sent'}</Button></>}>
      <div className="space-y-3">
        <ErrorBanner error={pay.error} />
        <Field label="Payment reference (optional)"><Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="BACS reference" /></Field>
      </div>
    </Modal>
  );
}

function RunSettlementModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const now = new Date();
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const [form, setForm] = useState({ periodStart: toDateInput(lastMonthStart), periodEnd: toDateInput(lastMonthEnd) });
  const [result, setResult] = useState<SettlementRunResult | null>(null);
  // Both bounds are built in the browser's local frame and the end is exclusive (midnight after the last day),
  // so consecutive periods tile exactly with no gap or overlap across clock changes.
  const run = useAction(() => {
    const start = new Date(`${form.periodStart}T00:00:00`);
    const end = new Date(`${form.periodEnd}T00:00:00`);
    end.setDate(end.getDate() + 1);
    return api.post<SettlementRunResult>('/finance/run', { periodStart: start.toISOString(), periodEnd: end.toISOString() });
  }, (r) => setResult(r));
  const close = () => { setResult(null); onClose(); };
  return (
    <Modal open={open} onClose={close} title="Run settlement" footer={<><Button variant="secondary" onClick={close}>Close</Button><Button onClick={() => run.mutate()} loading={run.isPending}>Run</Button></>}>
      <div className="space-y-3">
        <ErrorBanner error={run.error} />
        <p className="text-sm text-slate-600">Every approved, un-invoiced timesheet for shifts up to the period end becomes a settlement line. One invoice is issued per host (due in 30 days) and one remittance per supplier; approved credits are deducted. Supply from our own bank is recorded as our own sale with no platform fee.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Period start"><Input type="date" value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })} /></Field>
          <Field label="Period end (inclusive)"><Input type="date" value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} /></Field>
        </div>
        {result && (
          <InfoBanner tone={result.hostInvoices.length ? 'green' : 'slate'}>
            {result.lines.length ? `${result.lines.length} line(s) · ${result.hostInvoices.length} invoice(s) totalling ${fmtMoney(result.hostInvoices.reduce((s, i) => s + i.total, 0))} · ${result.remittances.length} remittance(s) totalling ${fmtMoney(result.remittances.reduce((s, r) => s + r.total, 0))}` : 'Nothing to settle: no approved, un-invoiced timesheets up to that date.'}
          </InfoBanner>
        )}
      </div>
    </Modal>
  );
}
