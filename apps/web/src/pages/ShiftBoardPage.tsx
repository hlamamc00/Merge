import { useMemo, useState } from 'react';
import { JOB_ROLE_LABELS, JobRole } from '@merge/shared';
import { useAvailableShifts } from '../api/hooks';
import type { BoardShift } from '../api/types.dispatch';
import { useAuth } from '../auth/AuthContext';
import { ShiftCard } from '../components/ShiftCard';
import { Card, EmptyState, ErrorBanner, Field, Input, InfoBanner, Loading, PageHeader, Select } from '../components/ui';

type Sort = 'opens' | 'start' | 'rate' | 'distance';

export function ShiftBoardPage() {
  const { isWorker, me } = useAuth();
  const [role, setRole] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<Sort>('opens');
  const [nearKm, setNearKm] = useState('');
  const [onlyEligible, setOnlyEligible] = useState(false);
  const q = useAvailableShifts({
    jobRole: role || undefined,
    from: from ? new Date(from).toISOString() : undefined,
    to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined,
    sort,
    nearKm: nearKm || undefined,
  });
  const { openNow, soon } = useMemo(() => {
    const list = ((q.data ?? []) as BoardShift[]).filter((s) => !onlyEligible || s.eligible !== false);
    return { openNow: list.filter((s) => s.access.open), soon: list.filter((s) => !s.access.open) };
  }, [q.data, onlyEligible]);
  const hasLocation = isWorker ? me?.worker?.lat != null : me?.organisation.lat != null;

  return (
    <div className="space-y-5">
      <PageHeader title="Shift board" description={isWorker ? 'Shifts you could take at other organisations. Each card says whether you are eligible and how far it is from home.' : 'Shifts other organisations have released to yours. Priority access comes from your active surplus flags and preferred-partner status.'} />
      {isWorker && !me?.organisation.workerSelfServiceAllowed && <InfoBanner tone="amber">Your employer has not enabled self-service shift requests, so the board is empty for you. Your manager can still book you onto shifts.</InfoBanner>}
      <Card>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
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
          <Field label="Sort by">
            <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="opens">When it opens to you</option>
              <option value="start">Start time</option>
              {!isWorker && <option value="rate">Highest rate</option>}
              <option value="distance">Nearest first</option>
            </Select>
          </Field>
          <Field label="Within (km)" hint={hasLocation ? undefined : isWorker ? 'Add your home location to use this.' : 'Add your organisation address to use this.'}>
            <Input type="number" min="1" max="500" placeholder="any" value={nearKm} onChange={(e) => setNearKm(e.target.value)} disabled={!hasLocation} />
          </Field>
          {isWorker && (
            <Field label="Show">
              <Select value={onlyEligible ? 'eligible' : 'all'} onChange={(e) => setOnlyEligible(e.target.value === 'eligible')}>
                <option value="all">All shifts</option>
                <option value="eligible">Only shifts I can take</option>
              </Select>
            </Field>
          )}
        </div>
      </Card>
      <ErrorBanner error={q.error} />
      {q.isLoading ? <Loading /> : (
        <>
          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-700">Open to you now <span className="text-slate-400">({openNow.length})</span></h2>
            {openNow.length === 0 ? <EmptyState title="Nothing open right now" description={isWorker ? 'Check back later, or widen the distance filter.' : 'Raise a surplus flag to get first access when matching shifts are posted.'} /> : (
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
