import { useQuery } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DOCUMENT_LABELS, DocumentType, JOB_ROLE_LABELS, JobRole, SKILL_LABELS, Skill, WorkerStatus, requiredDocumentsForRole } from '@merge/shared';
import { ApiError, api } from '../api/client';
import { useAction, useSites } from '../api/hooks';
import type { DirectoryOrg, WorkerDetail } from '../api/types';
import type { DocumentWithFile, HostRequirement, WorkerHostRequirement } from '../api/types.compliance';
import { useAuth } from '../auth/AuthContext';
import { ComplianceBadge, StatusBadge } from '../components/badges';
import { Badge, Button, Card, Checkbox, DescriptionList, EmptyState, ErrorBanner, Field, InfoBanner, Input, Loading, Modal, PageHeader, Select, Table, Textarea } from '../components/ui';
import { fmtBytes, openProtectedFile, uploadFile } from '../lib/files';
import { fmtDate, fmtDateTime, fmtShiftWindow, fromLocalInput, toDateInput, toLocalInput } from '../lib/format';

type Detail = Omit<WorkerDetail, 'documents' | 'login'> & {
  homeSiteId?: string | null;
  homeSiteName?: string | null;
  consentToShareAt?: string | null;
  documents: DocumentWithFile[];
  hostRequirements?: WorkerHostRequirement[];
  login: (WorkerDetail['login'] & { twoFactorEnabled?: boolean; lastLoginAt?: string | null }) | null;
  viewer?: { canManage: boolean; isSelf: boolean };
};

