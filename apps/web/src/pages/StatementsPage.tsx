import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import { useAction } from '../api/hooks';
import type { Invoice, InvoiceDetail } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { StatusBadge } from '../components/badges';
import { Button, Card, DescriptionList, Drawer, ErrorBanner, Field, InfoBanner, Input, Loading, Modal, PageHeader, Table, Tabs } from '../components/ui';
import { fmtDate, fmtHours, fmtMoney, fmtShiftWindow, toDateInput } from '../lib/format';

type Tab = 'payable' | 'receivable' | 'all';

export function StatementsPage() {
  const { isPlatformAdmin } = useAuth();
  const [tab, setTab] = useState<Tab>(isPlatformAdmin ? 'all' : 'payable');
  const [openId, setOpenId] = useState<string | null>(null);
  const [gen, setGen] = useState(false);
  const q = useQuery({ queryKey: ['invoices', tab], queryFn: () => api.get<Invoice[]>('/invoices', { scope: tab }) });
  const markPaid = useAction((id: string) => api.post(`/invoices/${id}/mark-paid`));
  const tabs = isPlatformAdmin ? [{ value: 'all' as Tab, label: 'All statements' }, { value: 'payable' as Tab, label: 'Agency payable' }, { value: 'receivable' as Tab, label: 'Agency receivable' }] : [{ value: 'payable' as Tab, label: 'Payable (we hosted)' }, { value: 'receivable' as Tab, label: 'Receivable (we covered)' }];
  return (
    <div className="space-y-5">
      <PageHeader title="Statements" description="Approved timesheets rolled up per host / supplier pair. The host pays the subtotal; the platform keeps its fee; the supplier receives the balance." actions={<Button onClick={() => setGen(true)}>Generate statements</Button>} />
      <Card>
        <Tabs tabs={tabs} value={tab} onChange={setTab} />
        <ErrorBanner error={q.error ?? markPaid.error} className="mb-3" />
        {q.isLoading ? <Loading /> : (
          <Table
            rows={q.data ?? []}
            rowKey={(i) => i.id}
            onRowClick={(i) => setOpenId(i.id)}
            columns={[
              { key: 'number', header: 'Statement', render: (i) => <span className="font-mono text-xs font-medium text-slate-900">{i.number}</span> },
              { key: 'period', header: 'Period', render: (i) => `${fmtDate(i.periodStart)} – ${fmtDate(i.periodEnd)}` },
              { key: 'parties', header: 'Host → Supplier', render: (i) => <span>{i.hostName} → {i.supplierName}</span> },
              { key: 'hours', header: 'Hours', align: 'right', render: (i) => fmtHours(i.totalHours) },
              { key: 'subtotal', header: 'Host pays', align: 'right', render: (i) => fmtMoney(i.subtotal) },
              { key: 'fee', header: 'Platform fee', align: 'right', render: (i) => fmtMoney(i.platformFee) },
              { key: 'supplier', header: 'Supplier receives', align: 'right', render: (i) => fmtMoney(i.supplierAmount) },
              { key: 'status', header: 'Status', render: (i) => <StatusBadge status={i.status} /> },
              { key: 'actions', header: '', align: 'right', render: (i) => i.status === 'ISSUED' && <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); markPaid.mutate(i.id); }} loading={markPaid.isPending}>Mark paid</Button> },
            ]}
          />
        )}
      </Card>
      <StatementDrawer id={openId} onClose={() => setOpenId(null)} />
      <GenerateModal open={gen} onClose={() => setGen(false)} />
    </div>
  );
}

function StatementDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<InvoiceDetail>(`/invoices/${id}`), enabled: !!id });
  const inv = q.data;
  return (
    <Drawer open={!!id} onClose={onClose} title={inv ? `Statement ${inv.number}` : 'Statement'}>
      {q.isLoading || !inv ? <Loading /> : (
        <div className="space-y-4">
          <DescriptionList items={[{ label: 'Host (pays)', value: inv.hostName }, { label: 'Supplier (receives)', value: inv.supplierName }, { label: 'Period', value: `${fmtDate(inv.periodStart)} – ${fmtDate(inv.periodEnd)}` }, { label: 'Status', value: <StatusBadge status={inv.status} /> }, { label: 'Issued', value: fmtDate(inv.issuedAt) }, { label: 'Paid', value: fmtDate(inv.paidAt) }]} />
          <div className="grid grid-cols-3 gap-2 text-center text-sm">
            <div className="rounded-lg bg-slate-50 p-2"><div className="text-xs text-slate-500">Host pays</div><div className="font-semibold">{fmtMoney(inv.subtotal)}</div></div>
            <div className="rounded-lg bg-slate-50 p-2"><div className="text-xs text-slate-500">Platform fee</div><div className="font-semibold">{fmtMoney(inv.platformFee)}</div></div>
            <div className="rounded-lg bg-brand-50 p-2"><div className="text-xs text-brand-700">Supplier receives</div><div className="font-semibold text-brand-800">{fmtMoney(inv.supplierAmount)}</div></div>
          </div>
          <Table
            rows={inv.lines}
            rowKey={(l) => l.id}
            columns={[
              { key: 'shift', header: 'Shift', render: (l) => <div>{l.shift.title}<div className="text-xs text-slate-500">{fmtShiftWindow(l.shift.startsAt, l.shift.endsAt)}</div></div> },
              { key: 'worker', header: 'Worker', render: (l) => `${l.worker.firstName} ${l.worker.lastName}` },
              { key: 'hours', header: 'Hours', align: 'right', render: (l) => fmtHours(l.paidHours) },
              { key: 'rate', header: 'Rate', align: 'right', render: (l) => `${fmtMoney(l.chargeRate)}/h` },
              { key: 'cost', header: 'Charge', align: 'right', render: (l) => fmtMoney(l.hostCost) },
              { key: 'supplier', header: 'Supplier', align: 'right', render: (l) => fmtMoney(l.supplierAmount) },
            ]}
          />
        </div>
      )}
    </Drawer>
  );
}

function GenerateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { isPlatformAdmin } = useAuth();
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [form, setForm] = useState({ periodStart: toDateInput(monthStart), periodEnd: toDateInput(now) });
  const [result, setResult] = useState<Invoice[] | null>(null);
  // Both bounds are built in the browser's local frame and the end is exclusive (midnight after the last day),
  // so consecutive periods tile exactly with no gap or overlap across clock changes.
  const gen = useAction(() => {
    const start = new Date(`${form.periodStart}T00:00:00`);
    const end = new Date(`${form.periodEnd}T00:00:00`);
    end.setDate(end.getDate() + 1);
    return api.post<Invoice[]>('/invoices/generate', { periodStart: start.toISOString(), periodEnd: end.toISOString() });
  }, (r) => setResult(r));
  return (
    <Modal open={open} onClose={() => { setResult(null); onClose(); }} title="Generate statements" footer={<><Button variant="secondary" onClick={() => { setResult(null); onClose(); }}>Close</Button><Button onClick={() => gen.mutate()} loading={gen.isPending}>Generate</Button></>}>
      <div className="space-y-3">
        <ErrorBanner error={gen.error} />
        <p className="text-sm text-slate-600">{isPlatformAdmin ? 'Creates one statement per host / supplier pair for every approved, un-invoiced timesheet in the period.' : 'Creates statements for approved, un-invoiced timesheets on shifts you hosted in the period.'}</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Period start"><Input type="date" value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })} /></Field>
          <Field label="Period end"><Input type="date" value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} /></Field>
        </div>
        {result && <InfoBanner tone={result.length ? 'green' : 'slate'}>{result.length ? `${result.length} statement(s) issued: ${result.map((r) => r.number).join(', ')}` : 'No approved, un-invoiced timesheets in that period.'}</InfoBanner>}
      </div>
    </Modal>
  );
}
