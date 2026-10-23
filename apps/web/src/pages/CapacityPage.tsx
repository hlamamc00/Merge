import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { CapacityFlagKind, JOB_ROLE_LABELS, JobRole } from '@merge/shared';
import { api } from '../api/client';
import { useAction, useFlags, useNetworkCapacity, useSites } from '../api/hooks';
import type { CapacityFlag, WorkerListItem } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { StatusBadge } from '../components/badges';
import { Button, Card, Checkbox, EmptyState, ErrorBanner, Field, InfoBanner, Input, Loading, Modal, PageHeader, Progress, Select, Tabs, Textarea, cx } from '../components/ui';
import { fmtDate, fmtDateTime, toLocalInput, fromLocalInput } from '../lib/format';
import { NetworkTable } from './DashboardPage';

export function CapacityPage() {
  const { isPlatformAdmin, organisation } = useAuth();
  const [tab, setTab] = useState<'ACTIVE' | 'ALL'>('ACTIVE');
  const [open, setOpen] = useState(false);
  const flags = useFlags(tab === 'ACTIVE' ? { status: 'ACTIVE' } : {});
  const network = useNetworkCapacity();
  const withdraw = useAction((id: string) => api.post(`/capacity/flags/${id}/withdraw`));
  return (
    <div className="space-y-5">
      <PageHeader
        title="Capacity flags"
        description="Flag when you have staff short of hours (surplus) or are short-staffed (shortage). Surplus flags give you first access to matching shifts."
        actions={<Button onClick={() => setOpen(true)}>⚑ Raise a flag</Button>}
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title={isPlatformAdmin ? 'All flags' : 'Your flags'} className="lg:col-span-2" actions={<Tabs tabs={[{ value: 'ACTIVE', label: 'Active' }, { value: 'ALL', label: 'All' }]} value={tab} onChange={setTab} />}>
          <ErrorBanner error={withdraw.error} className="mb-3" />
          {flags.isLoading ? <Loading /> : (flags.data ?? []).length === 0 ? (
            <EmptyState title="No flags" description="Raise a SURPLUS flag and your organisation goes to the front of the queue for matching shifts." action={<Button size="sm" onClick={() => setOpen(true)}>Raise a flag</Button>} />
          ) : (
            <ul className="space-y-3">
              {(flags.data ?? []).map((f) => (
                <FlagRow key={f.id} flag={f} showOrg={isPlatformAdmin && f.orgId !== organisation?.id} onWithdraw={() => withdraw.mutate(f.id)} withdrawing={withdraw.isPending} />
              ))}
            </ul>
          )}
        </Card>
        <Card title="Network supply & demand" description={isPlatformAdmin ? 'Every active flag on the network.' : 'Aggregated across the network; organisation names are only visible to the platform agency.'}>
          <NetworkTable data={network.data} loading={network.isLoading} showOrgs={isPlatformAdmin} />
        </Card>
      </div>
      <RaiseFlagModal open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function FlagRow({ flag, showOrg, onWithdraw, withdrawing }: { flag: CapacityFlag; showOrg: boolean; onWithdraw: () => void; withdrawing: boolean }) {
  const active = flag.status === 'ACTIVE';
  return (
    <li className={cx('rounded-lg border p-3', active ? 'border-slate-200' : 'border-slate-100 opacity-70')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={flag.kind} />
            <StatusBadge status={flag.status} />
            {showOrg && <span className="text-sm font-medium text-slate-800">{flag.orgName}</span>}
          </div>
          <div className="mt-1 text-sm font-medium text-slate-900">
            {flag.jobRole ? JOB_ROLE_LABELS[flag.jobRole] : 'Any role'} · {flag.headcount} staff · {flag.hoursRequested}h
          </div>
          <div className="text-xs text-slate-500">
            {fmtDate(flag.startsAt)} – {fmtDate(flag.endsAt)}
            {flag.postcodeAreas?.length ? ` · areas ${flag.postcodeAreas.join(', ')}` : ''}
            {flag.radiusKm ? ` · within ${flag.radiusKm} km` : ''}
            {flag.releasedWorkers ? ` · ${flag.releasedWorkers} staff named as free` : ''}
            {' · raised '}
            {fmtDateTime(flag.createdAt)}
          </div>
          {flag.note && <div className="mt-1 text-xs text-slate-600">“{flag.note}”</div>}
        </div>
        {active && <Button size="sm" variant="secondary" onClick={onWithdraw} loading={withdrawing}>Withdraw</Button>}
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
        <Progress value={flag.hoursFilled} max={flag.hoursRequested} tone={flag.kind === 'SURPLUS' ? 'brand' : 'amber'} />
        <span className="whitespace-nowrap">{flag.hoursFilled}h matched · {flag.hoursRemaining}h left</span>
      </div>
    </li>
  );
}

function RaiseFlagModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { organisation } = useAuth();
  const sites = useSites(organisation?.id);
  const start = new Date();
  const end = new Date();
  end.setDate(end.getDate() + 14);
  const [form, setForm] = useState({ kind: 'SURPLUS' as CapacityFlagKind, jobRole: '', headcount: '1', hoursRequested: '40', startsAt: toLocalInput(start), endsAt: toLocalInput(end), siteId: '', postcodeAreas: '', radiusKm: '', note: '' });
  const [workerIds, setWorkerIds] = useState<string[]>([]);
  // Decision 8: a surplus flag can name the staff who are free, lifting their contracted hours from the 48h check.
  // Scoped to the raising organisation: a platform admin's unscoped list would span every organisation.
  const staff = useQuery({ queryKey: ['workers', { status: 'ACTIVE', orgId: organisation?.id }], queryFn: () => api.get<WorkerListItem[]>('/workers', { status: 'ACTIVE', orgId: organisation?.id }), enabled: open && form.kind === 'SURPLUS' });
  const lendable = (staff.data ?? []).filter((w) => w.shareable && (!form.jobRole || w.jobRole === form.jobRole));
  const toggleWorker = (id: string) => setWorkerIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const create = useAction(
    () =>
      api.post('/capacity/flags', {
        kind: form.kind,
        ...(form.kind === 'SURPLUS' ? { workerIds: workerIds.filter((id) => lendable.some((w) => w.id === id)) } : {}),
        jobRole: form.jobRole || null,
        headcount: Number(form.headcount),
        hoursRequested: Number(form.hoursRequested),
        startsAt: fromLocalInput(form.startsAt),
        endsAt: fromLocalInput(form.endsAt),
        siteId: form.siteId || null,
        postcodeAreas: form.postcodeAreas ? form.postcodeAreas.split(',').map((s) => s.trim()).filter(Boolean) : null,
        radiusKm: form.radiusKm ? Number(form.radiusKm) : null,
        note: form.note || null,
      }),
    () => {
      setWorkerIds([]);
      onClose();
    },
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Modal open={open} onClose={onClose} title="Raise a capacity flag" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button form="flag-form" type="submit" loading={create.isPending}>Raise flag</Button></>}>
      <form id="flag-form" onSubmit={submit} className="space-y-3">
        <ErrorBanner error={create.error} />
        <div className="grid grid-cols-2 gap-2">
          {(['SURPLUS', 'SHORTAGE'] as const).map((k) => (
            <button key={k} type="button" onClick={() => setForm({ ...form, kind: k })} className={cx('rounded-lg border p-3 text-left text-sm', form.kind === k ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-100' : 'border-slate-200 hover:bg-slate-50')}>
              <div className="font-semibold">{k === 'SURPLUS' ? 'Surplus staff' : 'Short-staffed'}</div>
              <div className="text-xs text-slate-600">{k === 'SURPLUS' ? 'We have staff who need hours — get first access to matching shifts.' : "We're short-staffed — we'll be posting shifts."}</div>
            </button>
          ))}
        </div>
        {form.kind === 'SURPLUS' && <InfoBanner tone="brand">While this flag is active and has hours left, your organisation is notified of matching shifts before the rest of the network. Hours are used up as your workers are confirmed.</InfoBanner>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Role" hint="Leave blank for any role.">
            <Select value={form.jobRole} onChange={(e) => setForm({ ...form, jobRole: e.target.value })}>
              <option value="">Any role</option>
              {Object.values(JobRole).map((r) => (
                <option key={r} value={r}>{JOB_ROLE_LABELS[r]}</option>
              ))}
            </Select>
          </Field>
          <Field label="Staff involved"><Input type="number" min="1" value={form.headcount} onChange={(e) => setForm({ ...form, headcount: e.target.value })} /></Field>
          <Field label={form.kind === 'SURPLUS' ? 'Hours to place' : 'Hours needed'} required><Input type="number" min="1" step="0.5" value={form.hoursRequested} onChange={(e) => setForm({ ...form, hoursRequested: e.target.value })} required /></Field>
          <Field label="Site (optional)">
            <Select value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}>
              <option value="">—</option>
              {(sites.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="From" required><Input type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} required /></Field>
          <Field label="Until" required><Input type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} required /></Field>
          <Field label="Postcode areas" hint="Comma-separated, e.g. M, SK. Blank = anywhere."><Input value={form.postcodeAreas} onChange={(e) => setForm({ ...form, postcodeAreas: e.target.value })} placeholder="M, SK" /></Field>
          <Field label="Max distance (km)" hint="From your organisation's location."><Input type="number" min="1" value={form.radiusKm} onChange={(e) => setForm({ ...form, radiusKm: e.target.value })} /></Field>
        </div>
        <Field label="Note"><Textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="e.g. Occupancy down after two discharges" /></Field>
        {form.kind === 'SURPLUS' && (
          <Field
            label={<span className="flex items-center justify-between gap-2">Who is free for this period?{lendable.length > 0 && <button type="button" className="text-xs font-normal text-brand-700 hover:underline" onClick={() => setWorkerIds(lendable.map((w) => w.id))}>Select all shown</button>}</span>}
            hint="Ticked staff are treated as having no rostered hours with you while the flag runs, so their contracted hours no longer count against the 48-hour limit when another organisation books them."
          >
            {staff.isLoading ? <Loading label="Loading staff…" /> : lendable.length === 0 ? (
              <p className="text-sm text-slate-500">No active, shareable {form.jobRole ? JOB_ROLE_LABELS[form.jobRole as JobRole].toLowerCase() : 'staff'} to choose from.</p>
            ) : (
              <div className="grid max-h-48 gap-1 overflow-y-auto rounded-lg border border-slate-200 p-2 sm:grid-cols-2">
                {lendable.map((w) => (
                  <Checkbox key={w.id} label={`${w.firstName} ${w.lastName}`} hint={`${JOB_ROLE_LABELS[w.jobRole]}${w.contractedHoursPerWeek != null ? ` · ${w.contractedHoursPerWeek}h contracted` : ''}`} checked={workerIds.includes(w.id)} onChange={() => toggleWorker(w.id)} />
                ))}
              </div>
            )}
          </Field>
        )}
      </form>
    </Modal>
  );
}
