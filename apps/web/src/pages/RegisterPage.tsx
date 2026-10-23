import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ServiceType } from '@merge/shared';
import { api } from '../api/client';
import type { MouDocument } from '../api/types.compliance';
import { useAuth } from '../auth/AuthContext';
import { Button, Checkbox, ErrorBanner, Field, InfoBanner, Input, Loading } from '../components/ui';
import { humanise } from '../lib/format';
import { AuthShell } from './LoginPage';

export function RegisterPage() {
  const { register, me, loading } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [org, setOrg] = useState({ name: '', postcode: '', city: '', addressLine1: '', phone: '', email: '', cqcRegistrationNumber: '', defaultChargeRate: '18', serviceTypes: [] as string[] });
  const [admin, setAdmin] = useState({ firstName: '', lastName: '', email: '', password: '' });
  const [mouAccepted, setMouAccepted] = useState(false);
  const [showMou, setShowMou] = useState(false);
  const mou = useQuery({ queryKey: ['mou'], queryFn: () => api.get<MouDocument>('/organisations/mou'), staleTime: Infinity });

  if (!loading && me) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register({
        organisation: {
          name: org.name,
          postcode: org.postcode || undefined,
          city: org.city || undefined,
          addressLine1: org.addressLine1 || undefined,
          phone: org.phone || undefined,
          email: org.email || undefined,
          cqcRegistrationNumber: org.cqcRegistrationNumber || undefined,
          defaultChargeRate: org.defaultChargeRate ? Number(org.defaultChargeRate) : undefined,
          serviceTypes: org.serviceTypes,
        },
        admin,
        mouAccepted,
      });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Join the Merge network" subtitle="Register your care organisation and its first administrator. The platform team checks your registration before activating you.">
      <form onSubmit={submit} className="space-y-4">
        <ErrorBanner error={error} />
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Organisation</div>
        <Field label="Organisation name" required>
          <Input value={org.name} onChange={(e) => setOrg({ ...org, name: e.target.value })} required minLength={2} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Postcode">
            <Input value={org.postcode} onChange={(e) => setOrg({ ...org, postcode: e.target.value })} placeholder="M20 2RN" />
          </Field>
          <Field label="Town / city">
            <Input value={org.city} onChange={(e) => setOrg({ ...org, city: e.target.value })} />
          </Field>
          <Field label="CQC registration number" hint="Needed before approval. Found on your CQC certificate (e.g. 1-123456789).">
            <Input value={org.cqcRegistrationNumber} onChange={(e) => setOrg({ ...org, cqcRegistrationNumber: e.target.value })} placeholder="1-123456789" />
          </Field>
          <Field label="Default charge rate (£/h)">
            <Input type="number" step="0.5" min="1" value={org.defaultChargeRate} onChange={(e) => setOrg({ ...org, defaultChargeRate: e.target.value })} />
          </Field>
        </div>
        <Field label="Services">
          <div className="grid grid-cols-2 gap-1">
            {Object.values(ServiceType).map((s) => (
              <Checkbox key={s} label={humanise(s)} checked={org.serviceTypes.includes(s)} onChange={(e) => setOrg({ ...org, serviceTypes: e.target.checked ? [...org.serviceTypes, s] : org.serviceTypes.filter((x) => x !== s) })} />
            ))}
          </div>
        </Field>
        <div className="pt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Administrator</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name" required>
            <Input value={admin.firstName} onChange={(e) => setAdmin({ ...admin, firstName: e.target.value })} required />
          </Field>
          <Field label="Last name" required>
            <Input value={admin.lastName} onChange={(e) => setAdmin({ ...admin, lastName: e.target.value })} required />
          </Field>
        </div>
        <Field label="Email" required>
          <Input type="email" value={admin.email} onChange={(e) => setAdmin({ ...admin, email: e.target.value })} required />
        </Field>
        <Field label="Password" hint="At least 8 characters" required>
          <Input type="password" value={admin.password} onChange={(e) => setAdmin({ ...admin, password: e.target.value })} required minLength={8} />
        </Field>

        <div className="pt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Memorandum of understanding</div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
          {mou.isLoading ? <Loading /> : mou.data ? (
            <>
              <p className="text-slate-600">{mou.data.summary} <span className="text-xs text-slate-400">(version {mou.data.version})</span></p>
              <button type="button" className="mt-1 text-xs font-medium text-brand-700 hover:underline" onClick={() => setShowMou((v) => !v)}>{showMou ? 'Hide the full text' : 'Read the full text'}</button>
              {showMou && <MouText mou={mou.data} />}
            </>
          ) : (
            <InfoBanner tone="amber">The memorandum could not be loaded. You can accept it later from Settings.</InfoBanner>
          )}
        </div>
        <Checkbox label="I am authorised to sign on behalf of this organisation and we agree to the memorandum of understanding" checked={mouAccepted} onChange={(e) => setMouAccepted(e.target.checked)} />
        <Button type="submit" className="w-full" loading={busy}>
          Create organisation
        </Button>
        <p className="text-center text-xs text-slate-500">
          Already registered? <Link to="/login" className="font-medium text-brand-700 hover:underline">Sign in</Link>
        </p>
      </form>
    </AuthShell>
  );
}

export function MouText({ mou }: { mou: MouDocument }) {
  return (
    <div className="mt-2 max-h-72 space-y-3 overflow-y-auto rounded-md border border-slate-200 bg-white p-3 text-sm">
      <h2 className="font-semibold text-slate-900">{mou.title}</h2>
      {mou.sections.map((s) => (
        <section key={s.heading}>
          <h3 className="font-medium text-slate-800">{s.heading}</h3>
          <p className="mt-0.5 text-slate-600">{s.body}</p>
        </section>
      ))}
    </div>
  );
}
