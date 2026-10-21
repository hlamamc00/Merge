import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ServiceType, UserRole } from '@merge/shared';
import { api } from '../api/client';
import { useAction, useSites } from '../api/hooks';
import type { Site, User } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { StatusBadge } from '../components/badges';
import { Badge, Button, Card, Checkbox, ErrorBanner, Field, Input, Loading, Modal, PageHeader, Select, Table, Textarea, Toggle } from '../components/ui';
import { fmtDateTime, humanise } from '../lib/format';

export function SettingsPage() {
  const { organisation, isAdmin } = useAuth();
  if (!organisation) return <Loading />;
  return (
    <div className="space-y-5">
      <PageHeader title="Settings" description={organisation.name} />
      <OrgProfile />
      <SitesCard />
      {isAdmin && <UsersCard />}
      <Card title="Worker self-service" description="Allow your workers (with a login) to see the shift board and request shifts for themselves. Managers still see every request.">
        <SelfServiceToggle />
      </Card>
    </div>
  );
}

function SelfServiceToggle() {
  const { organisation, refresh, isAdmin } = useAuth();
  const save = useAction((v: boolean) => api.patch(`/organisations/${organisation!.id}`, { workerSelfServiceAllowed: v }), () => void refresh());
  return (
    <>
      <ErrorBanner error={save.error} className="mb-2" />
      <Toggle checked={!!organisation?.workerSelfServiceAllowed} onChange={(v) => save.mutate(v)} disabled={!isAdmin} label={organisation?.workerSelfServiceAllowed ? 'Enabled – workers can request shifts themselves' : 'Disabled – managers put workers forward'} />
    </>
  );
}

function OrgProfile() {
  const { organisation, refresh, isAdmin } = useAuth();
  const o = organisation!;
  const [form, setForm] = useState({ name: o.name, email: o.email ?? '', phone: o.phone ?? '', addressLine1: o.addressLine1 ?? '', city: o.city ?? '', postcode: o.postcode ?? '', lat: o.lat?.toString() ?? '', lng: o.lng?.toString() ?? '', cqcRegistrationNumber: o.cqcRegistrationNumber ?? '', defaultChargeRate: o.defaultChargeRate?.toString() ?? '', serviceTypes: o.serviceTypes });
  const save = useAction(
    () => api.patch(`/organisations/${o.id}`, { ...form, email: form.email || null, phone: form.phone || null, addressLine1: form.addressLine1 || null, city: form.city || null, postcode: form.postcode || null, lat: form.lat ? Number(form.lat) : null, lng: form.lng ? Number(form.lng) : null, cqcRegistrationNumber: form.cqcRegistrationNumber || null, defaultChargeRate: form.defaultChargeRate ? Number(form.defaultChargeRate) : null }),
    () => void refresh(),
  );
  return (
    <Card title="Organisation profile" description="Location is used for distance-based matching of flags and workers." actions={isAdmin && <Button size="sm" onClick={() => save.mutate()} loading={save.isPending}>Save</Button>}>
      <ErrorBanner error={save.error} className="mb-3" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={!isAdmin} /></Field>
        <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} disabled={!isAdmin} /></Field>
        <Field label="Phone"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} disabled={!isAdmin} /></Field>
        <Field label="Address"><Input value={form.addressLine1} onChange={(e) => setForm({ ...form, addressLine1: e.target.value })} disabled={!isAdmin} /></Field>
        <Field label="Town / city"><Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} disabled={!isAdmin} /></Field>
        <Field label="Postcode"><Input value={form.postcode} onChange={(e) => setForm({ ...form, postcode: e.target.value })} disabled={!isAdmin} /></Field>
        <Field label="Latitude"><Input type="number" step="any" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} disabled={!isAdmin} /></Field>
        <Field label="Longitude"><Input type="number" step="any" value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} disabled={!isAdmin} /></Field>
        <Field label="CQC registration"><Input value={form.cqcRegistrationNumber} onChange={(e) => setForm({ ...form, cqcRegistrationNumber: e.target.value })} disabled={!isAdmin} /></Field>
        <Field label="Default charge rate (£/h)"><Input type="number" step="0.25" value={form.defaultChargeRate} onChange={(e) => setForm({ ...form, defaultChargeRate: e.target.value })} disabled={!isAdmin} /></Field>
      </div>
      <Field label="Services" className="mt-3">
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
          {Object.values(ServiceType).map((s) => <Checkbox key={s} label={humanise(s)} checked={form.serviceTypes.includes(s)} disabled={!isAdmin} onChange={(e) => setForm({ ...form, serviceTypes: e.target.checked ? [...form.serviceTypes, s] : form.serviceTypes.filter((x) => x !== s) })} />)}
        </div>
      </Field>
    </Card>
  );
}

