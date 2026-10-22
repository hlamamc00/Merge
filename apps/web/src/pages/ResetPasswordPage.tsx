import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { Button, ErrorBanner, Field, Input } from '../components/ui';
import { AuthShell } from './LoginPage';

export function ResetPasswordPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError(new Error('The two passwords do not match'));
    setBusy(true);
    setError(null);
    try {
      await api.post('/onboarding/reset-password', { token, password });
      navigate('/login', { replace: true, state: { message: 'Your password has been changed. Sign in with the new one.' } });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title="Choose a new password" subtitle="At least 10 characters. Avoid common passwords.">
      <form onSubmit={submit} className="space-y-4">
        <ErrorBanner error={error} />
        <Field label="New password" required>
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
        </Field>
        <Field label="Confirm new password" required>
          <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </Field>
        <Button type="submit" className="w-full" loading={busy}>
          Change password
        </Button>
        <p className="text-center text-xs text-slate-500">
          Link expired? <Link to="/forgot-password" className="font-medium text-brand-700 hover:underline">Request a new one</Link>
        </p>
      </form>
    </AuthShell>
  );
}
