import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Button, ErrorBanner, Field, InfoBanner, Input } from '../components/ui';

const DEMO = [
  ['admin@merge.local', 'Platform admin (Merge Staffing agency)'],
  ['admin@oakwood.local', 'Oakwood Care Homes – short-staffed, posting shifts'],
  ['admin@riverside.local', 'Riverside Living – surplus flag, priority access'],
  ['admin@brighthorizons.local', 'Bright Horizons Support – surplus support workers'],
  ['admin@pennine.local', 'Pennine Nursing – nurse shortage'],
  ['aisha@riverside.local', 'A care worker with self-service enabled'],
];

export function LoginPage() {
  const { login, verifyTwoFactor, me, loading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/';

  if (!loading && me) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login(email, password);
      if (result.challengeToken) {
        setChallenge(result.challengeToken);
        return;
      }
      navigate(from, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      await verifyTwoFactor(challenge, code);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (challenge) {
    return (
      <AuthShell title="Enter your authenticator code" subtitle="Open your authenticator app and type the six-digit code for Merge.">
        <form onSubmit={submitCode} className="space-y-4">
          <ErrorBanner error={error} />
          <Field label="Six-digit code" required>
            <Input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} autoFocus value={code} onChange={(e) => setCode(e.target.value)} required className="text-center font-mono text-lg tracking-[0.4em]" />
          </Field>
          <Button type="submit" className="w-full" loading={busy}>
            Verify and sign in
          </Button>
          <p className="text-center text-xs text-slate-500">
            <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => { setChallenge(null); setCode(''); setError(null); }}>Start again</button>
            {' · '}Lost your phone? Ask your organisation's administrator to reset your authenticator.
          </p>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Sign in to Merge" subtitle="Lend and borrow care staff across your network.">
      <form onSubmit={submit} className="space-y-4">
        <ErrorBanner error={error} />
        <Field label="Email" required>
          <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password" required>
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <Button type="submit" className="w-full" loading={busy}>
          Sign in
        </Button>
        <p className="flex items-center justify-between text-xs text-slate-500">
          <Link to="/forgot-password" className="font-medium text-brand-700 hover:underline">Forgotten your password?</Link>
          <span>New care provider? <Link to="/register" className="font-medium text-brand-700 hover:underline">Join the network</Link></span>
        </p>
      </form>
      <InfoBanner tone="slate" className="mt-5 text-xs">Managers and administrators sign in with a password and an authenticator app. You will be asked to set the app up the first time you sign in.</InfoBanner>
      <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
        <div className="mb-1 font-semibold">Demo logins (password: <code>password123</code>)</div>
        <ul className="space-y-1">
          {DEMO.map(([e, d]) => (
            <li key={e} className="flex flex-wrap items-baseline gap-x-2">
              <button type="button" className="font-mono text-amber-900 underline decoration-dotted hover:decoration-solid" onClick={() => { setEmail(e!); setPassword('password123'); }}>
                {e}
              </button>
              <span className="text-amber-800/80">{d}</span>
            </li>
          ))}
        </ul>
      </div>
    </AuthShell>
  );
}

export function AuthShell({ title, subtitle, children, wide }: { title: string; subtitle?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-brand-50 via-slate-50 to-slate-100 px-4 py-10">
      <div className={`w-full ${wide ? 'max-w-2xl' : 'max-w-md'}`}>
        <div className="mb-6 flex items-center justify-center gap-2">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-600 text-lg font-bold text-white">M</span>
          <span className="text-2xl font-semibold tracking-tight text-slate-900">Merge</span>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
          {subtitle && <p className="mb-4 mt-0.5 text-sm text-slate-500">{subtitle}</p>}
          {children}
        </div>
      </div>
    </div>
  );
}
