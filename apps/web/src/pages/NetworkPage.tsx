import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import { useAction } from '../api/hooks';
import type { DirectoryOrg, Relationship } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { StatusBadge } from '../components/badges';
import { Badge, Button, Card, ErrorBanner, Field, InfoBanner, Input, Loading, Modal, PageHeader, Table } from '../components/ui';
import { humanise } from '../lib/format';

export function NetworkPage() {
  const { organisation, isAdmin, isPlatformAdmin } = useAuth();
  const orgs = useQuery({ queryKey: ['organisations'], queryFn: () => api.get<DirectoryOrg[]>('/organisations') });
  const rels = useQuery({ queryKey: ['relationships', organisation?.id], queryFn: () => api.get<Relationship[]>(`/organisations/${organisation!.id}/relationships`), enabled: !!organisation });
  const [noteFor, setNoteFor] = useState<{ org: DirectoryOrg; kind: 'PREFERRED' | 'BLOCKED' } | null>(null);
  const [note, setNote] = useState('');
  const set = useAction((args: { otherOrgId: string; kind: 'PREFERRED' | 'BLOCKED' }) => api.put(`/organisations/${organisation!.id}/relationships/${args.otherOrgId}`, { kind: args.kind, note: note || null }), () => { setNoteFor(null); setNote(''); });
  const clear = useAction((otherOrgId: string) => api.delete(`/organisations/${organisation!.id}/relationships/${otherOrgId}`));
  const relOf = (id: string) => rels.data?.find((r) => r.otherOrgId === id);
  return (
    <div className="space-y-5">
      <PageHeader title="Network" description="Every organisation on the exchange. Mark preferred partners to give them priority access to your shifts, or block organisations you do not want to trade with." />
      <InfoBanner tone="brand">Preferred partners are released your shifts in the priority tier (alongside surplus-flagged organisations). Blocked organisations never see your shifts and you never see theirs.</InfoBanner>
      <Card>
        <ErrorBanner error={orgs.error ?? set.error ?? clear.error} className="mb-3" />
        {orgs.isLoading || rels.isLoading ? <Loading /> : (
          <Table
            rows={(orgs.data ?? []).filter((o) => o.id !== organisation?.id)}
            rowKey={(o) => o.id}
            columns={[
              { key: 'name', header: 'Organisation', render: (o) => <div className="font-medium text-slate-900">{o.name}<div className="text-xs font-normal text-slate-500">{[o.city, o.postcode].filter(Boolean).join(' · ')}</div></div> },
              { key: 'type', header: 'Type', render: (o) => <Badge tone={o.type === 'AGENCY' ? 'violet' : 'slate'}>{o.type === 'AGENCY' ? 'Platform agency' : 'Care provider'}</Badge> },
              { key: 'services', header: 'Services', render: (o) => <span className="text-xs text-slate-600">{o.serviceTypes.map(humanise).join(', ') || '—'}</span> },
              ...(isPlatformAdmin ? [{ key: 'status', header: 'Status', render: (o: DirectoryOrg) => <StatusBadge status={o.status} /> }] : []),
              { key: 'rel', header: 'Relationship', render: (o) => { const r = relOf(o.id); return r ? <span><Badge tone={r.kind === 'PREFERRED' ? 'brand' : 'red'}>{r.kind === 'PREFERRED' ? '★ Preferred' : '⛔ Blocked'}</Badge>{r.note && <div className="mt-0.5 text-xs text-slate-500">{r.note}</div>}</span> : <span className="text-xs text-slate-400">—</span>; } },
              { key: 'actions', header: '', align: 'right', render: (o) => isAdmin && (
                <span className="flex justify-end gap-1">
                  {relOf(o.id)?.kind !== 'PREFERRED' && <Button size="sm" variant="secondary" onClick={() => setNoteFor({ org: o, kind: 'PREFERRED' })}>Prefer</Button>}
                  {relOf(o.id)?.kind !== 'BLOCKED' && <Button size="sm" variant="ghost" onClick={() => setNoteFor({ org: o, kind: 'BLOCKED' })}>Block</Button>}
                  {relOf(o.id) && <Button size="sm" variant="ghost" onClick={() => clear.mutate(o.id)} loading={clear.isPending}>Clear</Button>}
                </span>
              ) },
            ]}
          />
        )}
      </Card>
      <Modal open={!!noteFor} onClose={() => setNoteFor(null)} title={noteFor ? `${noteFor.kind === 'PREFERRED' ? 'Prefer' : 'Block'} ${noteFor.org.name}` : ''} footer={<><Button variant="secondary" onClick={() => setNoteFor(null)}>Cancel</Button><Button variant={noteFor?.kind === 'BLOCKED' ? 'danger' : 'primary'} onClick={() => noteFor && set.mutate({ otherOrgId: noteFor.org.id, kind: noteFor.kind })} loading={set.isPending}>Confirm</Button></>}>
        <Field label="Note (private to your organisation)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Modal>
    </div>
  );
}
