import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { DOCUMENT_LABELS, DocumentType, JOB_ROLE_LABELS, JobRole, SKILL_LABELS, ShiftVisibility, Skill } from '@merge/shared';
import { api } from '../api/client';
import { useAction, useSites } from '../api/hooks';
import type { DispatchPreview, Shift } from '../api/types';
import type { FloorRate, HostRequirement, SeriesResponse } from '../api/types.dispatch';
import { useAuth } from '../auth/AuthContext';
import { Badge, Button, Card, Checkbox, ErrorBanner, Field, InfoBanner, Input, LinkButton, Loading, PageHeader, Select, Textarea } from '../components/ui';
import { fmtDuration, fmtMoney, fromLocalInput, toLocalInput } from '../lib/format';
import { ReleasePlan } from './ShiftDetailPage';

const VISIBILITY_HELP: Record<ShiftVisibility, string> = {
  NETWORK: 'Staged release: organisations with a matching surplus flag (and preferred partners) first, then the agency bank, then the whole network.',
  PRIORITY_ONLY: 'Only organisations with a matching surplus flag or preferred-partner status, plus the agency bank. Never opens to the wider network.',
  PREFERRED_ONLY: 'Only your preferred partners.',
  AGENCY_ONLY: "Only the platform agency's own bank.",
};

const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

/** The dates a weekly pattern will produce (local time; the server uses the platform time zone). */
export function expandRepeat(startsAt: string, weekdays: number[], from: string, to: string): Date[] {
  if (!from || !to || weekdays.length === 0) return [];
  const start = new Date(startsAt);
  const first = new Date(`${from}T00:00:00`);
  const last = new Date(`${to}T00:00:00`);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime()) || Number.isNaN(start.getTime()) || last < first) return [];
  const out: Date[] = [];
  for (let d = new Date(first); d <= last && out.length <= 60; d.setDate(d.getDate() + 1)) {
    if (!weekdays.includes(d.getDay())) continue;
    const occ = new Date(d);
    occ.setHours(start.getHours(), start.getMinutes(), 0, 0);
    out.push(occ);
  }
  return out;
}

