import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { NotificationPreferences } from '../api/types.onboarding';
import { Button, Card, Checkbox, ErrorBanner, Field, InfoBanner, Input, Loading, PageHeader, Select, Toggle } from '../components/ui';
import { humanise } from '../lib/format';

const EXPLAIN: Record<string, string> = {
  SHIFT_AVAILABLE: 'A shift has been released to your organisation',
  SHIFT_REQUEST: 'A supplier has put a worker forward for your shift',
  SHIFT_OFFER: 'A host has offered a shift to one of your workers',
  SHIFT_CONFIRMED: 'A booking has been confirmed',
  SHIFT_DECLINED: 'A request was declined or the shift filled',
  SHIFT_CANCELLED: 'A booking or shift was cancelled',
  SHIFT_UNFILLED: 'Your shift is still unfilled close to its start',
  TIMESHEET_SUBMITTED: 'A timesheet is waiting for your approval',
  TIMESHEET_APPROVED: 'A timesheet was approved',
  TIMESHEET_DISPUTED: 'A timesheet was disputed or rejected',
  DOCUMENT_EXPIRING: "A worker's document is about to expire",
  FLAG_FULFILLED: 'Your capacity flag has been fully matched',
  INVOICE_ISSUED: 'A statement has been issued',
  SYSTEM: 'Messages from the platform',
};

export function NotificationSettingsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notification-preferences'], queryFn: () => api.get<NotificationPreferences>('/notifications/preferences') });
  const [form, setForm] = useState<NotificationPreferences | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data && !form) setForm(q.data);
  }, [q.data, form]);
  if (q.isLoading || !form) return <Loading />;
  if (q.error) return <ErrorBanner error={q.error} />;

  const toggle = (list: 'emailImmediate' | 'smsImmediate', type: string) =>
    setForm({ ...form, [list]: form[list].includes(type as never) ? form[list].filter((t) => t !== type) : [...form[list], type as never] });

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await api.put<NotificationPreferences>('/notifications/preferences', {
        emailImmediate: form.emailImmediate,
        emailDigest: form.emailDigest,
        smsImmediate: form.smsImmediate,
        quietHoursStart: form.quietHoursStart,
        quietHoursEnd: form.quietHoursEnd,
        maxDistanceKm: form.maxDistanceKm,
        phone: form.phone,
      });
      setForm(res);
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ['notification-preferences'] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <div className="space-y-5">
      <PageHeader title="Notification settings" description={`How Merge reaches you at ${form.email}. Everything always appears in the bell inside the app; here you choose what also goes to your email or phone, and when.`} actions={<Button onClick={save} loading={busy}>Save</Button>} />
      <ErrorBanner error={error} />
      {saved && <InfoBanner tone="green">Saved.</InfoBanner>}
      {form.isDefault && <InfoBanner tone="blue">You are on the default settings: important events by email straight away, the rest in one daily digest.</InfoBanner>}
      <Card title="Email" description="Tick the events you want emailed as they happen. Anything unticked is collected into one daily digest (unless you turn the digest off). Urgent shifts are always sent straight away.">
        <div className="grid gap-2 sm:grid-cols-2">
          {form.types.map((t) => (
            <Checkbox key={t} label={humanise(t)} hint={EXPLAIN[t]} checked={form.emailImmediate.includes(t)} onChange={() => toggle('emailImmediate', t)} />
          ))}
        </div>
        <div className="mt-4">
          <Toggle checked={form.emailDigest} onChange={(v) => setForm({ ...form, emailDigest: v })} label="Send me a daily digest of everything else" />
        </div>
      </Card>
      <Card title="Quiet hours" description="Non-urgent emails and texts wait until your quiet hours end. Urgent shifts and cancellations still come through.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From">
            <Select value={form.quietHoursStart ?? ''} onChange={(e) => setForm({ ...form, quietHoursStart: e.target.value === '' ? null : Number(e.target.value) })}>
              <option value="">No quiet hours</option>
              {hours.map((h) => (
                <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
              ))}
            </Select>
          </Field>
          <Field label="Until">
            <Select value={form.quietHoursEnd ?? ''} onChange={(e) => setForm({ ...form, quietHoursEnd: e.target.value === '' ? null : Number(e.target.value) })}>
              <option value="">—</option>
              {hours.map((h) => (
                <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>
      <Card title="Text messages" description="Add a mobile number to receive texts for the events you tick. Urgent shifts are always texted if a number is set.">
        <Field label="Mobile number" className="max-w-xs">
          <Input value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value || null })} placeholder="07700 900123" />
        </Field>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {form.types.map((t) => (
            <Checkbox key={t} label={humanise(t)} checked={form.smsImmediate.includes(t)} onChange={() => toggle('smsImmediate', t)} disabled={!form.phone} />
          ))}
        </div>
      </Card>
      <Card title="Distance" description="Only hear about released shifts within a set distance of your home (applies to workers with a home postcode on file).">
        <Field label="Maximum distance (km)" className="max-w-xs">
          <Input type="number" min={1} max={500} value={form.maxDistanceKm ?? ''} onChange={(e) => setForm({ ...form, maxDistanceKm: e.target.value === '' ? null : Number(e.target.value) })} placeholder="No limit" />
        </Field>
      </Card>
    </div>
  );
}
