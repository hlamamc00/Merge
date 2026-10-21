import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type Tone = 'slate' | 'green' | 'amber' | 'red' | 'violet' | 'blue' | 'brand';

const toneClasses: Record<Tone, string> = {
  slate: 'bg-slate-100 text-slate-700 ring-slate-200',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-rose-50 text-rose-700 ring-rose-200',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
  blue: 'bg-sky-50 text-sky-700 ring-sky-200',
  brand: 'bg-brand-50 text-brand-700 ring-brand-200',
};

export function Badge({ tone = 'slate', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap', toneClasses[tone], className)}>{children}</span>;
}

export function StatCard({ label, value, hint, tone = 'slate', to }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone; to?: string }) {
  const body = (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cx('mt-1 text-2xl font-semibold', tone === 'slate' ? 'text-slate-900' : toneClasses[tone].split(' ')[1])}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
  return to ? <Link to={to} className="block hover:opacity-90">{body}</Link> : body;
}

export function Card({ title, actions, children, className, description }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; description?: ReactNode }) {
  return (
    <section className={cx('rounded-xl border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
            {description && <p className="text-xs text-slate-500">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';

const buttonClasses: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-300',
  secondary: 'bg-white text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50',
  danger: 'bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-300',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-300',
  ghost: 'text-slate-600 hover:bg-slate-100',
};

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  loading,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx('inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-70', size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm', buttonClasses[variant], className)}
    >
      {loading && <Spinner size={14} />}
      {children}
    </button>
  );
}

export function LinkButton({ to, variant = 'primary', size = 'md', className, children }: { to: string; variant?: ButtonVariant; size?: 'sm' | 'md'; className?: string; children: ReactNode }) {
  return (
    <Link to={to} className={cx('inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition', size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm', buttonClasses[variant], className)}>
      {children}
    </Link>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <svg className="animate-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
      <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="opacity-75" />
    </svg>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-slate-500">
      <Spinner /> {label}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center">
      <div className="text-sm font-medium text-slate-700">{title}</div>
      {description && <div className="mt-1 text-xs text-slate-500">{description}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorBanner({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const blockers = error instanceof ApiError ? error.blockers : [];
  const warnings = error instanceof ApiError ? error.warnings : [];
  return (
    <div className={cx('rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800', className)} role="alert">
      <div className="font-medium">{message}</div>
      {blockers.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {blockers.map((b) => (
            <li key={b.code}>{b.message}</li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs text-amber-800">
          {warnings.map((w) => (
            <li key={w.code}>Warning: {w.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function InfoBanner({ children, tone = 'blue', className }: { children: ReactNode; tone?: Tone; className?: string }) {
  const map: Record<Tone, string> = {
    slate: 'border-slate-200 bg-slate-50 text-slate-700',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    red: 'border-rose-200 bg-rose-50 text-rose-800',
    violet: 'border-violet-200 bg-violet-50 text-violet-800',
    blue: 'border-sky-200 bg-sky-50 text-sky-900',
    brand: 'border-brand-200 bg-brand-50 text-brand-800',
  };
  return <div className={cx('rounded-lg border px-3 py-2 text-sm', map[tone], className)}>{children}</div>;
}

export function Field({ label, hint, children, className, required }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string; required?: boolean }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-xs font-medium text-slate-600">
        {label}
        {required && <span className="text-rose-500"> *</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputClass = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50';

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputClass, props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(inputClass, props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(inputClass, 'min-h-[80px]', props.className)} />;
}

export function Checkbox({ label, hint, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex items-start gap-2 text-sm text-slate-700">
      <input type="checkbox" {...rest} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className="inline-flex items-center gap-2 text-sm text-slate-700 disabled:opacity-50">
      <span className={cx('relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition', checked ? 'bg-brand-600' : 'bg-slate-300')}>
        <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition', checked ? 'left-[18px]' : 'left-0.5')} />
      </span>
      {label}
    </button>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white shadow-xl sm:rounded-2xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')} role="dialog" aria-modal>
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close">
            ✕
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="h-full w-full max-w-2xl overflow-y-auto bg-white shadow-xl" role="dialog" aria-modal>
        <header className="sticky top-0 flex items-center justify-between border-b border-slate-100 bg-white px-5 py-3">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close">
            ✕
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  className?: string;
  align?: 'left' | 'right';
}

export function Table<T>({ rows, columns, rowKey, empty, onRowClick }: { rows: T[]; columns: Column<T>[]; rowKey: (row: T) => string; empty?: ReactNode; onRowClick?: (row: T) => void }) {
  if (rows.length === 0) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={cx('px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500', c.align === 'right' && 'text-right', c.className)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {rows.map((r) => (
            <tr key={rowKey(r)} className={cx(onRowClick && 'cursor-pointer hover:bg-slate-50')} onClick={() => onRowClick?.(r)}>
              {columns.map((c) => (
                <td key={c.key} className={cx('px-4 py-2.5 align-top text-slate-700', c.align === 'right' && 'text-right', c.className)}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { value: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          onClick={() => onChange(t.value)}
          className={cx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', value === t.value ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700')}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 text-xs text-slate-600">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Progress({ value, max, tone = 'brand' }: { value: number; max: number; tone?: Tone }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const bar: Record<Tone, string> = { slate: 'bg-slate-400', green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-rose-500', violet: 'bg-violet-500', blue: 'bg-sky-500', brand: 'bg-brand-500' };
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
      <div className={cx('h-full rounded-full', bar[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Chips({ items, max = 4 }: { items: string[]; max?: number }) {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((s) => (
        <Badge key={s}>{s}</Badge>
      ))}
      {rest > 0 && <Badge>+{rest}</Badge>}
    </span>
  );
}

export function DescriptionList({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {items.map((i) => (
        <div key={i.label} className="flex flex-col">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{i.label}</dt>
          <dd className="text-slate-800">{i.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
