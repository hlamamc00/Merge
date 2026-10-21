import { useEffect, useState } from 'react';
import { fmtDateTime, fmtDuration } from '../lib/format';

/** "Open now" or "Opens in 1h 12m" (ticking), with the absolute time as a tooltip. */
export function Countdown({ to, prefix = 'Opens' }: { to: string | Date; prefix?: string }) {
  const target = new Date(to).getTime();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const diff = target - now;
  if (diff <= 0) return <span className="font-medium text-emerald-700" title={fmtDateTime(to)}>Open now</span>;
  return (
    <span className="text-slate-600" title={fmtDateTime(to)}>
      {prefix} in {fmtDuration(diff)}
    </span>
  );
}
