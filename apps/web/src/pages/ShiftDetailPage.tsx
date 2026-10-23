import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DOCUMENT_LABELS, JOB_ROLE_LABELS } from '@merge/shared';
import { api } from '../api/client';
import { useAction } from '../api/hooks';
import type { Assignment, EligibleWorker, PlanEntry } from '../api/types';
import { REPORT_CATEGORY_LABELS, type CandidatePlus, type EscalateResponse, type ReportCategory, type ShiftDetailPlus } from '../api/types.dispatch';
import { useAuth } from '../auth/AuthContext';
import { Countdown } from '../components/Countdown';
import { ComplianceBadge, StatusBadge, TierBadge, UrgentBadge, skillLabel } from '../components/badges';
import { Badge, Button, Card, Checkbox, DescriptionList, EmptyState, ErrorBanner, Field, InfoBanner, Input, Loading, Modal, PageHeader, Select, Textarea, cx } from '../components/ui';
import { fmtDateTime, fmtMoney, fmtShiftWindow, fromLocalInput, humanise, toLocalInput } from '../lib/format';

type ShiftDetail = ShiftDetailPlus;

export function ShiftDetailPage() {
  const { id } = useParams();
  const { isWorker, isManager, me } = useAuth();
  const myOrgId = me?.organisation.id;
  const q = useQuery({ queryKey: ['shift', id], queryFn: () => api.get<ShiftDetail>(`/shifts/${id}`), enabled: !!id, refetchInterval: 60_000 });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBanner error={q.error ?? 'Shift not found'} />;
  const s = q.data;
  const started = new Date(s.startsAt).getTime() <= Date.now();

  return (
    <div className="space-y-5">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {s.title} <StatusBadge status={s.status} /> <UrgentBadge urgent={s.urgent} /> {s.autoConfirm && <Badge tone="green">Instant book</Badge>}
          </span>
        }
        description={`${JOB_ROLE_LABELS[s.jobRole]} · ${s.hostName} · ${s.site.name}`}
        actions={s.canManage && isManager ? <HostActions shift={s} /> : undefined}
      />

      {!s.isHost && s.access && <AccessBanner shift={s} />}
      {isWorker && s.myEligibility && s.status === 'OPEN' && (
        <InfoBanner tone={s.myEligibility.eligible ? 'green' : 'red'}>
          {s.myEligibility.eligible ? (
            <span className="font-medium">✓ You can take this shift.{s.myEligibility.warnings.length > 0 && <span className="ml-2 font-normal text-xs">{s.myEligibility.warnings.map((w) => w.message).join(' · ')}</span>}</span>
          ) : (
            <span><span className="font-medium">Not eligible:</span> {s.myEligibility.blockers.map((b) => b.message).join(' · ')}</span>
          )}
        </InfoBanner>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Shift" className="lg:col-span-2">
          <DescriptionList
            items={[
              { label: 'When', value: fmtShiftWindow(s.startsAt, s.endsAt, s.breakMinutes) },
              { label: 'Break', value: `${s.breakMinutes} min unpaid` },
              { label: s.chargeRate == null ? 'Pay' : 'Charge rate', value: s.chargeRate == null ? 'Set by your employer' : `${fmtMoney(s.chargeRate)}/h · ${fmtMoney((s.paidHours ?? 0) * s.chargeRate)} per worker` },
              { label: 'Places', value: `${s.filledCount} of ${s.headcount} filled` },
              { label: 'Visibility', value: humanise(s.visibility) },
              { label: 'Published', value: s.publishedAt ? fmtDateTime(s.publishedAt) : 'Draft' },
              ...(s.distanceKm != null ? [{ label: 'Distance', value: `${s.distanceKm} km from ${isWorker ? 'home' : 'your organisation'}` }] : []),
              ...(s.escalation && s.escalation.step > 0 ? [{ label: 'Escalated', value: `Step ${s.escalation.step}${s.escalation.originalChargeRate !== s.chargeRate ? ` · was ${fmtMoney(s.escalation.originalChargeRate)}/h` : ''}` }] : []),
              { label: 'Required skills', value: s.requiredSkills.length ? <span className="flex flex-wrap gap-1">{s.requiredSkills.map((k) => <Badge key={k}>{skillLabel(k)}</Badge>)}</span> : 'None beyond role' },
              { label: 'Extra documents', value: s.extraRequiredDocuments.length ? s.extraRequiredDocuments.map((d) => DOCUMENT_LABELS[d]).join(', ') : 'Standard for role' },
            ]}
          />
          {s.description && <p className="mt-4 whitespace-pre-line rounded-lg bg-slate-50 p-3 text-sm text-slate-700">{s.description}</p>}
          {s.cancellationReason && <InfoBanner tone="red" className="mt-3">Cancelled: {s.cancellationReason}</InfoBanner>}
        </Card>
        <Card title="Site">
          <div className="text-sm font-medium text-slate-900">{s.site.name}</div>
          <div className="text-sm text-slate-600">
            {[s.site.addressLine1, s.site.city, s.site.postcode].filter(Boolean).join(', ')}
          </div>
          {s.site.serviceType && <div className="mt-1 text-xs text-slate-500">{humanise(s.site.serviceType)}</div>}
          {s.site.accessNotes && (
            <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50 p-3 text-xs text-amber-900">
              <div className="font-semibold">Access notes</div>
              <div className="whitespace-pre-line">{s.site.accessNotes}</div>
            </div>
          )}
          {s.site.lat != null && s.site.lng != null && (
            <a className="mt-3 inline-block text-xs font-medium text-brand-700 hover:underline" href={`https://www.openstreetmap.org/?mlat=${s.site.lat}&mlon=${s.site.lng}#map=15/${s.site.lat}/${s.site.lng}`} target="_blank" rel="noreferrer">
              View on map ↗
            </a>
          )}
        </Card>
      </div>

      {/* Host view (also platform-admin oversight of any shift). */}
      {s.canManage && (
        <>
          <AssignmentsPanel shift={s} started={started} />
          {s.escalation && (s.status === 'OPEN' || s.escalation.history.length > 0) && <EscalationCard shift={s} />}
          {['OPEN', 'FILLED'].includes(s.status) && s.plan && <ReleasePlan entries={s.plan} urgent={s.urgent} />}
          {s.status === 'OPEN' && isManager && <CandidatesPanel shift={s} />}
        </>
      )}
      {/* Supplier view: anyone whose organisation is not the host, including the agency acting as its own bank. */}
      {!s.isHost &&
        (isWorker ? (
          <WorkerRequestPanel shift={s} selfService={!!me?.organisation.workerSelfServiceAllowed} />
        ) : (
          <>
            <MyAssignmentsPanel shift={s} orgId={myOrgId} />
            {s.status === 'OPEN' && s.access?.opensAt && <PutForwardPanel shift={s} />}
          </>
        ))}
    </div>
  );
}

function AccessBanner({ shift }: { shift: ShiftDetail }) {
  const a = shift.access!;
  if (!a.opensAt) return <InfoBanner tone="slate">This shift is not in your organisation's release plan, but you have an assignment on it.</InfoBanner>;
  return (
    <InfoBanner tone={a.open ? (a.tier === 'PRIORITY' ? 'amber' : a.tier === 'AGENCY' ? 'violet' : 'blue') : 'slate'}>
      <div className="flex flex-wrap items-center gap-2">
        <TierBadge tier={a.tier} />
        <span className="font-medium">{a.open ? 'Open to your organisation' : <Countdown to={a.opensAt} prefix="Opens to your organisation" />}</span>
        {!a.open && <span className="text-xs">({fmtDateTime(a.opensAt)})</span>}
        {a.reason && <span className="text-xs opacity-80">· {a.reason}</span>}
      </div>
    </InfoBanner>
  );
}

// ---------------- Host ----------------

function HostActions({ shift }: { shift: ShiftDetail }) {
  const navigate = useNavigate();
  const [edit, setEdit] = useState(false);
  const [cancel, setCancel] = useState(false);
  const [reason, setReason] = useState('');
  const [escalate, setEscalate] = useState(false);
  const [copy, setCopy] = useState(false);
  const [form, setForm] = useState({ chargeRate: String(shift.chargeRate ?? ''), headcount: String(shift.headcount), title: shift.title, autoConfirm: shift.autoConfirm });
  const esc = shift.escalation;
  const [escForm, setEscForm] = useState({ raisePct: String(esc?.suggestedRaisePct ?? 7), openToAll: true });
  const nextStart = new Date(shift.startsAt);
  nextStart.setDate(nextStart.getDate() + 7);
  const nextEnd = new Date(shift.endsAt);
  nextEnd.setDate(nextEnd.getDate() + 7);
  const [copyForm, setCopyForm] = useState({ startsAt: toLocalInput(nextStart), endsAt: toLocalInput(nextEnd), publish: true });
  const publish = useAction(() => api.post(`/shifts/${shift.id}/publish`));
  const update = useAction(() => api.patch(`/shifts/${shift.id}`, { chargeRate: Number(form.chargeRate), headcount: Number(form.headcount), title: form.title, autoConfirm: form.autoConfirm }), () => setEdit(false));
  const doCancel = useAction(() => api.post(`/shifts/${shift.id}/cancel`, { reason: reason || null }), () => { setCancel(false); navigate('/shifts/posted'); });
  const doEscalate = useAction(() => api.post<EscalateResponse>(`/shifts/${shift.id}/escalate`, { raiseRatePct: Number(escForm.raisePct) || undefined, openToAll: escForm.openToAll }), () => setEscalate(false));
  const doCopy = useAction(() => api.post<{ id: string }>(`/shifts/${shift.id}/copy`, { startsAt: fromLocalInput(copyForm.startsAt), endsAt: fromLocalInput(copyForm.endsAt), publish: copyForm.publish }), (r) => { setCopy(false); navigate(`/shifts/${r.id}`); });
  const editable = shift.status === 'DRAFT' || shift.status === 'OPEN';
  const rate = shift.chargeRate ?? 0;
  const raisedRate = Math.round(rate * (1 + (Number(escForm.raisePct) || 0) / 100) * 20) / 20;
  const placesLeft = shift.headcount - shift.filledCount;
  return (
    <>
      {shift.status === 'DRAFT' && <Button onClick={() => publish.mutate()} loading={publish.isPending}>Publish now</Button>}
      {shift.status === 'OPEN' && placesLeft > 0 && <Button variant={esc && esc.stepDue > esc.step ? 'primary' : 'secondary'} onClick={() => setEscalate(true)}>Escalate now</Button>}
      {editable && <Button variant="secondary" onClick={() => setEdit(true)}>Edit</Button>}
      {shift.status !== 'DRAFT' && <Button variant="secondary" onClick={() => setCopy(true)}>Post again</Button>}
      {['DRAFT', 'OPEN', 'FILLED'].includes(shift.status) && <Button variant="danger" onClick={() => setCancel(true)}>Cancel shift</Button>}
      <ErrorBanner error={publish.error} />
      <Modal
        open={escalate}
        onClose={() => setEscalate(false)}
        title="Escalate this shift"
        footer={<><Button variant="secondary" onClick={() => setEscalate(false)}>Back</Button><Button onClick={() => doEscalate.mutate()} loading={doEscalate.isPending} disabled={!escForm.openToAll && !(Number(escForm.raisePct) > 0)}>Escalate</Button></>}
      >
        <div className="space-y-3">
          <ErrorBanner error={doEscalate.error} />
          <p className="text-sm text-slate-600">{placesLeft} place{placesLeft === 1 ? '' : 's'} still open. Raising the rate re-notifies everyone with access; opening to all brings every tier forward to now.</p>
          <Field label="Raise the rate by (%)" hint={`Now ${fmtMoney(rate)}/h → ${fmtMoney(raisedRate)}/h${esc ? ` · your automatic ceiling is ${fmtMoney(esc.ceilingRate)}/h` : ''}`}>
            <Input type="number" min="0" max="100" step="1" value={escForm.raisePct} onChange={(e) => setEscForm({ ...escForm, raisePct: e.target.value })} />
          </Field>
          <Checkbox label="Open to every organisation now" hint="Skips the remaining priority and agency windows." checked={escForm.openToAll} onChange={(e) => setEscForm({ ...escForm, openToAll: e.target.checked })} />
          {esc?.mode === 'MANUAL' && <p className="text-xs text-slate-500">Prefer this to happen automatically at 48h, 24h and 12h before the start? Switch to automatic escalation in Settings.</p>}
        </div>
      </Modal>
      <Modal open={copy} onClose={() => setCopy(false)} title="Post this shift again" footer={<><Button variant="secondary" onClick={() => setCopy(false)}>Back</Button><Button onClick={() => doCopy.mutate()} loading={doCopy.isPending}>{copyForm.publish ? 'Publish copy' : 'Save as draft'}</Button></>}>
        <div className="space-y-3">
          <ErrorBanner error={doCopy.error} />
          <p className="text-sm text-slate-600">Same site, role, rate, requirements and visibility. Only the date changes.{shift.escalation && shift.escalation.originalChargeRate !== shift.chargeRate && ` The copy uses the original rate of ${fmtMoney(shift.escalation.originalChargeRate)}/h.`}</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Starts"><Input type="datetime-local" value={copyForm.startsAt} onChange={(e) => setCopyForm({ ...copyForm, startsAt: e.target.value })} /></Field>
            <Field label="Ends"><Input type="datetime-local" value={copyForm.endsAt} onChange={(e) => setCopyForm({ ...copyForm, endsAt: e.target.value })} /></Field>
          </div>
          <Checkbox label="Publish straight away" checked={copyForm.publish} onChange={(e) => setCopyForm({ ...copyForm, publish: e.target.checked })} />
        </div>
      </Modal>
      <Modal open={edit} onClose={() => setEdit(false)} title="Edit shift" footer={<><Button variant="secondary" onClick={() => setEdit(false)}>Close</Button><Button onClick={() => update.mutate()} loading={update.isPending}>Save</Button></>}>
        <div className="space-y-3">
          <ErrorBanner error={update.error} />
          <Field label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Charge rate (£/h)" hint={`Raising the rate re-notifies everyone who already has access.${shift.floor !== undefined ? ` Platform floor ${fmtMoney(shift.floor)}/h.` : ''}`}><Input type="number" step="0.05" min={shift.floor ?? 1} value={form.chargeRate} onChange={(e) => setForm({ ...form, chargeRate: e.target.value })} /></Field>
            <Field label="Workers needed"><Input type="number" min={shift.filledCount || 1} value={form.headcount} onChange={(e) => setForm({ ...form, headcount: e.target.value })} /></Field>
          </div>
          <Checkbox label="Instant book" hint="The first eligible request is confirmed automatically." checked={form.autoConfirm} onChange={(e) => setForm({ ...form, autoConfirm: e.target.checked })} />
        </div>
      </Modal>
      <Modal open={cancel} onClose={() => setCancel(false)} title="Cancel this shift?" footer={<><Button variant="secondary" onClick={() => setCancel(false)}>Keep shift</Button><Button variant="danger" onClick={() => doCancel.mutate()} loading={doCancel.isPending}>Cancel shift</Button></>}>
        <ErrorBanner error={doCancel.error} />
        <p className="mb-3 text-sm text-slate-600">Any confirmed workers and pending requests will be notified. {shift.filledCount > 0 && <strong>{shift.filledCount} confirmed booking(s) will be cancelled.</strong>}</p>
        <Field label="Reason (shared with suppliers)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
    </>
  );
}

function EscalationCard({ shift }: { shift: ShiftDetail }) {
  const e = shift.escalation!;
  const due = shift.status === 'OPEN' && e.stepDue > e.step && shift.filledCount < shift.headcount;
  return (
    <Card
      title="Escalation"
      description={e.mode === 'AUTO' ? `Automatic: at 48h, 24h and 12h before the start the rate rises by ${e.suggestedRaisePct}% of the original (up to ${fmtMoney(e.ceilingRate)}/h, your ${e.ceilingPct}% ceiling) and every tier opens.` : 'Manual: you are prompted at 48h, 24h and 12h before the start while places are unfilled. Use “Escalate now” above.'}
    >
      {due && <InfoBanner tone="amber" className="mb-3">Escalation step {e.stepDue} is due: {shift.headcount - shift.filledCount} place(s) still open close to the start.</InfoBanner>}
      <DescriptionList
        items={[
          { label: 'Original rate', value: `${fmtMoney(e.originalChargeRate)}/h` },
          { label: 'Current rate', value: `${fmtMoney(shift.chargeRate ?? 0)}/h` },
          { label: 'Ceiling', value: `${fmtMoney(e.ceilingRate)}/h (+${e.ceilingPct}%)` },
          { label: 'Last escalated', value: e.lastEscalatedAt ? fmtDateTime(e.lastEscalatedAt) : 'Not yet' },
        ]}
      />
      {e.history.length > 0 && (
        <ol className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-100 text-sm">
          {e.history.map((h, i) => (
            <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span><Badge tone={h.mode === 'AUTO' ? 'violet' : 'blue'}>{h.mode === 'AUTO' ? 'Automatic' : 'Manual'}</Badge> <span className="ml-2 text-slate-700">Step {h.step}: {h.newRate > h.previousRate ? `${fmtMoney(h.previousRate)} → ${fmtMoney(h.newRate)}/h` : 'rate unchanged'}{h.opened ? ', opened to all' : ''}</span></span>
              <span className="text-xs text-slate-500">{fmtDateTime(h.at)}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/** Decision 14: the host bars a worker or reports a concern to the employer. */
function TrustActions({ shift, assignment }: { shift: ShiftDetail; assignment: ShiftDetail['assignments'][number] }) {
  const [bar, setBar] = useState(false);
  const [report, setReport] = useState(false);
  const [barForm, setBarForm] = useState({ reason: '', thisSiteOnly: false, share: false });
  const [reportForm, setReportForm] = useState({ category: 'CONDUCT' as ReportCategory, description: '' });
  const doBar = useAction(() => api.post('/trust/bars', { workerId: assignment.workerId, siteId: barForm.thisSiteOnly ? shift.siteId : null, reason: barForm.reason, shareReason: barForm.share }), () => setBar(false));
  const doReport = useAction(() => api.post('/trust/reports', { workerId: assignment.workerId, assignmentId: assignment.id, category: reportForm.category, description: reportForm.description }), () => { setReport(false); setReportForm({ category: 'CONDUCT', description: '' }); });
  const name = `${assignment.worker.firstName} ${assignment.worker.lastName}`;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setReport(true)}>Report a concern</Button>
      <Button size="sm" variant="ghost" onClick={() => setBar(true)}>Bar this worker</Button>
      <Modal open={bar} onClose={() => setBar(false)} title={`Bar ${name} from your shifts`} footer={<><Button variant="secondary" onClick={() => setBar(false)}>Back</Button><Button variant="danger" loading={doBar.isPending} disabled={barForm.reason.trim().length < 3} onClick={() => doBar.mutate()}>Bar worker</Button></>}>
        <div className="space-y-3">
          <ErrorBanner error={doBar.error} />
          <p className="text-sm text-slate-600">{name} can no longer be put forward for your shifts. Any future bookings with you are cancelled (not counted as a late cancellation against {assignment.supplierName}) and the employer is told, without the reason unless you share it.</p>
          <Field label="Reason (kept on your record)" required><Textarea value={barForm.reason} onChange={(e) => setBarForm({ ...barForm, reason: e.target.value })} /></Field>
          <Checkbox label={`Only for ${shift.site.name}`} hint="Leave unticked to bar from all your sites." checked={barForm.thisSiteOnly} onChange={(e) => setBarForm({ ...barForm, thisSiteOnly: e.target.checked })} />
          <Checkbox label="Share the reason with the employer" checked={barForm.share} onChange={(e) => setBarForm({ ...barForm, share: e.target.checked })} />
        </div>
      </Modal>
      <Modal open={report} onClose={() => setReport(false)} title={`Report a concern about ${name}`} footer={<><Button variant="secondary" onClick={() => setReport(false)}>Back</Button><Button loading={doReport.isPending} disabled={reportForm.description.trim().length < 10} onClick={() => doReport.mutate()}>Send to employer</Button></>}>
        <div className="space-y-3">
          <ErrorBanner error={doReport.error} />
          <p className="text-sm text-slate-600">The worker is accountable to their employer, {assignment.supplierName}, which must handle this under its own frameworks and tell you the outcome. Safeguarding concerns are also seen by the platform. Follow your own safeguarding procedures as well.</p>
          <Field label="Category">
            <Select value={reportForm.category} onChange={(e) => setReportForm({ ...reportForm, category: e.target.value as ReportCategory })}>
              {(Object.keys(REPORT_CATEGORY_LABELS) as ReportCategory[]).map((c) => (
                <option key={c} value={c}>{REPORT_CATEGORY_LABELS[c]}</option>
              ))}
            </Select>
          </Field>
          <Field label="What happened" required hint="Facts, dates and who was involved. At least 10 characters."><Textarea rows={5} value={reportForm.description} onChange={(e) => setReportForm({ ...reportForm, description: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

function AssignmentsPanel({ shift, started }: { shift: ShiftDetail; started: boolean }) {
  type Row = ShiftDetail['assignments'][number];
  const [rateFor, setRateFor] = useState<Row | null>(null);
  const [declineFor, setDeclineFor] = useState<Row | null>(null);
  const [cancelFor, setCancelFor] = useState<Row | null>(null);
  const [reason, setReason] = useState('');
  const [score, setScore] = useState(5);
  const [comment, setComment] = useState('');
  const confirm = useAction((id: string) => api.post(`/assignments/${id}/confirm`));
  const decline = useAction((id: string) => api.post(`/assignments/${id}/decline`, { reason: reason || null }), () => { setDeclineFor(null); setReason(''); });
  const cancel = useAction((id: string) => api.post(`/assignments/${id}/cancel`, { reason: reason || null }), () => { setCancelFor(null); setReason(''); });
  const noShow = useAction((id: string) => api.post(`/assignments/${id}/no-show`));
  const rate = useAction((id: string) => api.post(`/assignments/${id}/rating`, { score, comment: comment || null }), () => { setRateFor(null); setComment(''); });
  const error = confirm.error ?? decline.error ?? cancel.error ?? noShow.error ?? rate.error;
  const live = shift.assignments.filter((a) => ['REQUESTED', 'OFFERED', 'CONFIRMED'].includes(a.status));
  const history = shift.assignments.filter((a) => !['REQUESTED', 'OFFERED', 'CONFIRMED'].includes(a.status));

  return (
    <Card title="Requests & bookings" description={`${shift.filledCount} of ${shift.headcount} places filled`}>
      <ErrorBanner error={error} className="mb-3" />
      {shift.assignments.length === 0 ? <EmptyState title="No requests yet" description="Suppliers with access will put workers forward here, or use “Find a worker” below to offer the shift directly." /> : (
        <ul className="divide-y divide-slate-100">
          {[...live, ...history].map((a) => (
            <li key={a.id} className={cx('flex flex-wrap items-center justify-between gap-3 py-3', !live.includes(a) && 'opacity-60')}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-slate-900">{a.worker.firstName} {a.worker.lastName}</span>
                  <span className="text-xs text-slate-500">{JOB_ROLE_LABELS[a.worker.jobRole]}</span>
                  <StatusBadge status={a.status} />
                  <TierBadge tier={a.tierAtRequest} />
                  {a.lateCancellation && <Badge tone="red">Late cancellation</Badge>}
                  {a.hoursOverride && <Badge tone="amber">48h override</Badge>}
                  {a.complianceStatus && <ComplianceBadge status={a.complianceStatus} />}
                </div>
                <div className="text-xs text-slate-500">
                  From {a.supplierName} · {fmtDateTime(a.requestedAt)}
                  {a.note && <> · “{a.note}”</>}
                  {a.cancellationReason && <> · {a.cancellationReason}</>}
                </div>
                {a.worker.skills && a.worker.skills.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{a.worker.skills.map((k) => <Badge key={k}>{skillLabel(k)}</Badge>)}</div>}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {a.status === 'REQUESTED' && (
                  <>
                    <Button size="sm" variant="success" onClick={() => confirm.mutate(a.id)} loading={confirm.isPending}>Confirm</Button>
                    <Button size="sm" variant="secondary" onClick={() => setDeclineFor(a)}>Decline</Button>
                  </>
                )}
                {a.status === 'OFFERED' && <span className="text-xs text-slate-500">Waiting for supplier</span>}
                {a.status === 'CONFIRMED' && !started && <Button size="sm" variant="danger" onClick={() => setCancelFor(a)}>Cancel booking</Button>}
                {a.status === 'CONFIRMED' && started && <Button size="sm" variant="danger" onClick={() => noShow.mutate(a.id)} loading={noShow.isPending}>No-show</Button>}
                {['CONFIRMED', 'COMPLETED', 'NO_SHOW'].includes(a.status) && started && <Button size="sm" variant="secondary" onClick={() => setRateFor(a)}>Rate</Button>}
                {['CONFIRMED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'].includes(a.status) && <TrustActions shift={shift} assignment={a} />}
                <Link to={`/timesheets`} className="self-center text-xs text-brand-700 hover:underline">{a.status === 'CONFIRMED' || a.status === 'COMPLETED' ? 'Timesheet' : ''}</Link>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!declineFor} onClose={() => setDeclineFor(null)} title="Decline request" footer={<><Button variant="secondary" onClick={() => setDeclineFor(null)}>Back</Button><Button variant="danger" onClick={() => declineFor && decline.mutate(declineFor.id)} loading={decline.isPending}>Decline</Button></>}>
        <Field label="Reason (optional, shared with the supplier)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
      <Modal open={!!cancelFor} onClose={() => setCancelFor(null)} title="Cancel booking" footer={<><Button variant="secondary" onClick={() => setCancelFor(null)}>Back</Button><Button variant="danger" onClick={() => cancelFor && cancel.mutate(cancelFor.id)} loading={cancel.isPending}>Cancel booking</Button></>}>
        <p className="mb-3 text-sm text-slate-600">The supplier will be notified and the place reopened.</p>
        <Field label="Reason"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
      <Modal open={!!rateFor} onClose={() => setRateFor(null)} title={`Rate ${rateFor?.worker.firstName ?? ''}`} footer={<><Button variant="secondary" onClick={() => setRateFor(null)}>Back</Button><Button onClick={() => rateFor && rate.mutate(rateFor.id)} loading={rate.isPending}>Save rating</Button></>}>
        <div className="mb-3 flex gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" onClick={() => setScore(n)} className={cx('text-2xl', n <= score ? 'text-amber-500' : 'text-slate-300')} aria-label={`${n} stars`}>★</button>
          ))}
        </div>
        <Field label="Comment"><Textarea value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      </Modal>
    </Card>
  );
}

export function ReleasePlan({ entries, urgent, excluded, stages }: { entries: PlanEntry[]; urgent: boolean; excluded?: { orgId: string; orgName?: string; reason: string }[]; stages?: { tier: string; opensAt: string }[] }) {
  const groups = ['PRIORITY', 'AGENCY', 'NETWORK'] as const;
  return (
    <Card title="Release plan" description={urgent ? 'Urgent shift: every tier was opened immediately.' : 'Who can see and claim this shift, and from when. Organisations with a matching surplus flag go first.'}>
      {urgent && <InfoBanner tone="red" className="mb-3">Urgent – all windows collapsed</InfoBanner>}
      {stages && stages.length > 0 && (
        <ol className="mb-4 flex flex-wrap gap-2 text-xs">
          {stages.map((st) => (
            <li key={st.tier} className="flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1"><TierBadge tier={st.tier as PlanEntry['tier']} /> <Countdown to={st.opensAt} /></li>
          ))}
        </ol>
      )}
      {entries.length === 0 ? <EmptyState title="No organisations in the plan" description="Nobody on the network can currently see this shift. Check the visibility setting and your blocklist." /> : (
        <div className="space-y-4">
          {groups.map((g) => {
            const rows = entries.filter((e) => e.tier === g);
            if (rows.length === 0) return null;
            return (
              <div key={g}>
                <div className="mb-1 flex items-center gap-2"><TierBadge tier={g} /><span className="text-xs text-slate-500"><Countdown to={rows[0]!.opensAt} /> · {fmtDateTime(rows[0]!.opensAt)}</span></div>
                <ol className="divide-y divide-slate-100 rounded-lg border border-slate-100">
                  {rows.map((e) => (
                    <li key={e.orgId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                      <div>
                        <span className="mr-2 text-xs text-slate-400">#{e.rank}</span>
                        <span className="font-medium text-slate-800">{e.orgName ?? e.orgId}</span>
                        <span className="ml-2 text-xs text-slate-500">{e.reason}</span>
                      </div>
                      <div className="text-xs text-slate-500">
                        {e.distanceKm != null && <span className="mr-2">{Math.round(e.distanceKm)} km</span>}
                        {e.notifiedAt ? <Badge tone="green">Notified</Badge> : <Badge>Not yet notified</Badge>}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            );
          })}
        </div>
      )}
      {excluded && excluded.length > 0 && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-slate-600">Excluded ({excluded.length})</summary>
          <ul className="mt-1 list-disc pl-5 text-xs text-slate-500">
            {excluded.map((e) => (
              <li key={e.orgId}>{e.orgName ?? e.orgId}: {e.reason}</li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

function CandidatesPanel({ shift }: { shift: ShiftDetail }) {
  const q = useQuery({ queryKey: ['candidates', shift.id], queryFn: () => api.get<CandidatePlus[]>(`/shifts/${shift.id}/candidates`) });
  const offer = useAction((workerId: string) => api.post(`/shifts/${shift.id}/offers`, { workerId }));
  return (
    <Card title="Find a worker" description="Shareable, eligible workers from organisations whose access is open. Offer the shift directly; their employer accepts or declines.">
      <ErrorBanner error={offer.error ?? q.error} className="mb-3" />
      {q.isLoading ? <Loading /> : (q.data ?? []).length === 0 ? <EmptyState title="No candidates yet" description="Candidates appear as release tiers open and suppliers mark workers as shareable." /> : (
        <ul className="divide-y divide-slate-100">
          {(q.data ?? []).map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium text-slate-900">{c.firstName} {c.lastName}</span>
                  <span className="text-xs text-slate-500">{JOB_ROLE_LABELS[c.jobRole]} · {c.orgName}</span>
                  <TierBadge tier={c.tier} />
                  {c.yourAverageRating != null && <Badge tone="amber">★ {c.yourAverageRating.toFixed(1)} · {c.previousShiftsWithYou} with you</Badge>}
                  {c.distanceKm != null && <Badge>{c.distanceKm} km</Badge>}
                  {c.complianceStatus && <ComplianceBadge status={c.complianceStatus} />}
                  {c.reliability && (
                    <Badge tone={c.reliability.noShows === 0 ? 'green' : c.reliability.noShows === 1 ? 'amber' : 'red'}>
                      <span title={`${c.orgName}: ${c.reliability.noShows} no-show(s), ${c.reliability.lateCancellations} late cancellation(s) in ${c.reliability.windowDays} days`}>Reliability {c.reliability.score}{c.reliability.noShows > 0 ? ` · ${c.reliability.noShows} no-show${c.reliability.noShows === 1 ? '' : 's'}` : ''}</span>
                    </Badge>
                  )}
                </div>
                {c.warnings.length > 0 && <div className="mt-0.5 text-xs text-amber-700">{c.warnings.map((w) => w.message).join(' · ')}</div>}
              </div>
              <Button size="sm" variant="secondary" onClick={() => offer.mutate(c.id)} loading={offer.isPending}>Offer shift</Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------- Supplier ----------------

function MyAssignmentsPanel({ shift, orgId }: { shift: ShiftDetail; orgId?: string }) {
  const mine = shift.assignments.filter((a) => !orgId || a.supplierOrgId === orgId);
  const [reason, setReason] = useState('');
  const [cancelFor, setCancelFor] = useState<Assignment | null>(null);
  const withdraw = useAction((id: string) => api.post(`/assignments/${id}/withdraw`));
  const accept = useAction((id: string) => api.post(`/assignments/${id}/accept`));
  const decline = useAction((id: string) => api.post(`/assignments/${id}/decline`, {}));
  const cancel = useAction((id: string) => api.post(`/assignments/${id}/cancel`, { reason: reason || null }), () => { setCancelFor(null); setReason(''); });
  const started = new Date(shift.startsAt).getTime() <= Date.now();
  if (mine.length === 0) return null;
  return (
    <Card title="Your workers on this shift">
      <ErrorBanner error={withdraw.error ?? accept.error ?? decline.error ?? cancel.error} className="mb-3" />
      <ul className="divide-y divide-slate-100">
        {mine.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
            <div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-slate-900">{a.worker.firstName} {a.worker.lastName}</span>
                <StatusBadge status={a.status} />
                <TierBadge tier={a.tierAtRequest} />
                {a.lateCancellation && <Badge tone="red">Late cancellation</Badge>}
              </div>
              <div className="text-xs text-slate-500">{fmtDateTime(a.requestedAt)}{a.note && <> · “{a.note}”</>}{a.cancellationReason && <> · {a.cancellationReason}</>}</div>
            </div>
            <div className="flex gap-1.5">
              {a.status === 'REQUESTED' && <Button size="sm" variant="secondary" onClick={() => withdraw.mutate(a.id)} loading={withdraw.isPending}>Withdraw</Button>}
              {a.status === 'OFFERED' && (
                <>
                  <Button size="sm" variant="success" onClick={() => accept.mutate(a.id)} loading={accept.isPending}>Accept offer</Button>
                  <Button size="sm" variant="secondary" onClick={() => decline.mutate(a.id)} loading={decline.isPending}>Decline</Button>
                </>
              )}
              {a.status === 'CONFIRMED' && !started && <Button size="sm" variant="danger" onClick={() => setCancelFor(a)}>Cancel booking</Button>}
            </div>
          </li>
        ))}
      </ul>
      <Modal open={!!cancelFor} onClose={() => setCancelFor(null)} title="Cancel booking" footer={<><Button variant="secondary" onClick={() => setCancelFor(null)}>Back</Button><Button variant="danger" onClick={() => cancelFor && cancel.mutate(cancelFor.id)} loading={cancel.isPending}>Cancel booking</Button></>}>
        <InfoBanner tone="amber" className="mb-3">Cancelling close to the start time is recorded as a late cancellation against your organisation.</InfoBanner>
        <Field label="Reason"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </Modal>
    </Card>
  );
}

function PutForwardPanel({ shift }: { shift: ShiftDetail }) {
  const [override, setOverride] = useState(false);
  const [note, setNote] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['eligible', shift.id, override], queryFn: () => api.get<{ access: unknown; workers: EligibleWorker[] }>(`/shifts/${shift.id}/eligible-workers`, { allowHoursOverride: override }) });
  const request = useAction((workerId: string) => api.post<{ warnings: { message: string }[] }>(`/shifts/${shift.id}/requests`, { workerId, allowHoursOverride: override, note: note || null }));
  const open = shift.access?.open;
  const workers = q.data?.workers ?? [];
  const eligible = workers.filter((w) => w.eligible && !w.alreadyRequested);
  const others = workers.filter((w) => !w.eligible || w.alreadyRequested);
  return (
    <Card title="Put a worker forward" description={open ? 'Eligible workers can be requested now. The host confirms the booking.' : 'You can review eligibility now; requests open when your tier does.'}>
      <ErrorBanner error={request.error ?? q.error} className="mb-3" />
      {request.data && request.data.warnings?.length > 0 && <InfoBanner tone="amber" className="mb-3">Request sent with warnings: {request.data.warnings.map((w) => w.message).join(' · ')}</InfoBanner>}
      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <Field label="Note to host (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Has covered this unit before" /></Field>
        <div className="flex items-end"><Checkbox label="Allow 48h weekly-hours override" hint="Only applies to workers with a signed opt-out on file." checked={override} onChange={(e) => setOverride(e.target.checked)} /></div>
      </div>
      {q.isLoading ? <Loading /> : workers.length === 0 ? <EmptyState title="No active workers" description="Add workers under Workers to put them forward." /> : (
        <ul className="divide-y divide-slate-100">
          {[...eligible, ...others].map((w) => (
            <li key={w.id} className="py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className={cx('font-medium', w.eligible ? 'text-slate-900' : 'text-slate-500')}>{w.firstName} {w.lastName}</span>
                    <span className="text-xs text-slate-500">{JOB_ROLE_LABELS[w.jobRole]}</span>
                    {w.alreadyRequested ? <Badge tone="blue">Already put forward</Badge> : w.eligible ? <Badge tone="green">✓ Eligible</Badge> : <Badge tone="red">{w.blockers.length} blocker{w.blockers.length === 1 ? '' : 's'}</Badge>}
                    {w.warnings.length > 0 && <Badge tone="amber">{w.warnings.length} warning{w.warnings.length === 1 ? '' : 's'}</Badge>}
                    {!w.shareable && <Badge>Not shareable</Badge>}
                  </div>
                  <div className="text-xs text-slate-500">
                    {w.facts.weeklyHoursAfter}h this week after shift{w.facts.distanceKm != null && ` · ${w.facts.distanceKm} km from site`}{w.facts.restGapHours != null && ` · ${Math.round(w.facts.restGapHours)}h rest`}
                  </div>
                </div>
                <div className="flex gap-1.5">
                  {(w.blockers.length > 0 || w.warnings.length > 0) && <Button size="sm" variant="ghost" onClick={() => setExpanded(expanded === w.id ? null : w.id)}>{expanded === w.id ? 'Hide' : 'Why?'}</Button>}
                  {w.eligible && !w.alreadyRequested && <Button size="sm" disabled={!open} onClick={() => request.mutate(w.id)} loading={request.isPending}>Request</Button>}
                </div>
              </div>
              {expanded === w.id && (
                <ul className="mt-2 space-y-0.5 rounded-lg bg-slate-50 p-2 text-xs">
                  {w.blockers.map((b) => <li key={b.code} className="text-rose-700">✕ {b.message}</li>)}
                  {w.warnings.map((b) => <li key={b.code} className="text-amber-700">! {b.message}</li>)}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function WorkerRequestPanel({ shift, selfService }: { shift: ShiftDetail; selfService: boolean }) {
  const request = useAction(() => api.post<{ warnings: { message: string }[] }>(`/shifts/${shift.id}/requests`, {}));
  const withdraw = useAction((id: string) => api.post(`/assignments/${id}/withdraw`));
  const accept = useAction((id: string) => api.post(`/assignments/${id}/accept`));
  const decline = useAction((id: string) => api.post(`/assignments/${id}/decline`, {}));
  const mine = shift.assignments[0];
  return (
    <Card title="This shift and you">
      <ErrorBanner error={request.error ?? withdraw.error ?? accept.error ?? decline.error} className="mb-3" />
      {mine ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm"><StatusBadge status={mine.status} /><span className="text-slate-600">{humanise(mine.status)} {fmtDateTime(mine.respondedAt ?? mine.requestedAt)}</span></div>
          <div className="flex gap-1.5">
            {mine.status === 'REQUESTED' && <Button size="sm" variant="secondary" onClick={() => withdraw.mutate(mine.id)} loading={withdraw.isPending}>Withdraw</Button>}
            {mine.status === 'OFFERED' && (
              <>
                <Button size="sm" variant="success" onClick={() => accept.mutate(mine.id)} loading={accept.isPending}>Accept</Button>
                <Button size="sm" variant="secondary" onClick={() => decline.mutate(mine.id)} loading={decline.isPending}>Decline</Button>
              </>
            )}
          </div>
        </div>
      ) : !selfService ? (
        <p className="text-sm text-slate-600">Your employer books shifts on your behalf. Ask your manager to put you forward.</p>
      ) : shift.status !== 'OPEN' ? (
        <p className="text-sm text-slate-600">This shift is no longer open.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => request.mutate()} loading={request.isPending} disabled={!shift.access?.open || shift.myEligibility?.eligible === false}>Request this shift for me</Button>
          {!shift.access?.open && shift.access?.opensAt && <span className="text-xs text-slate-500"><Countdown to={shift.access.opensAt} /></span>}
          {request.data && request.data.warnings?.length > 0 && <span className="text-xs text-amber-700">{request.data.warnings.map((w) => w.message).join(' · ')}</span>}
        </div>
      )}
    </Card>
  );
}
