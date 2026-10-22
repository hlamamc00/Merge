import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button, Card, ErrorBanner, Field, InfoBanner, Input, PageHeader } from '../components/ui';

export function ChangePasswordPage() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const mustChange = !!(me?.user as { mustChangePassword?: boolean } | undefined)?.mustChangePassword;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError(new Error('The two passwords do not match'));
    setBusy(true);
    setError(null);
    try {
      await api.post('/onboarding/change-password', { currentPassword: current, newPassword: password });
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-lg space-y-5">
      <PageHeader title="Change your password" description={mustChange ? 'You need to choose a new password before you carry on.' : 'Choose a new password for your Merge account.'} />
      {mustChange && <InfoBanner tone="amber">Your current password was set for you. Pick one only you know.</InfoBanner>}
      <Card>
        <form onSubmit={submit} className="space-y-4">
          <ErrorBanner error={error} />
          <Field label="Current password" required>
            <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </Field>
          <Field label="New password" hint="At least 10 characters. Avoid common passwords." required>
            <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
          </Field>
          <Field label="Confirm new password" required>
            <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </Field>
          <Button type="submit" loading={busy}>
            Change password
          </Button>
        </form>
      </Card>
    </div>
  );
}
