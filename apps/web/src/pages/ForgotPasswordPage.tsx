import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Button, ErrorBanner, Field, InfoBanner, Input } from '../components/ui';
import { AuthShell } from './LoginPage';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/onboarding/forgot-password', { email });
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title="Forgotten your password?" subtitle="We will email you a link to choose a new one.">
      {sent ? (
        <div className="space-y-3">
          <InfoBanner tone="green">If there is an account for {email}, an email with a reset link is on its way. The link works for one hour.</InfoBanner>
          <Link to="/login" className="text-sm font-medium text-brand-700 hover:underline">Back to sign in</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <ErrorBanner error={error} />
          <Field label="Email" required>
            <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <Button type="submit" className="w-full" loading={busy}>
            Email me a reset link
          </Button>
          <p className="text-center text-xs text-slate-500">
            <Link to="/login" className="font-medium text-brand-700 hover:underline">Back to sign in</Link>
          </p>
        </form>
      )}
    </AuthShell>
  );
}
