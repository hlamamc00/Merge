import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ServiceType, UserRole } from '@merge/shared';
import { api } from '../api/client';
import { useAction, useSites } from '../api/hooks';
import type { Site } from '../api/types';
import type { ApprovalStatus, MouDocument, OrganisationWithCompliance, UserWithSecurity } from '../api/types.compliance';
import { useAuth } from '../auth/AuthContext';
import { StatusBadge } from '../components/badges';
import { Badge, Button, Card, Checkbox, ErrorBanner, Field, InfoBanner, Input, LinkButton, Loading, Modal, PageHeader, Select, Table, Textarea, Toggle } from '../components/ui';
import { fmtDate, fmtDateTime, humanise } from '../lib/format';
import { MouText } from './RegisterPage';

export function SettingsPage() {
  const { organisation, isAdmin } = useAuth();
  if (!organisation) return <Loading />;
  return (
    <div className="space-y-5">
      <PageHeader title="Settings" description={organisation.name} />
      <ApprovalCard />
      <OrgProfile />
      <SitesCard />
      {isAdmin && <UsersCard />}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Unfilled shifts" description="Decision 6: what happens when a shift is still open close to its start.">
          <EscalationForm />
        </Card>
        <Card title="Worker self-service" description="Allow your workers (with a login) to see the shift board and request shifts for themselves. Managers still see every request.">
          <SelfServiceToggle />
        </Card>
      </div>
      <SecurityCard />
    </div>
  );
}

