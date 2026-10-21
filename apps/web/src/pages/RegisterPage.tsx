import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ServiceType } from '@merge/shared';
import { useAuth } from '../auth/AuthContext';
import { Button, Checkbox, ErrorBanner, Field, Input } from '../components/ui';
import { humanise } from '../lib/format';
import { AuthShell } from './LoginPage';

export function RegisterPage() {
  const { register, me, loading } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [org, setOrg] = useState({ name: '', postcode: '', city: '', addressLine1: '', phone: '', email: '', cqcRegistrationNumber: '', defaultChargeRate: '18', serviceTypes: [] as string[] });
  const [admin, setAdmin] = useState({ firstName: '', lastName: '', email: '', password: '' });

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
      });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Join the Merge network" subtitle="Register your care organisation and its first administrator.">
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
          <Field label="CQC registration">
            <Input value={org.cqcRegistrationNumber} onChange={(e) => setOrg({ ...org, cqcRegistrationNumber: e.target.value })} />
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