export function WorkerDetailPage() {
  const { id } = useParams();
  const { isManager } = useAuth();
  const q = useQuery({ queryKey: ['worker', id], queryFn: () => api.get<Detail>(`/workers/${id}`), enabled: !!id });
  const [edit, setEdit] = useState(false);
  const [addDoc, setAddDoc] = useState(false);
  const [addUnav, setAddUnav] = useState(false);
  const [login, setLogin] = useState(false);
  const [invite, setInvite] = useState(false);
  const [declare, setDeclare] = useState(false);
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBanner error={q.error ?? 'Worker not found'} />;
  const w = q.data;
  const required = new Set(requiredDocumentsForRole(w.jobRole));
  const canManage = w.viewer?.canManage ?? isManager;
  const isSelf = w.viewer?.isSelf ?? false;

  return (
    <div className="space-y-5">
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-2">{w.firstName} {w.lastName} <StatusBadge status={w.status} /> <ComplianceBadge status={w.compliance.status} /> {w.shareable ? <Badge tone="brand">Shareable</Badge> : <Badge>Not shareable</Badge>}</span>}
        description={`${JOB_ROLE_LABELS[w.jobRole]}${w.homeSiteName ? ` · ${w.homeSiteName}` : ''}${w.averageRating != null ? ` · ★ ${w.averageRating.toFixed(1)} average rating` : ''}`}
        actions={canManage && <><Button variant="secondary" onClick={() => setEdit(true)}>Edit profile</Button>{!w.login && <Button onClick={() => setInvite(true)}>Invite to log in</Button>}</>}
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Profile" className="lg:col-span-2">
          <DescriptionList
            items={[
              { label: 'Email', value: w.email },
              { label: 'Phone', value: w.phone },
              { label: 'Home site', value: w.homeSiteName ?? 'Not assigned' },
              { label: 'Home postcode', value: w.postcode },
              { label: 'Travel radius', value: w.travelRadiusKm != null ? `${w.travelRadiusKm} km` : null },
              { label: 'Contracted hours', value: w.contractedHoursPerWeek != null ? `${w.contractedHoursPerWeek}h / week` : null },
              { label: 'Max hours', value: `${w.maxHoursPerWeek ?? 48}h / week${w.optedOutOf48h ? ' (48h opt-out on file)' : ''}` },
              { label: 'Hourly pay (private)', value: w.hourlyPayRate != null ? `£${w.hourlyPayRate.toFixed(2)}` : null },
              { label: 'Consent to share profile', value: w.consentToShareAt ? `Given ${fmtDate(w.consentToShareAt)}` : 'Not recorded' },
              { label: 'Login', value: w.login ? `${w.login.email} (${w.login.status.toLowerCase()}${w.login.lastLoginAt ? `, last seen ${fmtDate(w.login.lastLoginAt)}` : ', never signed in'})` : 'No login' },
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

      <Card title="Documents" description={isSelf && !canManage ? 'Add your certificates here; your manager verifies them against the originals.' : 'Verified documents are part of the compliance record: correcting one keeps the old version as history.'} actions={(canManage || isSelf) && <Button size="sm" onClick={() => setAddDoc(true)}>＋ Add document</Button>}>
        <DocumentsTable worker={w} required={required} canManage={canManage} canAttach={canManage || isSelf} />
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Host-specific requirements" description="Extra requirements particular hosts ask for (inductions, specialist training). Declare the ones this worker holds." actions={canManage && <Button size="sm" variant="secondary" onClick={() => setDeclare(true)}>＋ Declare</Button>}>
          <HostRequirementsList worker={w} canManage={canManage} />
        </Card>
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
      </div>

      <Card title="Unavailability" description="Blocks the worker from being put forward during these periods." actions={<Button size="sm" variant="secondary" onClick={() => setAddUnav(true)}>＋ Add</Button>}>
        <UnavailabilityList worker={w} />
      </Card>

      <EditWorkerModal open={edit} onClose={() => setEdit(false)} worker={w} />
      <AddDocumentModal open={addDoc} onClose={() => setAddDoc(false)} workerId={w.id} canVerify={canManage} />
      <AddUnavailabilityModal open={addUnav} onClose={() => setAddUnav(false)} workerId={w.id} />
      <CreateLoginModal open={login} onClose={() => setLogin(false)} worker={w} />
      <InviteModal open={invite} onClose={() => setInvite(false)} worker={w} onFallback={() => { setInvite(false); setLogin(true); }} />
      <DeclareRequirementModal open={declare} onClose={() => setDeclare(false)} worker={w} />
    </div>
  );
}

function DocumentsTable({ worker, required, canManage, canAttach }: { worker: Detail; required: Set<DocumentType>; canManage: boolean; canAttach: boolean }) {
  const verify = useAction((docId: string) => api.patch(`/workers/${worker.id}/documents/${docId}`, { verified: true }));
  const remove = useAction((docId: string) => api.delete(`/workers/${worker.id}/documents/${docId}`));
  const attach = useAction((args: { docId: string; file: File }) => uploadFile(`/workers/${worker.id}/documents/${args.docId}/file`, args.file));
  const [openError, setOpenError] = useState<unknown>(null);
  const [correcting, setCorrecting] = useState<DocumentWithFile | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<string | null>(null);
  const pick = (docId: string) => {
    setTarget(docId);
    fileInput.current?.click();
  };
  const [showHistory, setShowHistory] = useState(false);
  const rows = worker.documents.filter((d) => showHistory || !d.supersededAt);
  const history = worker.documents.length - worker.documents.filter((d) => !d.supersededAt).length;
  return (
    <>
      <ErrorBanner error={verify.error ?? remove.error ?? attach.error ?? openError} className="mb-3" />
      <input ref={fileInput} type="file" accept="application/pdf,image/jpeg,image/png" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f && target) attach.mutate({ docId: target, file: f }); e.target.value = ''; }} />
      <Table
        rows={rows}
        rowKey={(d) => d.id}
        empty={<EmptyState title="No documents yet" description="Add DBS, right to work, training certificates and so on. Documents must be verified before the worker can be sent on shifts." />}
        columns={[
          { key: 'type', header: 'Document', render: (d) => <span className={d.supersededAt ? 'text-slate-400 line-through' : 'font-medium text-slate-900'}>{DOCUMENT_LABELS[d.type]}{required.has(d.type) && !d.supersededAt && <span className="ml-1 text-xs font-normal text-slate-400">required</span>}{d.replacesDocumentId && <span className="ml-1 text-xs font-normal text-slate-400">(correction)</span>}</span> },
          { key: 'ref', header: 'Reference', render: (d) => d.reference ?? '—' },
          { key: 'issued', header: 'Issued', render: (d) => fmtDate(d.issuedAt) },
          { key: 'expires', header: 'Expires', render: (d) => fmtDate(d.expiresAt) },
          { key: 'verified', header: 'Verified', render: (d) => d.supersededAt ? <Badge>Replaced {fmtDate(d.supersededAt)}</Badge> : d.verifiedAt ? <Badge tone="green">✓ {fmtDate(d.verifiedAt)}</Badge> : <Badge tone="amber">Pending</Badge> },
          { key: 'file', header: 'File', render: (d) => (
            <span className="flex items-center gap-2 text-xs">
              {d.hasFile && <button type="button" className="text-brand-700 hover:underline" onClick={() => openProtectedFile(`/workers/${worker.id}/documents/${d.id}/file`).catch(setOpenError)}>{d.fileName ?? 'Open'} {fmtBytes(d.fileSize)}</button>}
              {!d.hasFile && d.fileUrl && <a href={d.fileUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">Link ↗</a>}
              {!d.hasFile && !d.fileUrl && <span className="text-slate-400">—</span>}
              {canAttach && !d.supersededAt && <button type="button" className="text-slate-500 hover:underline" onClick={() => pick(d.id)} disabled={attach.isPending}>{d.hasFile ? 'Replace' : 'Upload'}</button>}
            </span>
          ) },
          { key: 'actions', header: '', align: 'right', render: (d) => canManage && !d.supersededAt && (
            <span className="flex justify-end gap-1">
              {!d.verifiedAt && <Button size="sm" variant="success" onClick={() => verify.mutate(d.id)} loading={verify.isPending}>Verify</Button>}
              <Button size="sm" variant="secondary" onClick={() => setCorrecting(d)}>{d.verifiedAt ? 'Correct' : 'Edit'}</Button>
              {!d.verifiedAt && <Button size="sm" variant="ghost" onClick={() => remove.mutate(d.id)} loading={remove.isPending}>Remove</Button>}
            </span>
          ) },
        ]}
      />
      {history > 0 && <button type="button" className="mt-2 text-xs text-slate-500 hover:underline" onClick={() => setShowHistory((v) => !v)}>{showHistory ? 'Hide' : 'Show'} {history} replaced version{history === 1 ? '' : 's'}</button>}
      {correcting && <CorrectDocumentModal workerId={worker.id} doc={correcting} onClose={() => setCorrecting(null)} />}
    </>
  );
}

function CorrectDocumentModal({ workerId, doc, onClose }: { workerId: string; doc: DocumentWithFile; onClose: () => void }) {
  const [form, setForm] = useState({ type: doc.type, reference: doc.reference ?? '', issuedAt: doc.issuedAt ? toDateInput(new Date(doc.issuedAt)) : '', expiresAt: doc.expiresAt ? toDateInput(new Date(doc.expiresAt)) : '', notes: doc.notes ?? '', verify: false });
  const save = useAction(() => api.patch(`/workers/${workerId}/documents/${doc.id}`, { type: form.type, reference: form.reference || null, issuedAt: form.issuedAt ? new Date(form.issuedAt).toISOString() : null, expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null, notes: form.notes || null, ...(form.verify ? { verified: true } : {}) }), onClose);
  return (
    <Modal open onClose={onClose} title={doc.verifiedAt ? 'Correct a verified document' : 'Edit document'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending}>Save</Button></>}>
      <div className="space-y-3">
        <ErrorBanner error={save.error} />
        {doc.verifiedAt && <InfoBanner tone="amber">Changing the type, reference or dates of a verified document creates a new version that needs verifying again. The old version is kept as history.</InfoBanner>}
        <Field label="Type"><Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as DocumentType })}>{Object.values(DocumentType).map((d) => <option key={d} value={d}>{DOCUMENT_LABELS[d]}</option>)}</Select></Field>
        <Field label="Reference / certificate number"><Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Issued"><Input type="date" value={form.issuedAt} onChange={(e) => setForm({ ...form, issuedAt: e.target.value })} /></Field>
          <Field label="Expires"><Input type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} /></Field>
        </div>
        <Field label="Notes"><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        <Checkbox label="I have checked the original and verify the corrected details" checked={form.verify} onChange={(e) => setForm({ ...form, verify: e.target.checked })} />
      </div>
    </Modal>
  );
}