const emptySite = { name: '', serviceType: '', addressLine1: '', city: '', postcode: '', lat: '', lng: '', accessNotes: '' };

function SitesCard() {
  const { organisation } = useAuth();
  const sites = useSites(organisation?.id);
  const [editing, setEditing] = useState<Site | 'new' | null>(null);
  const [form, setForm] = useState(emptySite);
  const open = (s: Site | 'new') => {
    setEditing(s);
    setForm(s === 'new' ? emptySite : { name: s.name, serviceType: s.serviceType ?? '', addressLine1: s.addressLine1 ?? '', city: s.city ?? '', postcode: s.postcode, lat: s.lat?.toString() ?? '', lng: s.lng?.toString() ?? '', accessNotes: s.accessNotes ?? '' });
  };
  const payload = () => ({ name: form.name, serviceType: form.serviceType || null, addressLine1: form.addressLine1 || null, city: form.city || null, postcode: form.postcode, lat: form.lat ? Number(form.lat) : null, lng: form.lng ? Number(form.lng) : null, accessNotes: form.accessNotes || null });
  const save = useAction(() => (editing === 'new' ? api.post(`/organisations/${organisation!.id}/sites`, payload()) : api.patch(`/organisations/${organisation!.id}/sites/${(editing as Site).id}`, payload())), () => setEditing(null));
  const remove = useAction((id: string) => api.delete(`/organisations/${organisation!.id}/sites/${id}`));
  return (
    <Card title="Sites" description="Where your shifts take place. Access notes are shared with confirmed workers." actions={<Button size="sm" onClick={() => open('new')}>＋ Add site</Button>}>
      <ErrorBanner error={remove.error} className="mb-3" />
      {sites.isLoading ? <Loading /> : (
        <Table
          rows={sites.data ?? []}
          rowKey={(s) => s.id}
          columns={[
            { key: 'name', header: 'Site', render: (s) => <span className="font-medium text-slate-900">{s.name}</span> },
            { key: 'type', header: 'Service', render: (s) => (s.serviceType ? humanise(s.serviceType) : '—') },
            { key: 'addr', header: 'Address', render: (s) => [s.addressLine1, s.city, s.postcode].filter(Boolean).join(', ') },
            { key: 'geo', header: 'Located', render: (s) => (s.lat != null ? <Badge tone="green">Yes</Badge> : <Badge tone="amber">No coordinates</Badge>) },
            { key: 'actions', header: '', align: 'right', render: (s) => <span className="flex justify-end gap-1"><Button size="sm" variant="secondary" onClick={() => open(s)}>Edit</Button><Button size="sm" variant="ghost" onClick={() => remove.mutate(s.id)}>Delete</Button></span> },
          ]}
        />
      )}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add site' : 'Edit site'} footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending}>Save</Button></>}>
        <div className="space-y-3">
          <ErrorBanner error={save.error} />
          <Field label="Name" required><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Service type"><Select value={form.serviceType} onChange={(e) => setForm({ ...form, serviceType: e.target.value })}><option value="">—</option>{Object.values(ServiceType).map((s) => <option key={s} value={s}>{humanise(s)}</option>)}</Select></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Address"><Input value={form.addressLine1} onChange={(e) => setForm({ ...form, addressLine1: e.target.value })} /></Field>
            <Field label="Town / city"><Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></Field>
            <Field label="Postcode" required><Input value={form.postcode} onChange={(e) => setForm({ ...form, postcode: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Lat"><Input type="number" step="any" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} /></Field>
              <Field label="Lng"><Input type="number" step="any" value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} /></Field>
            </div>
          </div>
          <Field label="Access notes" hint="Parking, entrances, who to report to."><Textarea value={form.accessNotes} onChange={(e) => setForm({ ...form, accessNotes: e.target.value })} /></Field>
        </div>
      </Modal>
    </Card>
  );
}

function UsersCard() {
  const { organisation, isPlatformAdmin, user: me } = useAuth();
  const users = useQuery({ queryKey: ['users', organisation?.id], queryFn: () => api.get<User[]>(`/organisations/${organisation!.id}/users`), enabled: !!organisation });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', password: '', role: 'ORG_MANAGER' as UserRole });
  const create = useAction(() => api.post(`/organisations/${organisation!.id}/users`, form), () => { setOpen(false); setForm({ firstName: '', lastName: '', email: '', password: '', role: 'ORG_MANAGER' }); });
  const update = useAction((args: { id: string; body: Record<string, unknown> }) => api.patch(`/organisations/${organisation!.id}/users/${args.id}`, args.body));
  return (
    <Card title="Users" description="Admins manage billing, users and settings; managers run the rota; workers see their own shifts." actions={<Button size="sm" onClick={() => setOpen(true)}>＋ Add user</Button>}>
      <ErrorBanner error={update.error} className="mb-3" />
      {users.isLoading ? <Loading /> : (
        <Table
          rows={users.data ?? []}
          rowKey={(u) => u.id}
          columns={[
            { key: 'name', header: 'Name', render: (u) => <span className="font-medium text-slate-900">{u.firstName} {u.lastName}{u.id === me?.id && <span className="ml-1 text-xs text-slate-400">(you)</span>}</span> },
            { key: 'email', header: 'Email', render: (u) => u.email },
            { key: 'role', header: 'Role', render: (u) => <Badge tone={u.role === 'PLATFORM_ADMIN' ? 'violet' : u.role === 'WORKER' ? 'blue' : 'brand'}>{humanise(u.role)}</Badge> },
            { key: 'status', header: 'Status', render: (u) => <StatusBadge status={u.status} /> },
            { key: 'last', header: 'Last login', render: (u) => fmtDateTime(u.lastLoginAt) },
            { key: 'actions', header: '', align: 'right', render: (u) => u.id !== me?.id && u.role !== 'PLATFORM_ADMIN' && (
              <span className="flex justify-end gap-1">
                {u.role !== 'WORKER' && <Select value={u.role} onChange={(e) => update.mutate({ id: u.id, body: { role: e.target.value } })} className="w-auto py-1 text-xs"><option value="ORG_ADMIN">Org admin</option><option value="ORG_MANAGER">Org manager</option></Select>}
                <Button size="sm" variant="ghost" onClick={() => update.mutate({ id: u.id, body: { status: u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' } })}>{u.status === 'ACTIVE' ? 'Disable' : 'Enable'}</Button>
              </span>
            ) },
          ]}
        />
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Add user" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => create.mutate()} loading={create.isPending}>Add user</Button></>}>
        <div className="space-y-3">
          <ErrorBanner error={create.error} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name" required><Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></Field>
            <Field label="Last name" required><Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></Field>
          </div>
          <Field label="Email" required><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Temporary password" required hint="At least 8 characters."><Input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <Field label="Role">
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })}>
              <option value="ORG_ADMIN">Org admin</option>
              <option value="ORG_MANAGER">Org manager</option>
              {isPlatformAdmin && <option value="PLATFORM_ADMIN">Platform admin</option>}
            </Select>
          </Field>
        </div>
      </Modal>
    </Card>
  );
}
