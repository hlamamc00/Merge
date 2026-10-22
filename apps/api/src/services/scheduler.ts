import { and, eq, gt, isNotNull, lte } from 'drizzle-orm';
import { DOCUMENT_LABELS, NotificationType, addDays } from '@merge/shared';
import type { Db } from '../db/client.js';
import { notifications, workerDocuments, workers } from '../db/schema.js';
import type { Notifier } from '../lib/notify.js';
import { expireFlags } from './capacity.js';
import { notifyDueAccess } from './dispatch.js';
import { progressShifts, warnUnfilledSoon } from './shifts.js';

export interface TickResult {
  stagesOpened: number;
  flagsExpired: number;
  shifts: { started: number; completed: number; expired: number };
  unfilledWarnings: number;
  documentAlerts: number;
}

/** One pass of the background jobs. Idempotent, so it is safe to run as often as you like. */
export function tick(db: Db, notifier: Notifier, now: Date): TickResult {
  const shiftsResult = progressShifts(db, notifier, now);
  const stagesOpened = notifyDueAccess(db, notifier, now);
  const flagsExpired = expireFlags(db, now);
  const unfilledWarnings = warnUnfilledSoon(db, notifier, now);
  const documentAlerts = alertExpiringDocuments(db, notifier, now);
  return { stagesOpened, flagsExpired, shifts: shiftsResult, unfilledWarnings, documentAlerts };
}

/** Tell employers about documents expiring in the next 30 days (at most one alert per document per week). */
export function alertExpiringDocuments(db: Db, notifier: Notifier, now: Date, horizonDays = 30): number {
  const horizon = addDays(now, horizonDays);
  const expiring = db
    .select({ doc: workerDocuments, worker: workers })
    .from(workerDocuments)
    .innerJoin(workers, eq(workers.id, workerDocuments.workerId))
    .where(and(isNotNull(workerDocuments.expiresAt), lte(workerDocuments.expiresAt, horizon), gt(workerDocuments.expiresAt, addDays(now, -1)), eq(workers.status, 'ACTIVE')))
    .all();
  let sent = 0;
  const weekAgo = addDays(now, -7);
  for (const { doc, worker } of expiring) {
    const renewed = db
      .select({ id: workerDocuments.id })
      .from(workerDocuments)
      .where(and(eq(workerDocuments.workerId, doc.workerId), eq(workerDocuments.type, doc.type), isNotNull(workerDocuments.verifiedAt), gt(workerDocuments.expiresAt, doc.expiresAt!)))
      .get();
    if (renewed) continue; // superseded by a newer verified document
    const recent = db
      .select({ data: notifications.data, createdAt: notifications.createdAt })
      .from(notifications)
      .where(and(eq(notifications.orgId, worker.orgId), eq(notifications.type, NotificationType.DOCUMENT_EXPIRING), gt(notifications.createdAt, weekAgo)))
      .all()
      .some((n) => (n.data as { documentId?: string } | null)?.documentId === doc.id);
    if (recent) continue;
    const days = Math.ceil((doc.expiresAt!.getTime() - now.getTime()) / 86_400_000);
    notifier.send({
      orgId: worker.orgId,
      type: NotificationType.DOCUMENT_EXPIRING,
      title: `${DOCUMENT_LABELS[doc.type]} expiring for ${worker.firstName} ${worker.lastName}`,
      body: days <= 0 ? 'Expires today. The worker cannot be sent on shifts after this date until renewed.' : `Expires in ${days} day(s). Shifts after that date will be blocked until the document is renewed and verified.`,
      data: { documentId: doc.id, workerId: worker.id },
    });
    sent++;
  }
  return sent;
}

export function startScheduler(db: Db, notifier: Notifier, intervalSeconds: number, now: () => Date, log: (msg: string) => void): () => void {
  const run = () => {
    try {
      const r = tick(db, notifier, now());
      if (r.stagesOpened || r.flagsExpired || r.shifts.started || r.shifts.completed || r.shifts.expired || r.unfilledWarnings || r.documentAlerts) {
        log(`scheduler: ${JSON.stringify(r)}`);
      }
    } catch (err) {
      console.error('scheduler tick failed', err);
    }
  };
  run();
  const handle = setInterval(run, Math.max(5, intervalSeconds) * 1000);
  return () => clearInterval(handle);
}