/** Where a pending organisation stands, and the MOU for everyone. */
function ApprovalCard() {
  const { organisation, isAdmin, refresh } = useAuth();
  const org = organisation as OrganisationWithCompliance;
  const status = useQuery({ queryKey: ['approval', org.id], queryFn: () => api.get<ApprovalStatus>(`/organisations/${org.id}/approval`), enabled: isAdmin });
  const mou = useQuery({ queryKey: ['mou'], queryFn: () => api.get<MouDocument>('/organisations/mou'), staleTime: Infinity });
  const [show, setShow] = useState(false);
  const accept = useAction(() => api.post(`/organisations/${org.id}/mou/accept`), () => void refresh());
  const pending = org.status === 'PENDING';
  const outdated = !!org.mouAcceptedAt && !!mou.data && org.mouVersion !== mou.data.version;
  if (!pending && !outdated && !show && org.mouAcceptedAt) {
    return (
      <p className="text-xs text-slate-500">
        Memorandum of understanding version {org.mouVersion} accepted on {fmtDate(org.mouAcceptedAt)}. <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => setShow(true)}>Read it</button>
      </p>
    );
  }
  return (
    <Card title={pending ? 'Awaiting approval' : 'Memorandum of understanding'} description={pending ? 'The platform team activates your organisation once it has checked your registration. Until then you can set up sites, users and workers, but not post or take shifts.' : undefined}>
      <ErrorBanner error={accept.error} className="mb-3" />
      {pending && status.data && status.data.blockers.length > 0 && (
        <InfoBanner tone="amber" className="mb-3">
          <div className="font-medium">Still needed before approval</div>
          <ul className="mt-1 list-disc pl-5 text-sm">{status.data.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          <div className="mt-1 text-xs">Add your CQC number in the profile below and accept the memorandum here.</div>
        </InfoBanner>
      )}
      {pending && status.data && status.data.blockers.length === 0 && <InfoBanner tone="green" className="mb-3">Everything is in place; the platform team will activate you shortly.</InfoBanner>}
      {outdated && <InfoBanner tone="amber" className="mb-3">The memorandum has been updated to version {mou.data?.version}; you accepted version {org.mouVersion}. Please read and accept the new version.</InfoBanner>}
      {mou.data && (show || pending || outdated) && <MouText mou={mou.data} />}
      {isAdmin && (!org.mouAcceptedAt || outdated) && (
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button onClick={() => accept.mutate()} loading={accept.isPending}>Accept the memorandum on behalf of {org.name}</Button>
        </div>
      )}
      {show && !pending && !outdated && <div className="mt-2 text-right"><Button size="sm" variant="ghost" onClick={() => setShow(false)}>Close</Button></div>}
    </Card>
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

function EscalationForm() {
  const { organisation, refresh, isAdmin } = useAuth();
  const org = organisation as OrganisationWithCompliance;
  const [mode, setMode] = useState<'MANUAL' | 'AUTO'>(org.escalationMode ?? 'MANUAL');
  const [ceiling, setCeiling] = useState(String(org.escalationCeilingPct ?? 20));
  const save = useAction(() => api.patch(`/organisations/${org.id}`, { escalationMode: mode, escalationCeilingPct: Number(ceiling) }), () => void refresh());
  return (
    <div className="space-y-3">
      <ErrorBanner error={save.error} />
      <Field label="When a shift is still unfilled" hint={mode === 'AUTO' ? 'The platform raises the charge rate in steps as the start approaches, up to your ceiling, and widens who can see it.' : 'You are reminded and decide yourself whether to raise the rate or widen the audience.'}>
        <Select value={mode} onChange={(e) => setMode(e.target.value as 'MANUAL' | 'AUTO')} disabled={!isAdmin}>
          <option value="MANUAL">Remind me and let me decide (manual)</option>
          <option value="AUTO">Raise the rate automatically (auto)</option>
        </Select>
      </Field>
      <Field label="Maximum automatic uplift (% of the original rate)" hint="Only used in automatic mode.">
        <Input type="number" min="0" max="100" step="5" value={ceiling} onChange={(e) => setCeiling(e.target.value)} disabled={!isAdmin || mode !== 'AUTO'} />
      </Field>
      {isAdmin && <div className="text-right"><Button size="sm" onClick={() => save.mutate()} loading={save.isPending}>Save</Button></div>}
    </div>
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
        <Field label="CQC registration number" hint="Required for approval."><Input value={form.cqcRegistrationNumber} onChange={(e) => setForm({ ...form, cqcRegistrationNumber: e.target.value })} disabled={!isAdmin} /></Field>
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
  const { organisation, user } = useAuth();
  const sites = useSites(organisation?.id);
  const siteScoped = !!(user as UserWithSecurity | null)?.siteIds?.length;
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
    <Card title="Sites" description={siteScoped ? 'You are assigned to the sites below. Ask an administrator to add or remove sites.' : 'Where your shifts take place. Access notes are shared with confirmed workers. Managers can be limited to particular sites under Users.'} actions={!siteScoped && <Button size="sm" onClick={() => open('new')}>＋ Add site</Button>}>
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
            { key: 'actions', header: '', align: 'right', render: (s) => <span className="flex justify-end gap-1"><Button size="sm" variant="secondary" onClick={() => open(s)}>Edit</Button>{!siteScoped && <Button size="sm" variant="ghost" onClick={() => remove.mutate(s.id)}>Delete</Button>}</span> },
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
  const users = useQuery({ queryKey: ['users', organisation?.id], queryFn: () => api.get<UserWithSecurity[]>(`/organisations/${organisation!.id}/users`), enabled: !!organisation });
  const sites = useSites(organisation?.id);
  const siteName = (id: string) => sites.data?.find((s) => s.id === id)?.name ?? id;
  const [open, setOpen] = useState(false);
  const [sitesFor, setSitesFor] = useState<UserWithSecurity | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const blank = { firstName: '', lastName: '', email: '', password: '', role: 'ORG_MANAGER' as UserRole, siteIds: [] as string[] };
  const [form, setForm] = useState(blank);
  const create = useAction(() => api.post(`/organisations/${organisation!.id}/users`, { ...form, siteIds: form.role === 'ORG_MANAGER' && form.siteIds.length ? form.siteIds : null }), () => { setOpen(false); setForm(blank); });
  const update = useAction((args: { id: string; body: Record<string, unknown> }) => api.patch(`/organisations/${organisation!.id}/users/${args.id}`, args.body), () => setSitesFor(null));
  const toggleSite = (id: string, list: string[], set: (v: string[]) => void) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  return (
    <Card title="Users" description="Admins manage billing, users and settings; managers run the rota (optionally for particular sites only); workers see their own shifts." actions={<Button size="sm" onClick={() => setOpen(true)}>＋ Add user</Button>}>
      <ErrorBanner error={update.error} className="mb-3" />
      {users.isLoading ? <Loading /> : (
        <Table
          rows={users.data ?? []}
          rowKey={(u) => u.id}
          columns={[
            { key: 'name', header: 'Name', render: (u) => <span className="font-medium text-slate-900">{u.firstName} {u.lastName}{u.id === me?.id && <span className="ml-1 text-xs text-slate-400">(you)</span>}</span> },
            { key: 'email', header: 'Email', render: (u) => u.email },
            { key: 'role', header: 'Role', render: (u) => <Badge tone={u.role === 'PLATFORM_ADMIN' ? 'violet' : u.role === 'WORKER' ? 'blue' : 'brand'}>{humanise(u.role)}</Badge> },
            { key: 'sites', header: 'Sites', render: (u) => u.role === 'ORG_MANAGER' ? (u.siteIds?.length ? <span className="text-xs">{u.siteIds.map(siteName).join(', ')}</span> : <span className="text-xs text-slate-500">All sites</span>) : <span className="text-xs text-slate-400">—</span> },
            { key: 'security', header: '2FA', render: (u) => u.role === 'WORKER' ? <span className="text-xs text-slate-400">—</span> : u.twoFactorEnabled ? <Badge tone="green">On</Badge> : <Badge tone="amber">Not set up</Badge> },
            { key: 'status', header: 'Status', render: (u) => <StatusBadge status={u.status} /> },
            { key: 'last', header: 'Last login', render: (u) => fmtDateTime(u.lastLoginAt) },
            { key: 'actions', header: '', align: 'right', render: (u) => u.id !== me?.id && u.role !== 'PLATFORM_ADMIN' && (
              <span className="flex flex-wrap justify-end gap-1">
                {u.role !== 'WORKER' && <Select value={u.role} onChange={(e) => update.mutate({ id: u.id, body: { role: e.target.value } })} className="w-auto py-1 text-xs"><option value="ORG_ADMIN">Org admin</option><option value="ORG_MANAGER">Org manager</option></Select>}
                {u.role === 'ORG_MANAGER' && <Button size="sm" variant="secondary" onClick={() => { setSitesFor(u); setChosen(u.siteIds ?? []); }}>Sites</Button>}
                {u.twoFactorEnabled && <Button size="sm" variant="ghost" title="Lost phone: remove the authenticator so they can enrol a new one" onClick={() => update.mutate({ id: u.id, body: { resetTwoFactor: true } })}>Reset 2FA</Button>}
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
          {form.role === 'ORG_MANAGER' && (sites.data?.length ?? 0) > 0 && (
            <Field label="Limit to sites" hint="Leave all unticked for every site. A site-limited manager sees workers based at their sites (and unassigned workers) but not pay rates.">
              <div className="grid grid-cols-2 gap-1">{sites.data!.map((s) => <Checkbox key={s.id} label={s.name} checked={form.siteIds.includes(s.id)} onChange={() => toggleSite(s.id, form.siteIds, (v) => setForm({ ...form, siteIds: v }))} />)}</div>
            </Field>
          )}
        </div>
      </Modal>
      <Modal open={!!sitesFor} onClose={() => setSitesFor(null)} title={`Sites for ${sitesFor?.firstName ?? ''} ${sitesFor?.lastName ?? ''}`} footer={<><Button variant="secondary" onClick={() => setSitesFor(null)}>Cancel</Button><Button onClick={() => update.mutate({ id: sitesFor!.id, body: { siteIds: chosen.length ? chosen : null } })} loading={update.isPending}>Save</Button></>}>
        <div className="space-y-2">
          <p className="text-sm text-slate-600">Tick the sites this manager looks after. No ticks means every site.</p>
          <div className="grid grid-cols-2 gap-1">{(sites.data ?? []).map((s) => <Checkbox key={s.id} label={s.name} checked={chosen.includes(s.id)} onChange={() => toggleSite(s.id, chosen, setChosen)} />)}</div>
        </div>
      </Modal>
    </Card>
  );
}

/** The signed-in user's own sign-in security. */
function SecurityCard() {
  const { user, me, refresh } = useAuth();
  const u = user as UserWithSecurity | null;
  const [code, setCode] = useState('');
  const disable = useAction(() => api.post('/auth/2fa/disable', { code }), () => { setCode(''); void refresh(); });
  const required = (me?.platform as { twoFactorRequiredForManagers?: boolean } | undefined)?.twoFactorRequiredForManagers;
  return (
    <Card title="Your sign-in security" description={required ? 'The platform requires an authenticator app for managers and administrators.' : 'Add an authenticator app for a second step at sign-in.'}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-slate-700">
          Two-factor authentication: {u?.twoFactorEnabled ? <Badge tone="green">On</Badge> : <Badge tone="amber">Off</Badge>}
          <div className="mt-1 text-xs text-slate-500">Signed in as {u?.email}. <Link to="/change-password" className="font-medium text-brand-700 hover:underline">Change password</Link></div>
        </div>
        {u?.twoFactorEnabled ? (
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); disable.mutate(); }}>
            <Field label="Code from your app"><Input inputMode="numeric" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} className="w-32 font-mono" /></Field>
            <Button type="submit" variant="secondary" loading={disable.isPending}>Turn off / re-enrol</Button>
          </form>
        ) : (
          <LinkButton to="/setup-2fa">Set up authenticator</LinkButton>
        )}
      </div>
      <ErrorBanner error={disable.error} className="mt-2" />
    </Card>
  );
}
