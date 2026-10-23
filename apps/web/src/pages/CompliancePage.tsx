import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { DOCUMENT_LABELS, DocumentType, JOB_ROLE_LABELS } from '@merge/shared';
import { api } from '../api/client';
import { useAction, useSites } from '../api/hooks';
import type { ComplianceOverview, ExpiringDocument, HostRequirement, MyDocuments, QueuedDocument, RequirementHolder, WorkforceReport } from '../api/types.compliance';
import { useAuth } from '../auth/AuthContext';
import { StatusBadge } from '../components/badges';
import { Badge, Button, Card, Checkbox, EmptyState, ErrorBanner, Field, InfoBanner, Input, Loading, Modal, PageHeader, Select, StatCard, Table, Tabs, Textarea } from '../components/ui';
import { fmtBytes, openProtectedFile, uploadFile } from '../lib/files';
import { fmtDate, fmtDateTime, toDateInput } from '../lib/format';
import { downloadCsv } from './FinancePage';

type Tab = 'expiring' | 'queue' | 'requirements';

export function CompliancePage() {
  const { isWorker } = useAuth();
  if (isWorker) return <MyDocumentsPage />;
  return <ManagerCompliancePage />;
}

function ManagerCompliancePage() {
  const [tab, setTab] = useState<Tab>('expiring');
  const summary = useQuery({ queryKey: ['compliance-summary'], queryFn: () => api.get<ComplianceOverview>('/compliance/summary') });
  const s = summary.data;
  return (
    <div className="space-y-5">
      <PageHeader title="Compliance" description="Keep every worker's checks and training current, verify what they upload, and manage the extra requirements hosts ask for." />
      {s && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <StatCard label="Workers compliant" value={s.workers.compliant} hint={`of ${s.workers.total} active`} tone="green" />
          <StatCard label="Expiring soon" value={s.workers.expiring} hint="workers" tone={s.workers.expiring ? 'amber' : 'slate'} />
          <StatCard label="Not compliant" value={s.workers.nonCompliant} hint="cannot be sent out" tone={s.workers.nonCompliant ? 'red' : 'slate'} to="/workers?compliance=NON_COMPLIANT" />
          <StatCard label="Docs expiring (30d)" value={s.documents.expiringIn30Days} tone={s.documents.expiringIn30Days ? 'amber' : 'slate'} />
          <StatCard label="Docs expired" value={s.documents.expired} tone={s.documents.expired ? 'red' : 'slate'} />
          <StatCard label="Awaiting verification" value={s.documents.awaitingVerification} tone={s.documents.awaitingVerification ? 'blue' : 'slate'} />
        </div>
      )}
      <Tabs tabs={[{ value: 'expiring', label: 'Expiring documents' }, { value: 'queue', label: 'Verification queue', count: s?.documents.awaitingVerification }, { value: 'requirements', label: 'Host requirements', count: s?.hostRequirements }]} value={tab} onChange={setTab} />
      {tab === 'expiring' && <ExpiringReport />}
      {tab === 'queue' && <VerificationQueue />}
      {tab === 'requirements' && <RequirementsPanel />}
      <WorkforceReportCard />
    </div>
  );
}

const DOC_TONES = { VALID: 'green', UNVERIFIED: 'amber', EXPIRED: 'red', MISSING: 'red' } as const;

