import { Link } from 'react-router-dom';
import { JOB_ROLE_LABELS } from '@merge/shared';
import type { AvailableShift } from '../api/types';
import { fmtMoney, fmtShiftWindow } from '../lib/format';
import { Countdown } from './Countdown';
import { StatusBadge, TierBadge, UrgentBadge, skillLabel } from './badges';
import { Badge, cx } from './ui';

export function ShiftCard({ shift, compact }: { shift: AvailableShift; compact?: boolean }) {
  const mine = shift.myAssignments?.[0];
  return (
    <Link to={`/shifts/${shift.id}`} className={cx('block rounded-xl border bg-white p-4 shadow-sm transition hover:border-brand-300 hover:shadow', shift.access.open ? 'border-slate-200' : 'border-dashed border-slate-300 opacity-90')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <TierBadge tier={shift.access.tier} />
            <UrgentBadge urgent={shift.urgent} />
            {shift.autoConfirm && <Badge tone="green">Instant book</Badge>}
            {mine && <StatusBadge status={mine.status} />}
          </div>
          <h3 className="mt-1.5 truncate text-sm font-semibold text-slate-900">{shift.title}</h3>
          <div className="text-xs text-slate-500">
            {JOB_ROLE_LABELS[shift.jobRole]} · {shift.hostName} · {shift.site.name} ({shift.site.postcode})
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold text-slate-900">{fmtMoney(shift.chargeRate)}<span className="text-xs font-normal text-slate-500">/h</span></div>
          <div className="text-xs text-slate-500">{shift.placesLeft} place{shift.placesLeft === 1 ? '' : 's'} left</div>
        </div>
      </div>
      <div className="mt-2 text-sm text-slate-700">{fmtShiftWindow(shift.startsAt, shift.endsAt, shift.breakMinutes)}</div>
      {!compact && shift.requiredSkills.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {shift.requiredSkills.map((s) => (
            <Badge key={s}>{skillLabel(s)}</Badge>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center justify-between text-xs">
        {shift.access.opensAt ? <Countdown to={shift.access.opensAt} /> : <span />}
        {!compact && shift.access.reason && <span className="truncate text-slate-400" title={shift.access.reason}>{shift.access.reason}</span>}
      </div>
    </Link>
  );
}
