import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAction, useTimesheets } from '../api/hooks';
import type { TimesheetListItem } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { StatusBadge } from '../components/badges';
import { Button, Card, ErrorBanner, Field, Input, Loading, Modal, PageHeader, Select, Table, Tabs, Textarea } from '../components/ui';
import { fmtDateTime, fmtHours, fmtMoney, fmtShiftWindow, toLocalInput, fromLocalInput } from '../lib/format';

type Tab = 'payable' | 'receivable';

export function TimesheetsPage() {
  const { isWorker, isManager, isPlatformAdmin } = useAuth();
  const [tab, setTab] = useState<Tab>(isWorker ? 'receivable' : 'payable');
  const [status, setStatus] = useState('');
  const q = useTimesheets(tab, status || undefined);
  const [reasonFor, setReasonFor] = useState<{ ts: TimesheetListItem; action: 'dispute' | 'reject' } | null>(null);
  const [submitFor, setSubmitFor] = useState<TimesheetListItem | null>(null);
  const [reason, setReason] = useState('');

  const clockIn = useAction((id: string) => api.post(`/timesheets/${id}/clock-in`, {}));
  const clockOut = useAction((id: string) => api.post(`/timesheets/${id}/clock-out`, {}));
  const approve = useAction((id: string) => api.post(`/timesheets/${id}/approve`));
  const disputeOrReject = useAction((args: { id: string; action: 'dispute' | 'reject' }) => api.post(`/timesheets/${args.id}/${args.action}`, { reason }), () => { setReasonFor(null); setReason(''); });
  const error = clockIn.error ?? clockOut.error ?? approve.error ?? disputeOrReject.error;

  const payable = tab === 'payable';
  return (
    <div className="space-y-5">
      <PageHeader title="Timesheets" description={isWorker ? 'Clock in and out of your shifts. Your employer and the host approve the hours.' : 'Hours worked on exchanged shifts. Hosts approve what they pay; suppliers submit what their workers did.'} />
      <Card>
        {!isWorker && <Tabs tabs={[{ value: 'payable', label: 'Payable (shifts we hosted)' }, { value: 'receivable', label: 'Receivable (shifts we covered)' }]} value={tab} onChange={setTab} />}
        <div className="mb-3 max-w-xs">
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {['DRAFT', 'SUBMITTED', 'APPROVED', 'DISPUTED', 'REJECTED'].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
            </Select>
          </Field>
        </div>
        <ErrorBanner error={error ?? q.error} className="mb-3" />
        {q.isLoading ? <Loading /> : (
          <Table
            rows={q.data ?? []}
            rowKey={(t) => t.id}
            columns={[
              { key: 'shift', header: 'Shift', render: (t) => <div><Link to={`/shifts/${t.shift.id}`} className="font-medium text-slate-900 hover:underline">{t.shift.title}</Link><div className="text-xs text-slate-500">{fmtShiftWindow(t.shift.startsAt, t.shift.endsAt, t.shift.breakMinutes)}</div></div> },
              { key: 'who', header: payable ? 'Worker / supplier' : 'Worker / host', render: (t) => <div>{t.worker.firstName} {t.worker.lastName}<div className="text-xs text-slate-500">{payable ? t.supplierName : t.hostName}</div></div> },
              { key: 'times', header: 'Clocked', render: (t) => (t.clockInAt ? <div className="text-xs">{fmtDateTime(t.clockInAt)}<br />{t.clockOutAt ? fmtDateTime(t.clockOutAt) : <span className="text-emerald-700">on shift</span>}</div> : <span className="text-xs text-slate-400">Not clocked in</span>) },
              { key: 'hours', header: 'Paid hours', align: 'right', render: (t) => fmtHours(t.paidHours) },
              { key: 'money', header: payable ? 'You pay' : 'You receive', align: 'right', render: (t) => <div>{fmtMoney(payable ? t.hostCost : t.supplierAmount)}<div className="text-xs text-slate-400">{fmtMoney(t.chargeRate)}/h{isPlatformAdmin && ` · fee ${fmtMoney(t.platformFee)}`}</div></div> },
              { key: 'status', header: 'Status', render: (t) => <div><StatusBadge status={t.status} />{t.disputeReason && <div className="mt-1 max-w-[180px] text-xs text-rose-700">{t.disputeReason}</div>}</div> },
              { key: 'actions', header: '', align: 'right', render: (t) => (
                <span className="flex flex-wrap justify-end gap-1">
                  {!payable && t.status === 'DRAFT' && !t.clockInAt && <Button size="sm" onClick={() => clockIn.mutate(t.id)} loading={clockIn.isPending}>Clock in</Button>}
                  {!payable && t.status === 'DRAFT' && t.clockInAt && !t.clockOutAt && <Button size="sm" onClick={() => clockOut.mutate(t.id)} loading={clockOut.isPending}>Clock out</Button>}
                  {!payable && ['DRAFT', 'DISPUTED', 'SUBMITTED'].includes(t.status) && <Button size="sm" variant="secondary" onClick={() => setSubmitFor(t)}>{t.status === 'DISPUTED' ? 'Correct & resubmit' : 'Enter times'}</Button>}
                  {payable && isManager && ['SUBMITTED', 'DISPUTED'].includes(t.status) && <Button size="sm" variant="success" onClick={() => approve.mutate(t.id)} loading={approve.isPending}>Approve</Button>}
                  {payable && isManager && t.status === 'SUBMITTED' && <Button size="sm" variant="secondary" onClick={() => setReasonFor({ ts: t, action: 'dispute' })}>Dispute</Button>}
                  {payable && isManager && ['SUBMITTED', 'DISPUTED'].includes(t.status) && <Button size="sm" variant="ghost" onClick={() => setReasonFor({ ts: t, action: 'reject' })}>Reject</Button>}
                </span>
              ) },
            ]}
          />
        )}
      </Card>
      <Modal open={!!reasonFor} onClose={() => setReasonFor(null)} title={reasonFor?.action === 'dispute' ? 'Dispute timesheet' : 'Reject timesheet'} footer={<><Button variant="secondary" onClick={() => setReasonFor(null)}>Back</Button><Button variant="danger" onClick={() => reasonFor && disputeOrReject.mutate({ id: reasonFor.ts.id, action: reasonFor.action })} loading={disputeOrReject.isPending}>{reasonFor?.action === 'dispute' ? 'Dispute' : 'Reject'}</Button></>}>
        <p className="mb-3 text-sm text-slate-600">{reasonFor?.action === 'dispute' ? 'The supplier can correct the times and resubmit.' : 'Rejecting closes the timesheet; nothing will be paid.'}</p>
        <Field label="Reason" required><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
      {submitFor && <SubmitTimesModal ts={submitFor} onClose={() => setSubmitFor(null)} />}
    </div>
  );
}

function SubmitTimesModal({ ts, onClose }: { ts: TimesheetListItem; onClose: () => void }) {
  const [form, setForm] = useState({ clockInAt: toLocalInput(new Date(ts.clockInAt ?? ts.shift.startsAt)), clockOutAt: toLocalInput(new Date(ts.clockOutAt ?? ts.shift.endsAt)), breakMinutes: String(ts.breakMinutes), notes: ts.notes ?? '' });
  const submit = useAction(() => api.post(`/timesheets/${ts.id}/submit`, { clockInAt: fromLocalInput(form.clockInAt), clockOutAt: fromLocalInput(form.clockOutAt), breakMinutes: Number(form.breakMinutes), notes: form.notes || null }), onClose);
  return (
    <Modal open onClose={onClose} title="Submit times" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => submit.mutate()} loading={submit.isPending}>Submit for approval</Button></>}>
      <div className="space-y-3">
        <ErrorBanner error={submit.error} />
        <Field label="Started"><Input type="datetime-local" value={form.clockInAt} onChange={(e) => setForm({ ...form, clockInAt: e.target.value })} /></Field>
        <Field label="Finished"><Input type="datetime-local" value={form.clockOutAt} onChange={(e) => setForm({ ...form, clockOutAt: e.target.value })} /></Field>
        <Field label="Unpaid break (minutes)"><Input type="number" min="0" value={form.breakMinutes} onChange={(e) => setForm({ ...form, breakMinutes: e.target.value })} /></Field>
        <Field label="Notes"><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