/** Regulator-ready record of who worked at our sites, for whom, with which checks in place on the day (REP-01). */
function WorkforceReportCard() {
  const { organisation } = useAuth();
  const sites = useSites(organisation?.id);
  const [siteId, setSiteId] = useState('');
  const [range, setRange] = useState(() => {
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - 90);
    return { from: toDateInput(from), to: toDateInput(to) };
  });
  const [dlError, setDlError] = useState<unknown>(null);
  // Date-only inputs become an inclusive range of whole local days.
  const params = () => ({ siteId: siteId || undefined, from: new Date(`${range.from}T00:00:00`).toISOString(), to: new Date(`${range.to}T23:59:59.999`).toISOString() });
  const preview = useMutation({ mutationFn: () => api.get<WorkforceReport>('/reports/workforce', params()) });
  const download = () => {
    const p = params();
    const site = (sites.data ?? []).find((s) => s.id === siteId);
    const slug = site ? site.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'all-sites';
    downloadCsv(`/reports/workforce?format=csv&from=${encodeURIComponent(p.from)}&to=${encodeURIComponent(p.to)}${siteId ? `&siteId=${encodeURIComponent(siteId)}` : ''}`, `workforce-${slug}-${range.from}-${range.to}.csv`).catch(setDlError);
  };
  const r = preview.data;
  return (
    <Card
      title="Workforce report (for inspections)"
      description="Who worked at your sites, which organisation employs them, and whether every mandatory check was valid on the day of the shift. Status only: the documents and references stay with the employer."
      actions={<Button size="sm" variant="secondary" onClick={download}>⇩ Download CSV</Button>}
    >
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Site"><Select value={siteId} onChange={(e) => setSiteId(e.target.value)}><option value="">All sites</option>{(sites.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label="From"><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
        <Field label="To"><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
        <div className="flex items-end"><Button onClick={() => preview.mutate()} loading={preview.isPending}>Preview</Button></div>
      </div>
      <ErrorBanner error={preview.error ?? dlError} className="mt-3" />
      {r && (
        <div className="mt-3">
          <p className="mb-2 text-xs text-slate-500">
            {r.summary.shifts} shift(s) · {r.summary.workers} worker(s) · {r.summary.employers} employer(s) · {r.summary.nonCompliantOnDay} not compliant on the day
            {r.rows.length > 25 && ` · showing the first 25 of ${r.rows.length} rows; the CSV has them all`}
          </p>
          <Table
            rows={r.rows.slice(0, 25)}
            rowKey={(row) => `${row.shiftId}-${row.workerId}`}
            empty={<EmptyState title="No bookings in this period" description="Confirmed, completed and no-show bookings on your shifts appear here." />}
            columns={[
              { key: 'date', header: 'Date', render: (row) => <>{fmtDate(row.startsAt)}<div className="text-xs text-slate-500">{row.siteName}</div></> },
              { key: 'worker', header: 'Worker', render: (row) => <span className="font-medium text-slate-900">{row.workerName}</span> },
              { key: 'employer', header: 'Employer', render: (row) => row.employerName },
              { key: 'role', header: 'Role', render: (row) => JOB_ROLE_LABELS[row.jobRole] },
              { key: 'attendance', header: 'Attendance', render: (row) => <StatusBadge status={row.attendance} /> },
              { key: 'ok', header: 'Compliant on day', render: (row) => row.compliantOnDay ? <Badge tone="green">Yes</Badge> : <Badge tone="red">No</Badge> },
              { key: 'docs', header: 'Checks', render: (row) => <span className="flex flex-wrap gap-1">{(Object.entries(row.documents) as Array<[DocumentType, keyof typeof DOC_TONES]>).map(([type, status]) => <Badge key={type} tone={DOC_TONES[status]}>{DOCUMENT_LABELS[type]}: {status.toLowerCase()}</Badge>)}</span> },
            ]}
          />
        </div>
      )}
    </Card>
  );
}

