import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Notification } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { fmtRelative, humanise } from '../lib/format';
import { Badge, cx } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  show: boolean;
  end?: boolean;
}

export function Layout() {
  const { me, isManager, isAdmin, isPlatformAdmin, isWorker, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  if (!me) return null;

  const nav: NavItem[] = [
    { to: '/', label: 'Dashboard', icon: '▦', show: true, end: true },
    { to: '/shifts', label: 'Shift board', icon: '◫', show: true },
    { to: '/shifts/new', label: 'Post a shift', icon: '＋', show: isManager },
    { to: '/shifts/posted', label: 'Posted shifts', icon: '▤', show: isManager },
    { to: '/shifts/supplied', label: isWorker ? 'My shifts' : 'Shifts we cover', icon: '▥', show: true },
    { to: '/capacity', label: 'Capacity flags', icon: '⚑', show: isManager },
    { to: '/workers', label: 'Workers', icon: '☺', show: isManager },
    { to: '/timesheets', label: 'Timesheets', icon: '◷', show: true },
    { to: '/statements', label: 'Statements', icon: '£', show: isAdmin },
    { to: '/network', label: 'Network', icon: '⬡', show: isManager },
    { to: '/settings', label: 'Settings', icon: '⚙', show: isManager },
    { to: '/admin', label: 'Platform admin', icon: '◈', show: isPlatformAdmin },
  ];

  const roleLabel = humanise(me.user.role);

  return (
    <div className="flex min-h-full">
      {/* Sidebar */}
      <aside className={cx('fixed inset-y-0 left-0 z-40 w-64 transform border-r border-slate-200 bg-white transition-transform lg:static lg:translate-x-0', open ? 'translate-x-0' : '-translate-x-full')}>
        <div className="flex h-14 items-center gap-2 border-b border-slate-100 px-4">
          <Link to="/" className="flex items-center gap-2" onClick={() => setOpen(false)}>
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">M</span>
            <span className="text-base font-semibold tracking-tight text-slate-900">{me.platform.name || 'Merge'}</span>
          </Link>
        </div>
        <nav className="space-y-0.5 p-3">
          {nav
            .filter((n) => n.show)
            .map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                onClick={() => setOpen(false)}
                className={({ isActive }) => cx('flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium', isActive ? 'bg-brand-50 text-brand-800' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900')}
              >
                <span className="w-4 text-center text-slate-400">{n.icon}</span>
                {n.label}
              </NavLink>
            ))}
        </nav>
        <div className="absolute inset-x-0 bottom-0 border-t border-slate-100 p-3 text-xs text-slate-500">
          <div className="font-medium text-slate-700">{me.organisation.name}</div>
          <div>{me.organisation.type === 'AGENCY' ? 'Platform agency' : 'Care provider'}</div>
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-slate-900/30 lg:hidden" onClick={() => setOpen(false)} />}

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur">
          <div className="flex items-center gap-3">
            <button type="button" className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
              ☰
            </button>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-900">{me.organisation.name}</div>
              <div className="flex items-center gap-1.5 text-xs text-slate-500">
                <Badge tone={isPlatformAdmin ? 'violet' : isWorker ? 'blue' : 'brand'}>{roleLabel}</Badge>
                <span className="hidden sm:inline">
                  {me.user.firstName} {me.user.lastName}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <NotificationBell />
            <button
              type="button"
              onClick={() => {
                logout();
                navigate('/login');
              }}
              className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5 sm:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function useNotifications(unreadOnly = false) {
  return useQuery({
    queryKey: ['notifications', unreadOnly],
    queryFn: () => api.get<{ unread: number; notifications: Notification[] }>('/notifications', { unread: unreadOnly, limit: 50 }),
    refetchInterval: 30_000,
  });
}

export function notificationLink(n: Notification): string | null {
  const d = n.data ?? {};
  if (typeof d.shiftId === 'string') return `/shifts/${d.shiftId}`;
  if (typeof d.timesheetId === 'string') return '/timesheets';
  if (typeof d.invoiceId === 'string') return '/statements';
  if (typeof d.workerId === 'string') return `/workers/${d.workerId}`;
  if (typeof d.flagId === 'string') return '/capacity';
  return null;
}

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { data } = useNotifications(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const markAll = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const unread = data?.unread ?? 0;
  const items = (data?.notifications ?? []).slice(0, 8);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className="relative rounded-lg p-2 text-slate-600 hover:bg-slate-100" aria-label="Notifications">
        <span className="text-lg leading-none">🔔</span>
        {unread > 0 && <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-rose-600 px-1 text-[10px] font-bold text-white">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-1 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg sm:w-96">
            <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
              <span className="text-sm font-semibold">Notifications</span>
              <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => markAll.mutate()}>
                Mark all read
              </button>
            </div>
            <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
              {items.length === 0 && <li className="px-3 py-6 text-center text-xs text-slate-500">No notifications yet</li>}
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={cx('w-full px-3 py-2 text-left hover:bg-slate-50', !n.readAt && 'bg-brand-50/40')}
                    onClick={() => {
                      if (!n.readAt) markRead.mutate(n.id);
                      setOpen(false);
                      const link = notificationLink(n);
                      if (link) navigate(link);
                    }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-sm font-medium text-slate-900">{n.title}</div>
                      {!n.readAt && <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-brand-600" />}
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-xs text-slate-600">{n.body}</div>
                    <div className="mt-0.5 text-[11px] text-slate-400">{fmtRelative(n.createdAt)}</div>
                  </button>
                </li>
              ))}
            </ul>
            <div className="border-t border-slate-100 px-3 py-2 text-center">
              <Link to="/notifications" className="text-xs font-medium text-brand-700 hover:underline" onClick={() => setOpen(false)}>
                View all
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function Page({ children }: { children: ReactNode }) {
  return <div className="space-y-5">{children}</div>;
}
