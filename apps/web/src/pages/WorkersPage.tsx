import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { JOB_ROLE_LABELS, JobRole, SKILL_LABELS, Skill, WorkerStatus } from '@merge/shared';
import { api } from '../api/client';
import { useAction, useWorkers } from '../api/hooks';
import { useAuth } from '../auth/AuthContext';
import { ComplianceBadge, StatusBadge, skillLabel } from '../components/badges';
import { Button, Card, Checkbox, Chips, ErrorBanner, Field, Input, Loading, Modal, PageHeader, Select, Table, Toggle } from '../components/ui';

export function WorkersPage() {
  const { isPlatformAdmin, organisation } = useAuth();
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const q = useWorkers({ jobRole: role || undefined, status: status || undefined });
  const toggleShare = useAction((w: { id: string; shareable: boolean }) => api.patch(`/workers/${w.id}`, { shareable: !w.shareable }));
  return (
    <div className="space-y-5">
      <PageHeader title="Workers" description={isPlatformAdmin ? 'Every worker on the platform. Shareable workers can be lent to other organisations.' : 'Your staff. Mark a worker as shareable to make them available to other organisations.'} actions={<Button onClick={() => setOpen(true)}>＋ Add worker</Button>} />
      <Card>
        <div className="mb-3 grid gap-3 sm:grid-cols-3">
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">All roles</option>
              {Object.values(JobRole).map((r) => <option key={r} value={r}>{JOB_ROLE_LABELS[r]}</option>)}
            </Select>
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {Object.values(WorkerStatus).map((s) => <option key={s} value={s}>{s.replace('_', ' ').toLowerCase()}</option>)}
            </Select>
          </Field>
        </div>
        <ErrorBanner error={q.error ?? toggleShare.error} className="mb-3" />
        {q.isLoading ? <Loading /> : (
          <Table
            rows={q.data ?? []}
            rowKey={(w) => w.id}
            onRowClick={(w) => navigate(`/workers/${w.id}`)}
            columns={[
              { key: 'name', header: 'Name', render: (w) => <div className="font-medium text-slate-900">{w.firstName} {w.lastName}{isPlatformAdmin && w.orgId !== organisation?.id && <div className="text-xs font-normal text-slate-500">{w.orgId}</div>}</div> },
              { key: 'role', header: 'Role', render: (w) => JOB_ROLE_LABELS[w.jobRole] },
              { key: 'skills', header: 'Skills', render: (w) => <Chips items={w.skills.map(skillLabel)} /> },
              { key: 'status', header: 'Status', render: (w) => <StatusBadge status={w.status} /> },
              { key: 'compliance', header: 'Compliance', render: (w) => <ComplianceBadge status={w.compliance.status} /> },
              { key: 'share', header: 'Shareable', render: (w) => <span onClick={(e) => e.stopPropagation()}><Toggle checked={w.shareable} onChange={() => toggleShare.mutate(w)} /></span> },
            ]}
          />
        )}
      </Card>
      <AddWorkerModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function AddWorkerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', phone: '', jobRole: 'CARE_ASSISTANT' as JobRole, skills: ['MOVING_AND_HANDLING'] as Skill[], shareable: true, postcode: '', travelRadiusKm: '20', contractedHoursPerWeek: '', maxHoursPerWeek: '48', hourlyPayRate: '' });
  const create = useAction(
    () =>
      api.post<{ id: string }>('/workers', {
        ...form,
        email: form.email || null,
        phone: form.phone || null,
        postcode: form.postcode || null,
        travelRadiusKm: form.travelRadiusKm ? Number(form.travelRadiusKm) : null,
        contractedHoursPerWeek: form.contractedHoursPerWeek ? Number(form.contractedHoursPerWeek) : null,
        maxHoursPerWeek: form.maxHoursPerWeek ? Number(form.maxHoursPerWeek) : null,
        hourlyPayRate: form.hourlyPayRate ? Number(form.hourlyPayRate) : null,
      }),
    (w) => { onClose(); navigate(`/workers/${w.id}`); },
  );
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };
  const toggle = (s: Skill) => setForm({ ...form, skills: form.skills.includes(s) ? form.skills.filter((x) => x !== s) : [...form.skills, s] });
  return (
    <Modal open={open} onClose={onClose} title="Add a worker" wide footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button form="worker-form" type="submit" loading={create.isPending}>Add worker</Button></>}>
      <form id="worker-form" onSubmit={submit} className="space-y-3">
        <ErrorBanner error={create.error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First name" required><Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} required /></Field>
          <Field label="Last name" required><Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} required /></Field>
          <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Phone"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Role" required>
            <Select value={form.jobRole} onChange={(e) => setForm({ ...form, jobRole: e.target.value as JobRole })}>
              {Object.values(JobRole).map((r) => <option key={r} value={r}>{JOB_ROLE_LABELS[r]}</option>)}
            </Select>
          </Field>
          <Field label="Home postcode"><Input value={form.postcode} onChange={(e) => setForm({ ...form, postcode: e.target.value })} /></Field>
          <Field label="Travel radius (km)"><Input type="number" min="0" value={form.travelRadiusKm} onChange={(e) => setForm({ ...form, travelRadiusKm: e.target.value })} /></Field>
          <Field label="Contracted hours / week"><Input type="number" min="0" value={form.contractedHoursPerWeek} onChange={(e) => setForm({ ...form, contractedHoursPerWeek: e.target.value })} /></Field>
          <Field label="Max hours / week"><Input type="number" min="1" max="80" value={form.maxHoursPerWeek} onChange={(e) => setForm({ ...form, maxHoursPerWeek: e.target.value })} /></Field>
          <Field label="Hourly pay (private)" hint="Never shown to other organisations."><Input type="number" step="0.25" min="0" value={form.hourlyPayRate} onChange={(e) => setForm({ ...form, hourlyPayRate: e.target.value })} /></Field>
        </div>
        <Field label="Skills">
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
            {Object.values(Skill).map((s) => <Checkbox key={s} label={SKILL_LABELS[s]} checked={form.skills.includes(s)} onChange={() => toggle(s)} />)}
          </div>
        </Field>
        <Checkbox label="Shareable" hint="Can be lent to other organisations on the network." checked={form.shareable} onChange={(e) => setForm({ ...form, shareable: e.target.checked })} />
      </form>
    </Modal>
  );
}
