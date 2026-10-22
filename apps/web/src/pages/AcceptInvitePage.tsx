import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, setToken } from '../api/client';
import type { InvitationInfo } from '../api/types.onboarding';
import { useAuth } from '../auth/AuthContext';
import { Button, ErrorBanner, Field, Input, Loading } from '../components/ui';
import { AuthShell } from './LoginPage';

export function AcceptInvitePage() {
  const { token = '' } = useParams();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const info = useQuery({ queryKey: ['invitation', token], queryFn: () => api.get<InvitationInfo>(`/onboarding/invitations/${token}`), retry: false });
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
      const res = await api.post<{ token: string }>(`/onboarding/invitations/${token}/accept`, { password });
      setToken(res.token);
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Welcome to Merge" subtitle={info.data ? `${info.data.organisationName} has set up an account for ${info.data.firstName} ${info.data.lastName}.` : 'Set your password to get started.'}>
      {info.isLoading ? (
        <Loading />
      ) : info.error ? (
        <div className="space-y-3">
          <ErrorBanner error={info.error} />
          <p className="text-sm text-slate-600">This invitation link is not valid any more. Ask the person who invited you to send a new one.</p>
          <Link to="/login" className="text-sm font-medium text-brand-700 hover:underline">Go to sign in</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <ErrorBanner error={error} />
          <Field label="Email">
            <Input value={info.data?.email ?? ''} readOnly />
          </Field>
          <Field label="Choose a password" hint="At least 10 characters. Avoid common passwords." required>
            <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
          </Field>
          <Field label="Confirm password" required>
            <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </Field>
          <Button type="submit" className="w-full" loading={busy}>
            Set password and sign in
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