function HostRequirementsList({ worker, canManage }: { worker: Detail; canManage: boolean }) {
  const remove = useAction((requirementId: string) => api.delete(`/compliance/requirements/${requirementId}/workers/${worker.id}`));
  const list = worker.hostRequirements ?? [];
  if (list.length === 0) return <EmptyState title="None declared" description="When a host asks for something beyond the standard checks, declare it here so this worker is eligible for their shifts." />;
  return (
    <>
      <ErrorBanner error={remove.error} className="mb-2" />
      <ul className="divide-y divide-slate-100 text-sm">
        {list.map((r) => (
          <li key={r.requirementId} className="flex items-center justify-between gap-2 py-2">
            <div>
              <div className="font-medium text-slate-900">{r.name} <span className="text-xs font-normal text-slate-500">· {r.hostName}</span>{r.archivedAt && <Badge className="ml-1">archived</Badge>}</div>
              <div className="text-xs text-slate-500">{r.recordedByHost ? 'Recorded by the host' : 'Declared by employer'} {fmtDate(r.recordedAt)}{r.expiresAt ? ` · ${r.expired ? 'expired' : 'expires'} ${fmtDate(r.expiresAt)}` : ''}</div>
            </div>
            {canManage && !r.recordedByHost && <Button size="sm" variant="ghost" onClick={() => remove.mutate(r.requirementId)} loading={remove.isPending}>Remove</Button>}
          </li>
        ))}
      </ul>
    </>
  );
}

