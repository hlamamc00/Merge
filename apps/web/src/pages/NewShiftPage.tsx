import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { DOCUMENT_LABELS, DocumentType, JOB_ROLE_LABELS, JobRole, SKILL_LABELS, ShiftVisibility, Skill } from '@merge/shared';
import { api } from '../api/client';
import { useAction, useSites } from '../api/hooks';
import type { DispatchPreview, Shift } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Button, Card, Checkbox, ErrorBanner, Field, InfoBanner, Input, LinkButton, Loading, PageHeader, Select, Textarea } from '../components/ui';
import { fmtDuration, fromLocalInput, toLocalInput } from '../lib/format';
import { ReleasePlan } from './ShiftDetailPage';

const VISIBILITY_HELP: Record<ShiftVisibility, string> = {
  NETWORK: 'Staged release: organisations with a matching surplus flag (and preferred partners) first, then the agency bank, then the whole network.',
  PRIORITY_ONLY: 'Only organisations with a matching surplus flag or preferred-partner status, plus the agency bank. Never opens to the wider network.',
  PREFERRED_ONLY: 'Only your preferred partners.',
  AGENCY_ONLY: "Only the platform agency's own bank.",
};

export function NewShiftPage() {
  const { organisation, me } = useAuth();
  const navigate = useNavigate();
  const sites = useSites(organisation?.id);
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
    chargeRate: organisation?.defaultChargeRate ? String(organisation.defaultChargeRate) : '18',
    visibility: 'NETWORK' as ShiftVisibility,
    priorityWindowMinutesOverride: '',
    autoConfirm: false,
  });
  const [draft, setDraft] = useState<Shift | null>(null);

  const siteId = form.siteId || sites.data?.[0]?.id || '';

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
    chargeRate: Number(form.chargeRate),
    visibility: form.visibility,
    priorityWindowMinutesOverride: form.priorityWindowMinutesOverride === '' ? null : Number(form.priorityWindowMinutesOverride),
    autoConfirm: form.autoConfirm,
    publish: false,
  });

  const saveDraft = useAction(async () => {
    if (draft) return api.patch<Shift>(`/shifts/${draft.id}`, { ...payload(), publish: undefined });
    return api.post<Shift>('/shifts', payload());
  }, (s) => setDraft(s));
  const publish = useAction(async () => {
    const d = draft ?? (await api.post<Shift>('/shifts', payload()));
    return api.post<Shift>(`/shifts/${d.id}/publish`);
  }, (s) => navigate(`/shifts/${s.id}`));
  const preview = useQuery({ queryKey: ['dispatch-preview', draft?.id, draft], queryFn: () => api.get<DispatchPreview>(`/shifts/${draft!.id}/dispatch-preview`), enabled: !!draft });

  const onPreview = (e: FormEvent) => {
    e.preventDefault();
    saveDraft.mutate();
  };

  const toggle = <T extends string>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const hours = (new Date(form.endsAt).getTime() - new Date(form.startsAt).getTime()) / 3_600_000 - Number(form.breakMinutes || 0) / 60;
  const leadMs = new Date(form.startsAt).getTime() - Date.now();
  const urgent = leadMs <= (me?.platform.urgentThresholdMinutes ?? 720) * 60_000;

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
              <Field label="Starts" required>
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
              {urgent && <span className="ml-2 font-medium text-rose-600">Starts within the urgent window: all tiers will open immediately.</span>}
            </div>
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
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Rate & release">
            <div className="space-y-3">
              <Field label="Charge rate (£ per hour)" required hint={`You pay this; the platform keeps ${me?.platform.platformFeePct ?? 8}% and the supplying organisation receives the rest.`}>
                <Input type="number" step="0.25" min="1" value={form.chargeRate} onChange={(e) => setForm({ ...form, chargeRate: e.target.value })} required />
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
              <Button type="submit" variant="secondary" loading={saveDraft.isPending}>{draft ? 'Update draft & preview' : 'Save draft & preview release plan'}</Button>
              <Button type="button" onClick={() => publish.mutate()} loading={publish.isPending} disabled={!siteId || !form.title}>Publish now</Button>
              {draft && <span className="text-center text-xs text-slate-500">Draft saved. Publishing releases it to the plan below.</span>}
            </div>
          </Card>
        </div>
      </form>

      {draft && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Who will see this and when</h2>
          {preview.isLoading || !preview.data ? <Loading /> : <ReleasePlan entries={preview.data.entries} urgent={preview.data.urgent} excluded={preview.data.excluded} stages={preview.data.stages} />}
        </section>
      )}
    </div>
  );
}
