const TZ = 'Europe/London';

const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ });
const dateOnlyFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ });
const longFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });

export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  return dateOnlyFmt.format(new Date(d));
}

export function fmtLongDate(d: string | Date): string {
  return longFmt.format(new Date(d));
}

export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return '—';
  return dateTimeFmt.format(new Date(d));
}

export function fmtTime(d: string | Date): string {
  return timeFmt.format(new Date(d));
}

export function hoursBetween(a: string | Date, b: string | Date): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;
}

/** "Thu 5 Nov, 07:00–19:00 (12h)" */
export function fmtShiftWindow(startsAt: string | Date, endsAt: string | Date, breakMinutes = 0): string {
  const s = new Date(startsAt);
  const e = new Date(endsAt);
  const h = Math.round((hoursBetween(s, e) - breakMinutes / 60) * 10) / 10;
  return `${dayFmt.format(s)}, ${timeFmt.format(s)}–${timeFmt.format(e)} (${h}h)`;
}

export function fmtMoney(n: number | null | undefined, currency = 'GBP'): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(n);
}

export function fmtHours(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${Math.round(n * 10) / 10}h`;
}

/** "1h 12m", "3d 2h", "45m" */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtRelative(d: string | Date): string {
  const diff = new Date(d).getTime() - Date.now();
  const abs = Math.abs(diff);
  if (abs < 60_000) return 'just now';
  const s = fmtDuration(abs);
  return diff < 0 ? `${s} ago` : `in ${s}`;
}

export function humanise(code: string | null | undefined): string {
  if (!code) return '—';
  const s = code.toLowerCase().replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Value for an <input type="datetime-local"> in local time. */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): string {
  return new Date(v).toISOString();
}

export function toDateInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
