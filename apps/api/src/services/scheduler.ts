import { and, eq, gt, isNotNull, lt, lte } from 'drizzle-orm';
import { DOCUMENT_LABELS, NotificationType, addDays } from '@merge/shared';
import { config } from '../config.js';
import type { Db } from '../db/client.js';
import { notifications, workerDocuments, workers } from '../db/schema.js';
import type { Notifier } from '../lib/notify.js';
import { getStorage } from '../lib/storage.js';
import { remindOperatorOfPendingRequests } from './assignments.js';
import { expireFlags } from './capacity.js';
import { drainOutbox, runDigest } from './delivery.js';
import { notifyDueAccess } from './dispatch.js';
import { runEscalations } from './escalation.js';
import { createChannels, silentChannels, type Channels } from './mail.js';
import { getSettings } from './settings.js';
import { runFinanceJobs, type FinanceJobsResult } from './settlement.js';
import { progressShifts, warnUnfilledSoon } from './shifts.js';
import { autoApproveStaleTimesheets } from './timesheets.js';

export interface TickResult {
  stagesOpened: number;
  flagsExpired: number;
  shifts: { started: number; completed: number; expired: number };
  unfilledWarnings: number;
  documentAlerts: number;
  /** Decision 6: shifts escalated automatically, and hosts prompted to escalate manually. */
  escalations: { auto: number; prompted: number };
  /** Decision 7: pending requests the platform owner was asked to chase. */
  operatorReminders: number;
  /** Decision 1: invoices marked overdue, payment reminders, credit holds applied and released. */
  finance: FinanceJobsResult;
  /** Timesheets approved automatically after 14 days without a host decision. */
  autoApproved: number;
  /** Daily digest emails queued (once a day, after 07:00 UTC). */
  digests: number;
  /** Decision 18: superseded documents removed after the retention period. */
  documentsPurged: number;
}

/** Mail/SMS channels for the outbox: the environment's SMTP (or console) in production, silent under test. */
let outboxChannels: Channels | null = null;
export function setOutboxChannels(channels: Channels | null): void {
  outboxChannels = channels;
}
function channels(): Channels {
  return outboxChannels ?? (config.isTest ? silentChannels : createChannels());
}

/** Daily jobs run once per calendar day per database, whenever the first tick after 07:00 UTC happens. */
const lastDailyRun = new WeakMap<Db, string>();

/** One pass of the background jobs. Idempotent, so it is safe to run as often as you like. */
export function tick(db: Db, notifier: Notifier, now: Date): TickResult {
  const shiftsResult = progressShifts(db, notifier, now);
  const stagesOpened = notifyDueAccess(db, notifier, now);
  const flagsExpired = expireFlags(db, notifier, now);
  const settings = getSettings(db);
  const escalations = runEscalations(db, notifier, settings, now);
  const unfilledWarnings = warnUnfilledSoon(db, notifier, now);
  const operatorReminders = remindOperatorOfPendingRequests(db, notifier, settings, now);
  const documentAlerts = alertExpiringDocuments(db, notifier, now);
  const finance = runFinanceJobs(db, notifier, settings, now);
  const autoApproved = autoApproveStaleTimesheets(db, notifier, now).length;
  let digests = 0;
  let documentsPurged = 0;
  const day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() >= 7 && lastDailyRun.get(db) !== day) {
    lastDailyRun.set(db, day);
    digests = runDigest(db, now);
    documentsPurged = purgeSupersededDocuments(db, settings.documentRetentionYears, now);
  }
  // Emails and texts queued by everything above go out through the configured channels; failures are logged, not thrown.
  void drainOutbox(db, now, channels()).catch((err) => console.error('outbox delivery failed', err));
  return { stagesOpened, flagsExpired, shifts: shiftsResult, unfilledWarnings, documentAlerts, escalations, operatorReminders, finance, autoApproved, digests, documentsPurged };
}

/**
 * Decision 18: a corrected document is kept as history for the retention period, then removed
 * (row and file). Current documents are never touched here.
 */
export function purgeSupersededDocuments(db: Db, retentionYears: number, now: Date): number {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - Math.max(1, retentionYears));
  const stale = db.select({ id: workerDocuments.id, fileKey: workerDocuments.fileKey }).from(workerDocuments).where(and(isNotNull(workerDocuments.supersededAt), lt(workerDocuments.supersededAt, cutoff))).all();
  if (stale.length === 0) return 0;
  const storage = getStorage();
  for (const doc of stale) {
    db.delete(workerDocuments).where(eq(workerDocuments.id, doc.id)).run();
    if (doc.fileKey) void storage.delete(doc.fileKey).catch((err) => console.error(`could not delete file ${doc.fileKey}`, err));
  }
  return stale.length;
}

/**
 * Tell employers about documents expiring in the next 30 days (at most one alert per document per week).
 * CMP-02: a worker with a login is told too, in their own words, so they can renew without waiting for the office.
 */
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
    const label = DOCUMENT_LABELS[doc.type];
    notifier.send({
      orgId: worker.orgId,
      type: NotificationType.DOCUMENT_EXPIRING,
      title: `${label} expiring for ${worker.firstName} ${worker.lastName}`,
      body: days <= 0 ? 'Expires today. The worker cannot be sent on shifts after this date until renewed.' : `Expires in ${days} day(s). Shifts after that date will be blocked until the document is renewed and verified.`,
      data: { documentId: doc.id, workerId: worker.id },
    });
    // The weekly rule above covers this copy too: both are sent together and share the documentId.
    if (worker.userId) {
      notifier.send({
        orgId: worker.orgId,
        userId: worker.userId,
        type: NotificationType.DOCUMENT_EXPIRING,
        title: `Your ${label} ${days <= 0 ? 'expires today' : `expires in ${days} day(s)`}`,
        body: `Your ${label} ${days <= 0 ? 'expires today' : `expires in ${days} days`}. Upload the renewed certificate from My documents so you can keep taking shifts.`,
        data: { documentId: doc.id, workerId: worker.id },
      });
    }
    sent++;
  }
  return sent;
}

export function startScheduler(db: Db, notifier: Notifier, intervalSeconds: number, now: () => Date, log: (msg: string) => void): () => void {
  const run = () => {
    try {
      const r = tick(db, notifier, now());
      if (r.stagesOpened || r.flagsExpired || r.shifts.started || r.shifts.completed || r.shifts.expired || r.unfilledWarnings || r.documentAlerts || r.escalations.auto || r.escalations.prompted || r.operatorReminders || r.finance.markedOverdue || r.finance.reminders || r.finance.holdsApplied || r.finance.holdsCleared || r.autoApproved || r.digests || r.documentsPurged) {
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
