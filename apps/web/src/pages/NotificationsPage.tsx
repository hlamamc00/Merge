import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { notificationLink, useNotifications } from '../components/Layout';
import { Button, Card, EmptyState, Loading, PageHeader, cx } from '../components/ui';
import { fmtDateTime, humanise } from '../lib/format';

export function NotificationsPage() {
  const q = useNotifications(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const markRead = useMutation({ mutationFn: (id: string) => api.post(`/notifications/${id}/read`), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const markAll = useMutation({ mutationFn: () => api.post('/notifications/read-all'), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  return (
    <div className="space-y-5">
      <PageHeader
        title="Notifications"
        description={<span>{q.data?.unread ?? 0} unread · <Link to="/settings/notifications" className="font-medium text-brand-700 hover:underline">Choose what reaches your email or phone</Link></span>}
        actions={<Button variant="secondary" onClick={() => markAll.mutate()} loading={markAll.isPending}>Mark all read</Button>}
      />
      <Card>
        {q.isLoading ? <Loading /> : (q.data?.notifications ?? []).length === 0 ? <EmptyState title="No notifications yet" /> : (
          <ul className="divide-y divide-slate-100">
            {(q.data?.notifications ?? []).map((n) => {
              const link = notificationLink(n);
              return (
                <li key={n.id} className={cx('flex items-start justify-between gap-3 py-3', !n.readAt && 'bg-brand-50/30 -mx-4 px-4')}>
                  <div className="min-w-0">
                    <div className="text-xs uppercase tracking-wide text-slate-400">{humanise(n.type)}</div>
                    <div className="text-sm font-medium text-slate-900">{n.title}</div>
                    <div className="text-sm text-slate-600">{n.body}</div>
                    <div className="mt-0.5 text-xs text-slate-400">{fmtDateTime(n.createdAt)}</div>
                  </div>
                  <div className="flex flex-shrink-0 flex-col gap-1">
                    {link && <Button size="sm" variant="secondary" onClick={() => { if (!n.readAt) markRead.mutate(n.id); navigate(link); }}>Open</Button>}
                    {!n.readAt && <Button size="sm" variant="ghost" onClick={() => markRead.mutate(n.id)}>Mark read</Button>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
