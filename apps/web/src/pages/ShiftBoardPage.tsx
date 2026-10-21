import { useMemo, useState } from 'react';
import { JOB_ROLE_LABELS, JobRole } from '@merge/shared';
import { useAvailableShifts } from '../api/hooks';
import { useAuth } from '../auth/AuthContext';
import { ShiftCard } from '../components/ShiftCard';
import { Card, EmptyState, ErrorBanner, Field, Input, InfoBanner, Loading, PageHeader, Select } from '../components/ui';

export function ShiftBoardPage() {
  const { isWorker, me } = useAuth();
  const [role, setRole] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const q = useAvailableShifts({ jobRole: role || undefined, from: from ? new Date(from).toISOString() : undefined, to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined });
  const { openNow, soon } = useMemo(() => {
    const list = q.data ?? [];
    return { openNow: list.filter((s) => s.access.open), soon: list.filter((s) => !s.access.open) };
  }, [q.data]);

  return (
    <div className="space-y-5">
      <PageHeader title="Shift board" description="Shifts other organisations have released to yours. Priority access comes from your active surplus flags and preferred-partner status." />
      {isWorker && !me?.organisation.workerSelfServiceAllowed && <InfoBanner tone="amber">Your employer has not enabled self-service shift requests, so the board is empty for you. Your manager can still book you onto shifts.</InfoBanner>}
      <Card>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">All roles</option>
              {Object.values(JobRole).map((r) => (
                <option key={r} value={r}>{JOB_ROLE_LABELS[r]}</option>
              ))}
            </Select>
          </Field>
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
      </Card>
      <ErrorBanner error={q.error} />
      {q.isLoading ? <Loading /> : (
        <>
          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-700">Open to you now <span className="text-slate-400">({openNow.length})</span></h2>
            {openNow.length === 0 ? <EmptyState title="Nothing open right now" description="Raise a surplus flag to get first access when matching shifts are posted." /> : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {openNow.map((s) => (
                  <ShiftCard key={s.id} shift={s} />
                ))}
              </div>
            )}
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-700">Opening soon <span className="text-slate-400">({soon.length})</span></h2>
            {soon.length === 0 ? <EmptyState title="No shifts waiting to open" /> : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {soon.map((s) => (
                  <ShiftCard key={s.id} shift={s} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