export function NewShiftPage() {
  const { organisation, me } = useAuth();
  const navigate = useNavigate();
  const sites = useSites(organisation?.id);
  const floorQ = useQuery({ queryKey: ['floor-rate'], queryFn: () => api.get<FloorRate>('/shifts/floor-rate') });
  // Decision 11: host-specific requirements. Hidden when the compliance module is not available (404).
  const reqsQ = useQuery({ queryKey: ['host-requirements'], queryFn: () => api.get<HostRequirement[]>('/compliance/requirements'), retry: false });
  const hostRequirements = reqsQ.data ?? [];
  const tomorrow7 = new Date();
  tomorrow7.setDate(tomorrow7.getDate() + 1);
  tomorrow7.setHours(7, 0, 0, 0);
  const tomorrow19 = new Date(tomorrow7);
  tomorrow19.setHours(19, 0, 0, 0);

  const [form, setForm] = useState({
    siteId: '',
    jobRole: 'CARE_ASSISTANT' as JobRole,
    title: '',
    description: '',
    startsAt: toLocalInput(tomorrow7),
    endsAt: toLocalInput(tomorrow19),
    breakMinutes: '30',
    headcount: '1',
    requiredSkills: ['MOVING_AND_HANDLING'] as Skill[],
    extraRequiredDocuments: [] as DocumentType[],
    requiredHostRequirementIds: [] as string[],
    chargeRate: organisation?.defaultChargeRate ? String(organisation.defaultChargeRate) : '18',
    visibility: 'NETWORK' as ShiftVisibility,
    priorityWindowMinutesOverride: '',
    autoConfirm: false,
  });
  const [repeat, setRepeat] = useState({ on: false, weekdays: [1, 2, 3, 4, 5] as number[], from: '', to: '' });
  const [draft, setDraft] = useState<Shift | null>(null);

  const siteId = form.siteId || sites.data?.[0]?.id || '';
  const floor = floorQ.data?.floor;
  const belowFloor = floor !== undefined && Number(form.chargeRate) < floor;

  const payload = () => ({
    siteId,
    jobRole: form.jobRole,
    title: form.title,
    description: form.description || null,
    startsAt: fromLocalInput(form.startsAt),
    endsAt: fromLocalInput(form.endsAt),
    breakMinutes: Number(form.breakMinutes),
    headcount: Number(form.headcount),
    requiredSkills: form.requiredSkills,
    extraRequiredDocuments: form.extraRequiredDocuments,
    requiredHostRequirementIds: form.requiredHostRequirementIds,
    chargeRate: Number(form.chargeRate),
    visibility: form.visibility,
    priorityWindowMinutesOverride: form.priorityWindowMinutesOverride === '' ? null : Number(form.priorityWindowMinutesOverride),
    autoConfirm: form.autoConfirm,
    publish: false,
  });

  const occurrences = useMemo(() => expandRepeat(form.startsAt, repeat.weekdays, repeat.from, repeat.to), [form.startsAt, repeat]);
  const durationHours = (new Date(form.endsAt).getTime() - new Date(form.startsAt).getTime()) / 3_600_000;
  const seriesBody = (publish: boolean) => {
    const { startsAt: _s, endsAt: _e, publish: _p, ...template } = payload();
    const start = new Date(form.startsAt);
    return {
      template,
      pattern: { startTime: `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`, durationHours: Math.round(durationHours * 100) / 100, weekdays: repeat.weekdays, from: repeat.from, to: repeat.to },
      publish,
    };
  };

  const saveDraft = useAction(async () => {
    if (repeat.on) {
      const r = await api.post<SeriesResponse>('/shifts/series', seriesBody(false));
      navigate(`/shifts/posted?seriesId=${r.seriesId}`);
      return null;
    }
    if (draft) return api.patch<Shift>(`/shifts/${draft.id}`, { ...payload(), publish: undefined });
    return api.post<Shift>('/shifts', payload());
  }, (s) => s && setDraft(s));
  const publish = useAction(async () => {
    if (repeat.on) {
      const r = await api.post<SeriesResponse>('/shifts/series', seriesBody(true));
      navigate(`/shifts/posted?seriesId=${r.seriesId}`);
      return null;
    }
    const d = draft ?? (await api.post<Shift>('/shifts', payload()));
    return api.post<Shift>(`/shifts/${d.id}/publish`);
  }, (s) => s && navigate(`/shifts/${s.id}`));
  const preview = useQuery({ queryKey: ['dispatch-preview', draft?.id, draft], queryFn: () => api.get<DispatchPreview>(`/shifts/${draft!.id}/dispatch-preview`), enabled: !!draft });

  const onPreview = (e: FormEvent) => {
    e.preventDefault();
    saveDraft.mutate();
  };

  const toggle = <T extends string | number>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const hours = durationHours - Number(form.breakMinutes || 0) / 60;
  const leadMs = new Date(form.startsAt).getTime() - Date.now();
  const urgent = leadMs <= (me?.platform.urgentThresholdMinutes ?? 720) * 60_000;
  const count = occurrences.length;

  return (
    <div className="space-y-5">
      <PageHeader title="Post a shift" description="Describe the cover you need. You will see exactly who gets access and when before you publish." />
      {sites.data && sites.data.length === 0 && <InfoBanner tone="amber">You need at least one site before posting a shift. <LinkButton to="/settings" size="sm" variant="secondary" className="ml-2">Add a site</LinkButton></InfoBanner>}
      <form onSubmit={onPreview} className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title="The shift">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Site" required>
                <Select value={siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })} required>
                  {sites.isLoading && <option>Loading…</option>}
                  {(sites.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>{s.name} ({s.postcode})</option>
                  ))}
                </Select>
              </Field>
              <Field label="Role" required>
                <Select value={form.jobRole} onChange={(e) => setForm({ ...form, jobRole: e.target.value as JobRole })}>
                  {Object.values(JobRole).map((r) => (
                    <option key={r} value={r}>{JOB_ROLE_LABELS[r]}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Title" required className="sm:col-span-2">
                <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Day shift – Maple unit" required minLength={2} />
              </Field>
              <Field label="Description" className="sm:col-span-2" hint="Unit, residents, handover, anything the worker should know.">
                <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </Field>
              <Field label={repeat.on ? 'First shift starts' : 'Starts'} required hint={repeat.on ? 'Sets the time of day for every repeat.' : undefined}>
                <Input type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} required />
              </Field>
              <Field label="Ends" required>
                <Input type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} required />
              </Field>
              <Field label="Unpaid break (minutes)">
                <Input type="number" min="0" max="240" value={form.breakMinutes} onChange={(e) => setForm({ ...form, breakMinutes: e.target.value })} />
              </Field>
              <Field label="Workers needed">
                <Input type="number" min="1" max="50" value={form.headcount} onChange={(e) => setForm({ ...form, headcount: e.target.value })} />
              </Field>
            </div>
            <div className="mt-3 text-xs text-slate-500">
              {Number.isFinite(hours) && hours > 0 ? `${Math.round(hours * 10) / 10} paid hours per worker` : 'End must be after start'}
              {urgent && !repeat.on && <span className="ml-2 font-medium text-rose-600">Starts within the urgent window: all tiers will open immediately.</span>}
            </div>
          </Card>

          <Card title="Repeat" description="Post the same shift on several dates at once. Each date becomes its own shift that you can manage separately.">
            <Checkbox label="Repeat this shift weekly" checked={repeat.on} onChange={(e) => setRepeat({ ...repeat, on: e.target.checked })} />
            {repeat.on && (
              <div className="mt-3 space-y-3">
                <Field label="On these days">
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAYS.map((d) => (
                      <button key={d.value} type="button" onClick={() => setRepeat({ ...repeat, weekdays: toggle(repeat.weekdays, d.value) })} className={`rounded-full border px-3 py-1 text-xs font-medium ${repeat.weekdays.includes(d.value) ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-300 text-slate-600'}`}>
                        {d.label}
                      </button>
                    ))}
                  </div>
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="From" required><Input type="date" value={repeat.from} onChange={(e) => setRepeat({ ...repeat, from: e.target.value })} required /></Field>
                  <Field label="To" required><Input type="date" value={repeat.to} onChange={(e) => setRepeat({ ...repeat, to: e.target.value })} required /></Field>
                </div>
                <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
                  {count === 0 ? 'Pick the days and a date range to see the dates.' : count > 60 ? <span className="text-rose-600">Too many shifts: a series can hold at most 60. Shorten the range.</span> : (
                    <>
                      <div className="mb-1 font-semibold">{count} shift{count === 1 ? '' : 's'} will be created</div>
                      <div className="flex flex-wrap gap-1">
                        {occurrences.map((d) => (
                          <Badge key={d.toISOString()}>{d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} {d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</Badge>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </Card>

          <Card title="Requirements">
            <Field label="Required skills">
              <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                {Object.values(Skill).map((s) => (
                  <Checkbox key={s} label={SKILL_LABELS[s]} checked={form.requiredSkills.includes(s)} onChange={() => setForm({ ...form, requiredSkills: toggle(form.requiredSkills, s) })} />
                ))}
              </div>
            </Field>
            <Field label="Extra documents beyond the role standard" className="mt-3">
              <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                {Object.values(DocumentType).map((d) => (
                  <Checkbox key={d} label={DOCUMENT_LABELS[d]} checked={form.extraRequiredDocuments.includes(d)} onChange={() => setForm({ ...form, extraRequiredDocuments: toggle(form.extraRequiredDocuments, d) })} />
                ))}
              </div>
            </Field>
            {hostRequirements.length > 0 && (
              <Field label="Your own requirements" className="mt-3" hint="Training or inductions specific to your organisation. Workers without them cannot be put forward.">
                <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {hostRequirements.map((r) => (
                    <Checkbox key={r.id} label={r.name} hint={r.description ?? (r.recordedByHost ? 'Recorded by you' : undefined)} checked={form.requiredHostRequirementIds.includes(r.id)} onChange={() => setForm({ ...form, requiredHostRequirementIds: toggle(form.requiredHostRequirementIds, r.id) })} />
                  ))}
                </div>
              </Field>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Rate & release">
            <div className="space-y-3">
              <Field
                label="Charge rate (£ per hour)"
                required
                hint={
                  <>
                    You pay this; the platform keeps {me?.platform.platformFeePct ?? 8}% and the supplying organisation receives the rest.
                    {floor !== undefined && <> Platform floor: <strong>{fmtMoney(floor)}/h</strong> (minimum wage plus employer on-costs and the platform fee).</>}
                  </>
                }
              >
                <Input type="number" step="0.05" min={floor ?? 1} value={form.chargeRate} onChange={(e) => setForm({ ...form, chargeRate: e.target.value })} required />
                {belowFloor && <div className="mt-1 text-xs font-medium text-rose-600">Below the platform floor of {fmtMoney(floor)}/h. The shift cannot be saved at this rate.</div>}
              </Field>
              <Field label="Visibility" hint={VISIBILITY_HELP[form.visibility]}>
                <Select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value as ShiftVisibility })}>
                  <option value="NETWORK">Network (staged)</option>
                  <option value="PRIORITY_ONLY">Priority organisations only</option>
                  <option value="PREFERRED_ONLY">Preferred partners only</option>
                  <option value="AGENCY_ONLY">Agency bank only</option>
                </Select>
              </Field>
              <Field label="Priority window override (minutes)" hint={`Default ${me?.platform.priorityWindowMinutes ?? 120} min${form.priorityWindowMinutesOverride !== '' ? ` → ${fmtDuration(Number(form.priorityWindowMinutesOverride) * 60_000)}` : ''}. Set 0 to open to everyone at once.`}>
                <Input type="number" min="0" value={form.priorityWindowMinutesOverride} onChange={(e) => setForm({ ...form, priorityWindowMinutesOverride: e.target.value })} placeholder="default" />
              </Field>
              <Checkbox label="Instant book" hint="The first eligible request is confirmed automatically — good for urgent cover." checked={form.autoConfirm} onChange={(e) => setForm({ ...form, autoConfirm: e.target.checked })} />
            </div>
          </Card>
          <Card>
            <ErrorBanner error={saveDraft.error ?? publish.error} className="mb-3" />
            <div className="flex flex-col gap-2">
              {repeat.on ? (
                <>
                  <Button type="submit" variant="secondary" loading={saveDraft.isPending} disabled={count === 0 || count > 60 || belowFloor}>Create {count || ''} draft{count === 1 ? '' : 's'}</Button>
                  <Button type="button" onClick={() => publish.mutate()} loading={publish.isPending} disabled={!siteId || !form.title || count === 0 || count > 60 || belowFloor}>Publish {count || ''} shift{count === 1 ? '' : 's'}</Button>
                  <span className="text-center text-xs text-slate-500">Each date is released with its own plan, like a single shift.</span>
                </>
              ) : (
                <>
                  <Button type="submit" variant="secondary" loading={saveDraft.isPending} disabled={belowFloor}>{draft ? 'Update draft & preview' : 'Save draft & preview release plan'}</Button>
                  <Button type="button" onClick={() => publish.mutate()} loading={publish.isPending} disabled={!siteId || !form.title || belowFloor}>Publish now</Button>
                  {draft && <span className="text-center text-xs text-slate-500">Draft saved. Publishing releases it to the plan below.</span>}
                </>
              )}
            </div>
          </Card>
        </div>
      </form>

      {draft && !repeat.on && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Who will see this and when</h2>
          {preview.isLoading || !preview.data ? <Loading /> : <ReleasePlan entries={preview.data.entries} urgent={preview.data.urgent} excluded={preview.data.excluded} stages={preview.data.stages} />}
        </section>
      )}
    </div>
  );
}
