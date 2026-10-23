import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { TwoFactorSetup } from '../api/types.compliance';
import { useAuth } from '../auth/AuthContext';
import { Button, ErrorBanner, Field, InfoBanner, Input, Loading } from '../components/ui';
import { AuthShell } from './LoginPage';

/**
 * Enrol an authenticator app (decision 16). Shown automatically to managers and administrators
 * who have not set one up yet when the platform requires it, and reachable from Settings otherwise.
 */
export function TwoFactorSetupPage() {
  const { me, loading, refresh, logout, gate } = useAuth();
  const navigate = useNavigate();
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (loading) return <div className="p-8"><Loading /></div>;
  if (!me) return <Navigate to="/login" replace />;
  const alreadyEnabled = (me.user as { twoFactorEnabled?: boolean }).twoFactorEnabled;

  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      setSetup(await api.post<TwoFactorSetup>('/auth/2fa/setup'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/2fa/enable', { code });
      setDone(true);
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const grouped = setup ? setup.secret.match(/.{1,4}/g)?.join(' ') ?? setup.secret : '';

  return (
    <AuthShell title={alreadyEnabled && !done ? 'Authenticator already set up' : 'Set up your authenticator app'} subtitle={gate === 'TWO_FACTOR' ? 'Managers and administrators must use an authenticator app as well as a password. This takes about a minute.' : 'Add a second step to your sign-in.'}>
      <ErrorBanner error={error} className="mb-3" />
      {alreadyEnabled && !done ? (
        <div className="space-y-3 text-sm text-slate-600">
          <p>Your account already asks for an authenticator code at sign-in. To move to a new phone, disable the authenticator from Settings and set it up again.</p>
          <Button onClick={() => navigate('/')}>Back to Merge</Button>
        </div>
      ) : !setup ? (
        <div className="space-y-4 text-sm text-slate-600">
          <ol className="list-decimal space-y-1 pl-5">
            <li>Install an authenticator app on your phone if you do not have one: Microsoft Authenticator, Google Authenticator, Authy and 1Password all work.</li>
            <li>Press the button below to get your set-up key.</li>
            <li>Add the key to the app and enter the six-digit code it shows to finish.</li>
          </ol>
          <Button onClick={begin} loading={busy} className="w-full">Get my set-up key</Button>
          <p className="text-center text-xs text-slate-500">Signed in as {me.user.email}. <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => { logout(); navigate('/login'); }}>Sign out</button></p>
        </div>
      ) : (
        <form onSubmit={confirm} className="space-y-4">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Set-up key</div>
            <div className="mt-1 select-all break-all font-mono text-lg tracking-wider text-slate-900">{grouped}</div>
            <p className="mt-2 text-xs text-slate-500">In your app choose "Enter a setup key" (or "manual entry"), give it the name Merge, paste this key and keep the type as time-based. On a phone, <a className="font-medium text-brand-700 hover:underline" href={setup.otpauthUrl}>open this link</a> to add it in one tap.</p>
          </div>
          <Field label="Six-digit code from the app" required>
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={7} autoFocus value={code} onChange={(e) => setCode(e.target.value)} required className="text-center font-mono text-lg tracking-[0.4em]" />
          </Field>
          <Button type="submit" className="w-full" loading={busy}>Turn on two-factor authentication</Button>
          <InfoBanner tone="amber" className="text-xs">Keep the key somewhere safe, or make sure your app backs it up. If you lose your phone, an administrator of your organisation can reset your authenticator from Settings.</InfoBanner>
        </form>
      )}
    </AuthShell>
  );
}