function DeclareRequirementModal({ open, onClose, worker }: { open: boolean; onClose: () => void; worker: Detail }) {
  const [hostOrgId, setHostOrgId] = useState('');
  const [requirementId, setRequirementId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [documentId, setDocumentId] = useState('');
  const orgs = useQuery({ queryKey: ['organisations'], queryFn: () => api.get<DirectoryOrg[]>('/organisations'), enabled: open });
  const reqs = useQuery({ queryKey: ['requirements', hostOrgId], queryFn: () => api.get<HostRequirement[]>('/compliance/requirements', { hostOrgId }), enabled: open && !!hostOrgId });
  const save = useAction(() => api.post(`/compliance/requirements/${requirementId}/workers`, { workerId: worker.id, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null, documentId: documentId || null }), onClose);
  const declarable = (reqs.data ?? []).filter((r) => !r.recordedByHost);
  return (
    <Modal open={open} onClose={onClose} title="Declare a host requirement" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!requirementId}>Declare</Button></>}>
      <div className="space-y-3">
        <ErrorBanner error={save.error} />
        <Field label="Host organisation"><Select value={hostOrgId} onChange={(e) => { setHostOrgId(e.target.value); setRequirementId(''); }}><option value="">Choose…</option>{(orgs.data ?? []).filter((o) => o.id !== worker.orgId).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
        {hostOrgId && (
          <Field label="Requirement" hint={reqs.data && declarable.length === 0 ? 'This host has no employer-declared requirements (inductions are recorded by the host itself).' : undefined}>
            <Select value={requirementId} onChange={(e) => setRequirementId(e.target.value)}><option value="">Choose…</option>{declarable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>
          </Field>
        )}
        {requirementId && reqs.data?.find((r) => r.id === requirementId)?.description && <p className="text-xs text-slate-500">{reqs.data.find((r) => r.id === requirementId)!.description}</p>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Expires" hint="If the host sets a validity period."><Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} /></Field>
          <Field label="Evidence" hint="Optionally link one of the worker's documents."><Select value={documentId} onChange={(e) => setDocumentId(e.target.value)}><option value="">None</option>{worker.documents.filter((d) => !d.supersededAt).map((d) => <option key={d.id} value={d.id}>{DOCUMENT_LABELS[d.type]}{d.reference ? ` (${d.reference})` : ''}</option>)}</Select></Field>
        </div>
      </div>
    </Modal>
  );
}

function UnavailabilityList({ worker }: { worker: Detail }) {
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

function EditWorkerModal({ open, onClose, worker }: { open: boolean; onClose: () => void; worker: Detail }) {
  const sites = useSites(worker.orgId);
  const [form, setForm] = useState({
    firstName: worker.firstName, lastName: worker.lastName, email: worker.email ?? '', phone: worker.phone ?? '', jobRole: worker.jobRole, skills: worker.skills, status: worker.status, shareable: worker.shareable,
    postcode: worker.postcode ?? '', travelRadiusKm: worker.travelRadiusKm?.toString() ?? '', contractedHoursPerWeek: worker.contractedHoursPerWeek?.toString() ?? '', maxHoursPerWeek: worker.maxHoursPerWeek?.toString() ?? '', optedOutOf48h: worker.optedOutOf48h, hourlyPayRate: worker.hourlyPayRate?.toString() ?? '', notes: worker.notes ?? '',
    homeSiteId: worker.homeSiteId ?? '', consentToShare: !!worker.consentToShareAt,
  });
  const canSeePay = worker.hourlyPayRate !== undefined;
  const save = useAction(
    () => api.patch(`/workers/${worker.id}`, { ...form, email: form.email || null, phone: form.phone || null, postcode: form.postcode || null, homeSiteId: form.homeSiteId || null, travelRadiusKm: form.travelRadiusKm ? Number(form.travelRadiusKm) : null, contractedHoursPerWeek: form.contractedHoursPerWeek ? Number(form.contractedHoursPerWeek) : null, maxHoursPerWeek: form.maxHoursPerWeek ? Number(form.maxHoursPerWeek) : null, ...(canSeePay ? { hourlyPayRate: form.hourlyPayRate ? Number(form.hourlyPayRate) : null, notes: form.notes || null } : { hourlyPayRate: undefined, notes: undefined }) }),
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
          <Field label="Home site"><Select value={form.homeSiteId} onChange={(e) => setForm({ ...form, homeSiteId: e.target.value })}><option value="">Not assigned</option>{(sites.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label="Home postcode"><Input value={form.postcode} onChange={(e) => setForm({ ...form, postcode: e.target.value })} /></Field>
          <Field label="Travel radius (km)"><Input type="number" value={form.travelRadiusKm} onChange={(e) => setForm({ ...form, travelRadiusKm: e.target.value })} /></Field>
          <Field label="Contracted hours / week"><Input type="number" value={form.contractedHoursPerWeek} onChange={(e) => setForm({ ...form, contractedHoursPerWeek: e.target.value })} /></Field>
          <Field label="Max hours / week"><Input type="number" value={form.maxHoursPerWeek} onChange={(e) => setForm({ ...form, maxHoursPerWeek: e.target.value })} /></Field>
          {canSeePay && <Field label="Hourly pay (private)"><Input type="number" step="0.25" value={form.hourlyPayRate} onChange={(e) => setForm({ ...form, hourlyPayRate: e.target.value })} /></Field>}
        </div>
        <Field label="Skills"><div className="grid grid-cols-2 gap-1 sm:grid-cols-3">{Object.values(Skill).map((s) => <Checkbox key={s} label={SKILL_LABELS[s]} checked={form.skills.includes(s)} onChange={() => toggle(s)} />)}</div></Field>
        <Checkbox label="Shareable" hint="Can be lent to other organisations." checked={form.shareable} onChange={(e) => setForm({ ...form, shareable: e.target.checked })} />
        <Checkbox label="Consent to share profile recorded" hint="The worker agrees to their name, role, skills and compliance status being shown to other organisations." checked={form.consentToShare} onChange={(e) => setForm({ ...form, consentToShare: e.target.checked })} />
        <Checkbox label="48-hour opt-out signed" hint="Allows managers to override the weekly hours cap for this worker." checked={form.optedOutOf48h} onChange={(e) => setForm({ ...form, optedOutOf48h: e.target.checked })} />
        {canSeePay && <Field label="Notes (private)"><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>}
      </div>
    </Modal>
  );
}

function AddDocumentModal({ open, onClose, workerId, canVerify }: { open: boolean; onClose: () => void; workerId: string; canVerify: boolean }) {
  const [form, setForm] = useState({ type: 'DBS' as DocumentType, reference: '', issuedAt: '', expiresAt: toDateInput(new Date(Date.now() + 365 * 86_400_000)), fileUrl: '', notes: '', verify: canVerify });
  const [file, setFile] = useState<File | null>(null);
  const create = useAction(async () => {
    const doc = await api.post<{ id: string }>(`/workers/${workerId}/documents`, { type: form.type, reference: form.reference || null, issuedAt: form.issuedAt ? new Date(form.issuedAt).toISOString() : null, expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null, fileUrl: form.fileUrl || null, notes: form.notes || null });
    if (file) await uploadFile(`/workers/${workerId}/documents/${doc.id}/file`, file);
    if (canVerify && form.verify) await api.patch(`/workers/${workerId}/documents/${doc.id}`, { verified: true });
    return doc;
  }, () => { setFile(null); onClose(); });
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
        <Field label="Scanned copy" hint="PDF, JPEG or PNG up to 10 MB. Stored privately; only your organisation and the worker can open it."><Input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        <Field label="Or a link" hint="URL of the scanned document in your own document store."><Input type="url" value={form.fileUrl} onChange={(e) => setForm({ ...form, fileUrl: e.target.value })} placeholder="https://" /></Field>
        <Field label="Notes"><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        {canVerify ? <Checkbox label="I have checked the original and verify this document" checked={form.verify} onChange={(e) => setForm({ ...form, verify: e.target.checked })} /> : <InfoBanner tone="slate">Your manager will verify this document against the original before it counts.</InfoBanner>}
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

/** Preferred: email the worker an invitation so they choose their own password. Falls back to a manager-set password where invitations are unavailable. */
function InviteModal({ open, onClose, worker, onFallback }: { open: boolean; onClose: () => void; worker: Detail; onFallback: () => void }) {
  const [email, setEmail] = useState(worker.email ?? '');
  const [sent, setSent] = useState<{ email: string } | null>(null);
  const invite = useAction(
    async () => {
      try {
        return await api.post<{ email?: string }>('/onboarding/invitations', { email, role: 'WORKER', workerId: worker.id, firstName: worker.firstName, lastName: worker.lastName });
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          onFallback();
          return null;
        }
        throw err;
      }
    },
    (r) => { if (r) setSent({ email }); },
  );
  return (
    <Modal open={open} onClose={() => { setSent(null); onClose(); }} title="Invite worker to log in" footer={sent ? <Button onClick={() => { setSent(null); onClose(); }}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => invite.mutate()} loading={invite.isPending} disabled={!email}>Send invitation</Button></>}>
      <div className="space-y-3">
        <ErrorBanner error={invite.error} />
        {sent ? (
          <InfoBanner tone="green">An invitation has been sent to {sent.email}. The link lets {worker.firstName} choose a password and sign in to see their shifts and documents.</InfoBanner>
        ) : (
          <>
            <p className="text-sm text-slate-600">{worker.firstName} will receive an email with a link to set their own password. They can then see their bookings, timesheets and documents, and request shifts if self-service is enabled.</p>
            <Field label="Email" required><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <p className="text-xs text-slate-500">Prefer to set a temporary password yourself? <button type="button" className="font-medium text-brand-700 hover:underline" onClick={onFallback}>Create a login manually</button>.</p>
          </>
        )}
      </div>
    </Modal>
  );
}

function CreateLoginModal({ open, onClose, worker }: { open: boolean; onClose: () => void; worker: Detail }) {
  const [form, setForm] = useState({ email: worker.email ?? '', password: '' });
  const create = useAction(() => api.post(`/workers/${worker.id}/login`, form), onClose);
  return (
    <Modal open={open} onClose={onClose} title="Create worker login" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => create.mutate()} loading={create.isPending}>Create login</Button></>}>
      <div className="space-y-3">
        <ErrorBanner error={create.error} />
        <p className="text-sm text-slate-600">The worker will be able to see their bookings and timesheets, and request shifts for themselves if self-service is enabled in Settings. Tell them the temporary password in person.</p>
        <Field label="Email" required><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Temporary password" required hint="At least 8 characters."><Input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} minLength={8} /></Field>
      </div>
    </Modal>
  );
}