function ExpiringReport() {
  const { organisation } = useAuth();
  const [days, setDays] = useState('60');
  const [type, setType] = useState('');
  const [siteId, setSiteId] = useState('');
  const sites = useSites(organisation?.id);
  const q = useQuery({ queryKey: ['compliance-expiring', days, type, siteId], queryFn: () => api.get<ExpiringDocument[]>('/compliance/expiring', { days, type: type || undefined, siteId: siteId || undefined }) });
  const rows = q.data ?? [];
  const exportCsv = () => {
    const lines = [['Worker', 'Role', 'Home site', 'Document', 'Reference', 'Expires', 'Days left', 'Status'].join(',')];
    for (const r of rows) lines.push([`${r.worker.firstName} ${r.worker.lastName}`, JOB_ROLE_LABELS[r.worker.jobRole], r.worker.homeSiteName ?? '', DOCUMENT_LABELS[r.document.type], r.document.reference ?? '', r.document.expiresAt ? fmtDate(r.document.expiresAt) : '', String(r.daysLeft), r.status].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `expiring-documents-${days}d.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Card title="Documents expiring" description="Includes documents that have already expired. Renew them before the worker's next shift." actions={<Button size="sm" variant="secondary" onClick={exportCsv} disabled={rows.length === 0}>⇩ Export CSV</Button>}>
      <div className="mb-3 grid gap-3 sm:grid-cols-3">
        <Field label="Within"><Select value={days} onChange={(e) => setDays(e.target.value)}>{['14', '30', '60', '90', '180'].map((d) => <option key={d} value={d}>{d} days</option>)}</Select></Field>
        <Field label="Document"><Select value={type} onChange={(e) => setType(e.target.value)}><option value="">All documents</option>{Object.values(DocumentType).map((d) => <option key={d} value={d}>{DOCUMENT_LABELS[d]}</option>)}</Select></Field>
        <Field label="Home site"><Select value={siteId} onChange={(e) => setSiteId(e.target.value)}><option value="">All sites</option>{(sites.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
      </div>
      <ErrorBanner error={q.error} className="mb-3" />
      {q.isLoading ? <Loading /> : (
        <Table
          rows={rows}
          rowKey={(r) => r.document.id}
          empty={<EmptyState title="Nothing expiring" description={`No documents expire within ${days} days.`} />}
          columns={[
            { key: 'worker', header: 'Worker', render: (r) => <Link to={`/workers/${r.worker.id}`} className="font-medium text-slate-900 hover:underline">{r.worker.firstName} {r.worker.lastName}<div className="text-xs font-normal text-slate-500">{JOB_ROLE_LABELS[r.worker.jobRole]}{r.worker.homeSiteName ? ` · ${r.worker.homeSiteName}` : ''}</div></Link> },
            { key: 'doc', header: 'Document', render: (r) => <>{DOCUMENT_LABELS[r.document.type]}{r.document.reference && <div className="text-xs text-slate-500">{r.document.reference}</div>}</> },
            { key: 'expires', header: 'Expires', render: (r) => fmtDate(r.document.expiresAt) },
            { key: 'left', header: 'Days left', align: 'right', render: (r) => <span className={r.daysLeft <= 0 ? 'font-semibold text-red-700' : r.daysLeft <= 14 ? 'font-semibold text-amber-700' : ''}>{r.daysLeft <= 0 ? `${-r.daysLeft}d ago` : r.daysLeft}</span> },
            { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          ]}
        />
      )}
    </Card>
  );
}

function VerificationQueue() {
  const q = useQuery({ queryKey: ['compliance-queue'], queryFn: () => api.get<QueuedDocument[]>('/compliance/verification-queue') });
  const [selected, setSelected] = useState<string[]>([]);
  const [openError, setOpenError] = useState<unknown>(null);
  const verify = useAction((ids: string[]) => api.post<{ verified: string[] }>('/compliance/verify', { documentIds: ids }), () => setSelected([]));
  const rows = q.data ?? [];
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const all = rows.length > 0 && selected.length === rows.length;
  return (
    <Card
      title="Awaiting verification"
      description="Check each document against the original (or the issuing body's register) before verifying. Documents uploaded by workers themselves are marked."
      actions={<Button size="sm" onClick={() => verify.mutate(selected)} disabled={selected.length === 0} loading={verify.isPending}>✓ Verify {selected.length || ''} selected</Button>}
    >
      <ErrorBanner error={q.error ?? verify.error ?? openError} className="mb-3" />
      {q.isLoading ? <Loading /> : (
        <Table
          rows={rows}
          rowKey={(r) => r.document.id}
          empty={<EmptyState title="Queue is empty" description="Every document on file has been verified." />}
          columns={[
            { key: 'sel', header: <Checkbox label="" checked={all} onChange={() => setSelected(all ? [] : rows.map((r) => r.document.id))} /> as unknown as string, render: (r) => <Checkbox label="" checked={selected.includes(r.document.id)} onChange={() => toggle(r.document.id)} /> },
            { key: 'worker', header: 'Worker', render: (r) => <Link to={`/workers/${r.worker.id}`} className="font-medium text-slate-900 hover:underline">{r.worker.firstName} {r.worker.lastName}<div className="text-xs font-normal text-slate-500">{JOB_ROLE_LABELS[r.worker.jobRole]}{r.worker.homeSiteName ? ` · ${r.worker.homeSiteName}` : ''}</div></Link> },
            { key: 'doc', header: 'Document', render: (r) => <>{DOCUMENT_LABELS[r.document.type]}{r.replacesDocumentId && <Badge className="ml-1">correction</Badge>}{r.document.reference && <div className="text-xs text-slate-500">{r.document.reference}</div>}</> },
            { key: 'expires', header: 'Expires', render: (r) => fmtDate(r.document.expiresAt) },
            { key: 'by', header: 'Added by', render: (r) => r.uploadedBy ? <span className="text-xs">{r.uploadedBy.name}{r.uploadedBy.role === 'WORKER' && <Badge tone="blue" className="ml-1">worker</Badge>}<div className="text-slate-500">{fmtDateTime(r.document.createdAt)}</div></span> : <span className="text-xs text-slate-500">{fmtDateTime(r.document.createdAt)}</span> },
            { key: 'file', header: 'File', render: (r) => r.document.hasFile ? <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => openProtectedFile(`/workers/${r.worker.id}/documents/${r.document.id}/file`).catch(setOpenError)}>{r.document.fileName ?? 'Open'} {fmtBytes(r.document.fileSize)}</button> : r.document.fileUrl ? <a href={r.document.fileUrl} target="_blank" rel="noreferrer" className="text-xs text-brand-700 hover:underline">Link ↗</a> : <span className="text-xs text-slate-400">No file</span> },
            { key: 'actions', header: '', align: 'right', render: (r) => <Button size="sm" variant="success" onClick={() => verify.mutate([r.document.id])} loading={verify.isPending}>Verify</Button> },
          ]}
        />
      )}
    </Card>
  );
}

function RequirementsPanel() {
  const { organisation, isPlatformAdmin } = useAuth();
  const [includeArchived, setIncludeArchived] = useState(false);
  const q = useQuery({ queryKey: ['requirements', 'own', includeArchived], queryFn: () => api.get<HostRequirement[]>('/compliance/requirements', { includeArchived: includeArchived ? 'true' : undefined }) });
  const [editing, setEditing] = useState<HostRequirement | 'new' | null>(null);
  const [viewing, setViewing] = useState<HostRequirement | null>(null);
  const [form, setForm] = useState({ name: '', description: '', recordedByHost: false });
  const open = (r: HostRequirement | 'new') => {
    setEditing(r);
    setForm(r === 'new' ? { name: '', description: '', recordedByHost: false } : { name: r.name, description: r.description ?? '', recordedByHost: r.recordedByHost });
  };
  const save = useAction(() => (editing === 'new' ? api.post('/compliance/requirements', { ...form, description: form.description || null }) : api.patch(`/compliance/requirements/${(editing as HostRequirement).id}`, { ...form, description: form.description || null })), () => setEditing(null));
  const archive = useAction((args: { id: string; archived: boolean }) => api.patch(`/compliance/requirements/${args.id}`, { archived: args.archived }));
  return (
    <div className="space-y-5">
      <Card
        title={`Requirements ${organisation?.name ?? 'you'} ask of visiting workers`}
        description="Beyond the standard checks every employer guarantees. Employer-declared requirements are confirmed by the worker's employer; host-recorded ones (such as a site induction) you record yourself after the worker has completed them. Name them on a shift and only workers holding them are eligible."
        actions={<><Checkbox label="Show archived" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} /><Button size="sm" onClick={() => open('new')}>＋ New requirement</Button></>}
      >
        <ErrorBanner error={q.error ?? archive.error} className="mb-3" />
        {q.isLoading ? <Loading /> : (
          <Table
            rows={q.data ?? []}
            rowKey={(r) => r.id}
            empty={<EmptyState title="No host requirements" description="Most hosts need none: the standard checks cover ordinary shifts. Add one when your service needs specialist training or an induction." />}
            columns={[
              { key: 'name', header: 'Requirement', render: (r) => <span className={r.archivedAt ? 'text-slate-400 line-through' : 'font-medium text-slate-900'}>{r.name}{r.description && <div className="text-xs font-normal text-slate-500">{r.description}</div>}</span> },
              { key: 'kind', header: 'Recorded by', render: (r) => r.recordedByHost ? <Badge tone="violet">You (host)</Badge> : <Badge tone="brand">Employer</Badge> },
              { key: 'holders', header: 'Workers holding it', align: 'right', render: (r) => <button type="button" className="text-brand-700 hover:underline" onClick={() => setViewing(r)}>{r.holders ?? 0}</button> },
              { key: 'actions', header: '', align: 'right', render: (r) => (
                <span className="flex justify-end gap-1">
                  {!r.archivedAt && <Button size="sm" variant="secondary" onClick={() => open(r)}>Edit</Button>}
                  <Button size="sm" variant="ghost" onClick={() => archive.mutate({ id: r.id, archived: !r.archivedAt })}>{r.archivedAt ? 'Restore' : 'Archive'}</Button>
                </span>
              ) },
            ]}
          />
        )}
        <Modal open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'New host requirement' : 'Edit requirement'} footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending}>Save</Button></>}>
          <div className="space-y-3">
            <ErrorBanner error={save.error} />
            <Field label="Name" required><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="PEG feeding training" /></Field>
            <Field label="Description" hint="What counts as holding it, and how long it is valid."><Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
            <Checkbox label="Recorded by us, not declared by the employer" hint="Tick for inductions and anything only you can confirm. Leave unticked for training certificates the employer holds." checked={form.recordedByHost} onChange={(e) => setForm({ ...form, recordedByHost: e.target.checked })} disabled={editing !== 'new'} />
          </div>
        </Modal>
        {viewing && <HoldersModal requirement={viewing} onClose={() => setViewing(null)} />}
      </Card>
      {!isPlatformAdmin && <InfoBanner tone="slate">To declare that one of your workers meets another host's requirement, open the worker's page and use "Declare" under host-specific requirements.</InfoBanner>}
    </div>
  );
}

function HoldersModal({ requirement, onClose }: { requirement: HostRequirement; onClose: () => void }) {
  const q = useQuery({ queryKey: ['requirement-holders', requirement.id], queryFn: () => api.get<RequirementHolder[]>(`/compliance/requirements/${requirement.id}/workers`) });
  const [workerId, setWorkerId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const record = useAction(() => api.post(`/compliance/requirements/${requirement.id}/workers`, { workerId: workerId.trim(), expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null }), () => { setWorkerId(''); setExpiresAt(''); });
  const remove = useAction((id: string) => api.delete(`/compliance/requirements/${requirement.id}/workers/${id}`));
  return (
    <Modal open onClose={onClose} title={`Workers holding "${requirement.name}"`} wide footer={<Button onClick={onClose}>Close</Button>}>
      <div className="space-y-3">
        <ErrorBanner error={q.error ?? record.error ?? remove.error} />
        {q.isLoading ? <Loading /> : (
          <Table
            rows={q.data ?? []}
            rowKey={(h) => h.workerId}
            empty={<EmptyState title="Nobody yet" />}
            columns={[
              { key: 'w', header: 'Worker', render: (h) => <span className="font-medium text-slate-900">{h.firstName} {h.lastName}<div className="text-xs font-normal text-slate-500">{JOB_ROLE_LABELS[h.jobRole]} · {h.orgName}</div></span> },
              { key: 'rec', header: 'Recorded', render: (h) => fmtDate(h.recordedAt) },
              { key: 'exp', header: 'Expires', render: (h) => h.expiresAt ? <span className={h.expired ? 'text-red-700' : ''}>{fmtDate(h.expiresAt)}</span> : '—' },
              { key: 'a', header: '', align: 'right', render: (h) => requirement.recordedByHost && <Button size="sm" variant="ghost" onClick={() => remove.mutate(h.workerId)}>Remove</Button> },
            ]}
          />
        )}
        {requirement.recordedByHost && !requirement.archivedAt && (
          <form className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3" onSubmit={(e) => { e.preventDefault(); record.mutate(); }}>
            <Field label="Worker id" hint="From the worker's page (shown in the address bar) or the shift's candidate list." className="flex-1"><Input value={workerId} onChange={(e) => setWorkerId(e.target.value)} placeholder="wrk_…" /></Field>
            <Field label="Valid until"><Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} /></Field>
            <Button type="submit" loading={record.isPending} disabled={!workerId.trim()}>Record</Button>
          </form>
        )}
      </div>
    </Modal>
  );
}

/** A worker's view of their own compliance: what is on file, what is missing, and uploading evidence. */
function MyDocumentsPage() {
  const { me } = useAuth();
  const q = useQuery({ queryKey: ['my-documents'], queryFn: () => api.get<MyDocuments>('/compliance/my-documents') });
  const workerId = me?.user.workerId;
  const [add, setAdd] = useState(false);
  const [form, setForm] = useState({ type: 'MANDATORY_TRAINING' as DocumentType, reference: '', issuedAt: '', expiresAt: '', notes: '' });
  const [file, setFile] = useState<File | null>(null);
  const [openError, setOpenError] = useState<unknown>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<string | null>(null);
  const create = useAction(async () => {
    const doc = await api.post<{ id: string }>(`/workers/${workerId}/documents`, { type: form.type, reference: form.reference || null, issuedAt: form.issuedAt ? new Date(form.issuedAt).toISOString() : null, expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null, notes: form.notes || null });
    if (file) await uploadFile(`/workers/${workerId}/documents/${doc.id}/file`, file);
    return doc;
  }, () => { setAdd(false); setFile(null); });
  const attach = useAction((args: { docId: string; file: File }) => uploadFile(`/workers/${workerId}/documents/${args.docId}/file`, args.file));
  if (q.isLoading || !q.data) return <Loading />;
  const d = q.data;
  const required = me?.worker ? new Set<DocumentType>(Object.values(DocumentType)) : new Set<DocumentType>();
  void required;
  return (
    <div className="space-y-5">
      <PageHeader title="My documents" description="The checks and training your employer keeps on file for you. Upload new certificates here; your manager verifies them." actions={<Button onClick={() => setAdd(true)}>＋ Add a document</Button>} />
      <ErrorBanner error={attach.error ?? openError} />
      <input ref={fileInput} type="file" accept="application/pdf,image/jpeg,image/png" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f && target) attach.mutate({ docId: target, file: f }); e.target.value = ''; }} />
      <Card>
        <Table
          rows={d.documents}
          rowKey={(x) => x.id}
          empty={<EmptyState title="Nothing on file yet" description="Add your DBS, right to work, ID and training certificates." />}
          columns={[
            { key: 'type', header: 'Document', render: (x) => <span className="font-medium text-slate-900">{DOCUMENT_LABELS[x.type]}{x.reference && <div className="text-xs font-normal text-slate-500">{x.reference}</div>}</span> },
            { key: 'expires', header: 'Expires', render: (x) => fmtDate(x.expiresAt) },
            { key: 'verified', header: 'Status', render: (x) => x.verifiedAt ? <Badge tone="green">Verified</Badge> : <Badge tone="amber">Awaiting verification</Badge> },
            { key: 'file', header: 'File', render: (x) => (
              <span className="flex items-center gap-2 text-xs">
                {x.hasFile ? <button type="button" className="text-brand-700 hover:underline" onClick={() => openProtectedFile(`/workers/${workerId}/documents/${x.id}/file`).catch(setOpenError)}>{x.fileName ?? 'Open'}</button> : <span className="text-slate-400">No file</span>}
                <button type="button" className="text-slate-500 hover:underline" onClick={() => { setTarget(x.id); fileInput.current?.click(); }}>{x.hasFile ? 'Replace' : 'Upload'}</button>
              </span>
            ) },
          ]}
        />
      </Card>
      {d.hostRequirements.length > 0 && (
        <Card title="Host-specific requirements you hold">
          <ul className="divide-y divide-slate-100 text-sm">{d.hostRequirements.map((r) => <li key={r.requirementId} className="flex justify-between py-2"><span>{r.name} <span className="text-xs text-slate-500">· {r.hostName}</span></span><span className="text-xs text-slate-500">{r.expiresAt ? `${r.expired ? 'expired' : 'until'} ${fmtDate(r.expiresAt)}` : 'no expiry'}</span></li>)}</ul>
        </Card>
      )}
      <Modal open={add} onClose={() => setAdd(false)} title="Add a document" footer={<><Button variant="secondary" onClick={() => setAdd(false)}>Cancel</Button><Button onClick={() => create.mutate()} loading={create.isPending}>Add</Button></>}>
        <div className="space-y-3">
          <ErrorBanner error={create.error} />
          <Field label="Type" required><Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as DocumentType })}>{Object.values(DocumentType).map((t) => <option key={t} value={t}>{DOCUMENT_LABELS[t]}</option>)}</Select></Field>
          <Field label="Reference / certificate number"><Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Issued"><Input type="date" value={form.issuedAt} onChange={(e) => setForm({ ...form, issuedAt: e.target.value })} /></Field>
            <Field label="Expires"><Input type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} /></Field>
          </div>
          <Field label="Photo or scan" hint="PDF, JPEG or PNG up to 10 MB."><Input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          <Field label="Notes"><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
          <InfoBanner tone="slate">Your manager checks the original before it counts towards your compliance.</InfoBanner>
        </div>
      </Modal>
    </div>
  );
}
