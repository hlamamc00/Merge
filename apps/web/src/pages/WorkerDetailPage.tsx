import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DOCUMENT_LABELS, DocumentType, JOB_ROLE_LABELS, JobRole, SKILL_LABELS, Skill, WorkerStatus, requiredDocumentsForRole } from '@merge/shared';
import { api } from '../api/client';
import { useAction } from '../api/hooks';
import type { WorkerDetail } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ComplianceBadge, StatusBadge } from '../components/badges';
import { Badge, Button, Card, Checkbox, DescriptionList, EmptyState, ErrorBanner, Field, Input, Loading, Modal, PageHeader, Select, Table, Textarea } from '../components/ui';
import { fmtDate, fmtDateTime, fmtShiftWindow, fromLocalInput, toDateInput, toLocalInput } from '../lib/format';

export function WorkerDetailPage() {
  const { id } = useParams();
  const { isManager } = useAuth();
  const q = useQuery({ queryKey: ['worker', id], queryFn: () => api.get<WorkerDetail>(`/workers/${id}`), enabled: !!id });
  const [edit, setEdit] = useState(false);
  const [addDoc, setAddDoc] = useState(false);
  const [addUnav, setAddUnav] = useState(false);
  const [login, setLogin] = useState(false);
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBanner error={q.error ?? 'Worker not found'} />;
  const w = q.data;
  const required = new Set(requiredDocumentsForRole(w.jobRole));

  return (
    <div className="space-y-5">
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-2">{w.firstName} {w.lastName} <StatusBadge status={w.status} /> <ComplianceBadge status={w.compliance.status} /> {w.shareable ? <Badge tone="brand">Shareable</Badge> : <Badge>Not shareable</Badge>}</span>}
        description={`${JOB_ROLE_LABELS[w.jobRole]}${w.averageRating != null ? ` · ★ ${w.averageRating.toFixed(1)} average rating` : ''}`}
        actions={isManager && <><Button variant="secondary" onClick={() => setEdit(true)}>Edit profile</Button>{!w.login && <Button variant="secondary" onClick={() => setLogin(true)}>Create login</Button>}</>}
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Profile" className="lg:col-span-2">
          <DescriptionList
            items={[
              { label: 'Email', value: w.email },
              { label: 'Phone', value: w.phone },
              { label: 'Home postcode', value: w.postcode },
              { label: 'Travel radius', value: w.travelRadiusKm != null ? `${w.travelRadiusKm} km` : null },
              { label: 'Contracted hours', value: w.contractedHoursPerWeek != null ? `${w.contractedHoursPerWeek}h / week` : null },
              { label: 'Max hours', value: `${w.maxHoursPerWeek ?? 48}h / week${w.optedOutOf48h ? ' (48h opt-out on file)' : ''}` },
              { label: 'Hourly pay (private)', value: w.hourlyPayRate != null ? `£${w.hourlyPayRate.toFixed(2)}` : null },
              { label: 'Login', value: w.login ? `${w.login.email} (${w.login.status.toLowerCase()})` : 'No login' },
            ]}
          />
          <div className="mt-3 flex flex-wrap gap-1">{w.skills.map((s) => <Badge key={s}>{SKILL_LABELS[s]}</Badge>)}</div>
          {w.notes && <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">{w.notes}</p>}
        </Card>
        <Card title="Compliance checklist" description={`Required for ${JOB_ROLE_LABELS[w.jobRole]}`}>
          <ul className="space-y-1.5 text-sm">
            {w.compliance.items.map((i) => (
              <li key={i.type} className="flex items-center justify-between gap-2">
                <span className="text-slate-700">{DOCUMENT_LABELS[i.type]}</span>
                <span className="flex items-center gap-1 text-xs text-slate-500">{i.expiresAt && fmtDate(i.expiresAt)}<StatusBadge status={i.status} /></span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card title="Documents" actions={isManager && <Button size="sm" onClick={() => setAddDoc(true)}>＋ Add document</Button>}>
        <DocumentsTable worker={w} required={required} canManage={isManager} />
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Upcoming shifts">
          {w.upcoming.length === 0 ? <EmptyState title="No upcoming shifts" /> : (
            <ul className="divide-y divide-slate-100">
              {w.upcoming.map(({ assignment, shift }) => (
                <li key={assignment.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <Link to={`/shifts/${shift.id}`} className="hover:underline"><div className="font-medium text-slate-900">{shift.title}</div><div className="text-xs text-slate-500">{fmtShiftWindow(shift.startsAt, shift.endsAt, shift.breakMinutes)}</div></Link>
                  <StatusBadge status={assignment.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Unavailability" description="Blocks the worker from being put forward during these periods." actions={<Button size="sm" variant="secondary" onClick={() => setAddUnav(true)}>＋ Add</Button>}>
          <UnavailabilityList worker={w} />
        </Card>
      </div>

      <EditWorkerModal open={edit} onClose={() => setEdit(false)} worker={w} />
      <AddDocumentModal open={addDoc} onClose={() => setAddDoc(false)} workerId={w.id} />
      <AddUnavailabilityModal open={addUnav} onClose={() => setAddUnav(false)} workerId={w.id} />
      <CreateLoginModal open={login} onClose={() => setLogin(false)} worker={w} />
    </div>
  );
}

function DocumentsTable({ worker, required, canManage }: { worker: WorkerDetail; required: Set<DocumentType>; canManage: boolean }) {
  const verify = useAction((docId: string) => api.patch(`/workers/${worker.id}/documents/${docId}`, { verified: true }));
  const remove = useAction((docId: string) => api.delete(`/workers/${worker.id}/documents/${docId}`));
  return (
    <>
      <ErrorBanner error={verify.error ?? remove.error} className="mb-3" />
      <Table
        rows={worker.documents}
        rowKey={(d) => d.id}
        empty={<EmptyState title="No documents uploaded" description="Add DBS, right to work, training certificates and so on. Documents must be verified before the worker can be sent on shifts." />}
        columns={[
          { key: 'type', header: 'Document', render: (d) => <span className="font-medium text-slate-900">{DOCUMENT_LABELS[d.type]}{required.has(d.type) && <span className="ml-1 text-xs text-slate-400">required</span>}</span> },
          { key: 'ref', header: 'Reference', render: (d) => d.reference ?? '—' },
          { key: 'issued', header: 'Issued', render: (d) => fmtDate(d.issuedAt) },
          { key: 'expires', header: 'Expires', render: (d) => fmtDate(d.expiresAt) },
          { key: 'verified', header: 'Verified', render: (d) => (d.verifiedAt ? <Badge tone="green">✓ {fmtDate(d.verifiedAt)}</Badge> : <Badge tone="amber">Pending</Badge>) },
          { key: 'file', header: 'File', render: (d) => (d.fileUrl ? <a href={d.fileUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">Open ↗</a> : '—') },
          { key: 'actions', header: '', align: 'right', render: (d) => canManage && (
            <span className="flex justify-end gap-1">
              {!d.verifiedAt && <Button size="sm" variant="success" onClick={() => verify.mutate(d.id)} loading={verify.isPending}>Verify</Button>}
              <Button size="sm" variant="ghost" onClick={() => remove.mutate(d.id)} loading={remove.isPending}>Remove</Button>
            </span>
          ) },
        ]}
      />
    </>
  );
}

function UnavailabilityList({ worker }: { worker: WorkerDetail }) {
  const remove = useAction((uid: string) => api.delete(`/workers/${worker.id}/unavailability/${uid}`));
  if (worker.unavailability.length === 0) return <EmptyState title="No unavailability recorded" />;
  return (
    <ul className="divide-y divide-slate-100 text-sm">
      {worker.unavailability.map((u) => (
        <li key={u.id} className="flex items-center justify-between py-2">
          <span>{fmtDateTime(u.startsAt)} – {fmtDateTime(u.endsAt)}{u.reason && <span className="text-xs text-slate-500"> · {u.reason}</span>}</span>
          <Button size="sm" variant="ghost" onClick={() => remove.mutate(u.id)} loading={remove.isPending}>Remove</Button>
        </li>
      ))}
    </ul>
  );
}

function EditWorkerModal({ open, onClose, worker }: { open: boolean; onClose: () => void; worker: WorkerDetail }) {
  const [form, setForm] = useState({
    firstName: worker.firstName, lastName: worker.lastName, email: worker.email ?? '', phone: worker.phone ?? '', jobRole: worker.jobRole, skills: worker.skills, status: worker.status, shareable: worker.shareable,
    postcode: worker.postcode ?? '', travelRadiusKm: worker.travelRadiusKm?.toString() ?? '', contractedHoursPerWeek: worker.contractedHoursPerWeek?.toString() ?? '', maxHoursPerWeek: worker.maxHoursPerWeek?.toString() ?? '', optedOutOf48h: worker.optedOutOf48h, hourlyPayRate: worker.hourlyPayRate?.toString() ?? '', notes: worker.notes ?? '',
  });
  const save = useAction(
    () => api.patch(`/workers/${worker.id}`, { ...form, email: form.email || null, phone: form.phone || null, postcode: form.postcode || null, travelRadiusKm: form.travelRadiusKm ? Number(form.travelRadiusKm) : null, contractedHoursPerWeek: form.contractedHoursPerWeek ? Number(form.contractedHoursPerWeek) : null, maxHoursPerWeek: form.maxHoursPerWeek ? Number(form.maxHoursPerWeek) : null, hourlyPayRate: form.hourlyPayRate ? Number(form.hourlyPayRate) : null, notes: form.notes || null }),
    onClose,
  );
  const toggle = (s: Skill) => setForm({ ...form, skills: form.skills.includes(s) ? form.skills.filter((x) => x !== s) : [...form.skills, s] });
  return (
    <Modal open={open} onClose={onClose} title="Edit worker" wide footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending}>Save</Button></>}>
      <div className="space-y-3">
        <ErrorBanner error={save.error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First name"><Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></Field>
          <Field label="Last name"><Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></Field>
          <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Phone"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Role"><Select value={form.jobRole} onChange={(e) => setForm({ ...form, jobRole: e.target.value as JobRole })}>{Object.values(JobRole).map((r) => <option key={r} value={r}>{JOB_ROLE_LABELS[r]}</option>)}</Select></Field>
          <Field label="Status"><Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as WorkerStatus })}>{Object.values(WorkerStatus).map((s) => <option key={s} value={s}>{s.replace('_', ' ').toLowerCase()}</option>)}</Select></Field>
          <Field label="Home postcode"><Input value={form.postcode} onChange={(e) => setForm({ ...form, postcode: e.target.value })} /></Field>
          <Field label="Travel radius (km)"><Input type="number" value={form.travelRadiusKm} onChange={(e) => setForm({ ...form, travelRadiusKm: e.target.value })} /></Field>
          <Field label="Contracted hours / week"><Input type="number" value={form.contractedHoursPerWeek} onChange={(e) => setForm({ ...form, contractedHoursPerWeek: e.target.value })} /></Field>
          <Field label="Max hours / week"><Input type="number" value={form.maxHoursPerWeek} onChange={(e) => setForm({ ...form, maxHoursPerWeek: e.target.value })} /></Field>
          <Field label="Hourly pay (private)"><Input type="number" step="0.25" value={form.hourlyPayRate} onChange={(e) => setForm({ ...form, hourlyPayRate: e.target.value })} /></Field>
        </div>
        <Field label="Skills"><div className="grid grid-cols-2 gap-1 sm:grid-cols-3">{Object.values(Skill).map((s) => <Checkbox key={s} label={SKILL_LABELS[s]} checked={form.skills.includes(s)} onChange={() => toggle(s)} />)}</div></Field>
        <Checkbox label="Shareable" hint="Can be lent to other organisations." checked={form.shareable} onChange={(e) => setForm({ ...form, shareable: e.target.checked })} />
        <Checkbox label="48-hour opt-out signed" hint="Allows managers to override the weekly hours cap for this worker." checked={form.optedOutOf48h} onChange={(e) => setForm({ ...form, optedOutOf48h: e.target.checked })} />
        <Field label="Notes (private)"><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function AddDocumentModal({ open, onClose, workerId }: { open: boolean; onClose: () => void; workerId: string }) {
  const [form, setForm] = useState({ type: 'DBS' as DocumentType, reference: '', issuedAt: '', expiresAt: toDateInput(new Date(Date.now() + 365 * 86_400_000)), fileUrl: '', notes: '', verify: true });
  const create = useAction(async () => {
    const doc = await api.post<{ id: string }>(`/workers/${workerId}/documents`, { type: form.type, reference: form.reference || null, issuedAt: form.issuedAt ? new Date(form.issuedAt).toISOString() : null, expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null, fileUrl: form.fileUrl || null, notes: form.notes || null });
    if (form.verify) await api.patch(`/workers/${workerId}/documents/${doc.id}`, { verified: true });
    return doc;
  }, onClose);
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };
  return (
    <Modal open={open} onClose={onClose} title="Add document" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button form="doc-form" type="submit" loading={create.isPending}>Add</Button></>}>
      <form id="doc-form" onSubmit={submit} className="space-y-3">
        <ErrorBanner error={create.error} />
        <Field label="Type" required><Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as DocumentType })}>{Object.values(DocumentType).map((d) => <option key={d} value={d}>{DOCUMENT_LABELS[d]}</option>)}</Select></Field>
        <Field label="Reference / certificate number"><Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Issued"><Input type="date" value={form.issuedAt} onChange={(e) => setForm({ ...form, issuedAt: e.target.value })} /></Field>
          <Field label="Expires" hint="Leave blank if it does not expire."><Input type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} /></Field>
        </div>
        <Field label="File link" hint="URL of the scanned document in your document store."><Input type="url" value={form.fileUrl} onChange={(e) => setForm({ ...form, fileUrl: e.target.value })} placeholder="https://" /></Field>
        <Field label="Notes"><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        <Checkbox label="I have checked the original and verify this document" checked={form.verify} onChange={(e) => setForm({ ...form, verify: e.target.checked })} />
      </form>
    </Modal>
  );
}

function AddUnavailabilityModal({ open, onClose, workerId }: { open: boolean; onClose: () => void; workerId: string }) {
  const start = new Date();
  const end = new Date(Date.now() + 86_400_000);
  const [form, setForm] = useState({ startsAt: toLocalInput(start), endsAt: toLocalInput(end), reason: '' });
  const create = useAction(() => api.post(`/workers/${workerId}/unavailability`, { startsAt: fromLocalInput(form.startsAt), endsAt: fromLocalInput(form.endsAt), reason: form.reason || null }), onClose);
  return (
    <Modal open={open} onClose={onClose} title="Add unavailability" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => create.mutate()} loading={create.isPending}>Add</Button></>}>
      <div className="space-y-3">
        <ErrorBanner error={create.error} />
        <Field label="From"><Input type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} /></Field>
        <Field label="Until"><Input type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} /></Field>
        <Field label="Reason"><Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Annual leave" /></Field>
      </div>
    </Modal>
  );
}

function CreateLoginModal({ open, onClose, worker }: { open: boolean; onClose: () => void; worker: WorkerDetail }) {
  const [form, setForm] = useState({ email: worker.email ?? '', password: '' });
  const create = useAction(() => api.post(`/workers/${worker.id}/login`, form), onClose);
  return (
    <Modal open={open} onClose={onClose} title="Create worker login" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => create.mutate()} loading={create.isPending}>Create login</Button></>}>
      <div className="space-y-3">
        <ErrorBanner error={create.error} />
        <p className="text-sm text-slate-600">The worker will be able to see their bookings and timesheets, and request shifts for themselves if self-service is enabled in Settings.</p>
        <Field label="Email" required><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Temporary password" required hint="At least 8 characters."><Input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} minLength={8} /></Field>
      </div>
    </Modal>
  );
}
