/**
 * Delivery rules: which notifications leave the app, to whom, by which channel and when.
 *
 * Every notification is always written to the in-app inbox (lib/notify.ts). This module decides
 * whether it should also go out by email or SMS, now or in the daily digest, respecting each
 * user's preferences and quiet hours. Worker-facing copy is written for the worker.
 */
import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { JOB_ROLE_LABELS, NotificationType, UserRole, distanceKm, timeZoneOffsetMs, type NotificationType as NT } from '@merge/shared';
import type { Db } from '../db/client.js';
import { notificationPreferences, notifications, organisations, outboundMessages, shifts, sites, users, workers } from '../db/schema.js';
import { createChannels, drainOutbox as drain, enqueueEmail, enqueueSms, webUrl, type Channels } from './mail.js';

export interface DeliverableNotification {
  id: string;
  orgId: string;
  userId?: string | null;
  type: NT;
  title: string;
  body: string;
  data?: Record<string, unknown> | null;
  createdAt: Date;
}

/** Delivered by email as they happen unless the user says otherwise. */
export const DEFAULT_IMMEDIATE: NT[] = [
  NotificationType.SHIFT_OFFER,
  NotificationType.SHIFT_CONFIRMED,
  NotificationType.SHIFT_CANCELLED,
  NotificationType.SHIFT_UNFILLED,
  NotificationType.TIMESHEET_DISPUTED,
  NotificationType.SYSTEM,
  NotificationType.FLAG_FULFILLED,
];

/** Collected into one daily email. */
export const DEFAULT_DIGEST: NT[] = [
  NotificationType.SHIFT_AVAILABLE,
  NotificationType.SHIFT_REQUEST,
  NotificationType.SHIFT_DECLINED,
  NotificationType.TIMESHEET_SUBMITTED,
  NotificationType.TIMESHEET_APPROVED,
  NotificationType.DOCUMENT_EXPIRING,
  NotificationType.INVOICE_ISSUED,
];

export interface EffectivePreferences {
  emailImmediate: NT[];
  emailDigest: boolean;
  smsImmediate: NT[];
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  maxDistanceKm: number | null;
  isDefault: boolean;
}

export function effectivePreferences(db: Db, userId: string): EffectivePreferences {
  const row = db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId)).get();
  if (!row) return { emailImmediate: [...DEFAULT_IMMEDIATE], emailDigest: true, smsImmediate: [], quietHoursStart: null, quietHoursEnd: null, maxDistanceKm: null, isDefault: true };
  return { emailImmediate: row.emailImmediate as NT[], emailDigest: row.emailDigest, smsImmediate: row.smsImmediate as NT[], quietHoursStart: row.quietHoursStart, quietHoursEnd: row.quietHoursEnd, maxDistanceKm: row.maxDistanceKm, isDefault: false };
}

/** Local hour in Europe/London. */
function localHour(d: Date): number {
  return new Date(d.getTime() + timeZoneOffsetMs(d)).getUTCHours();
}

/** If `now` falls inside the user's quiet hours, the time those hours end; otherwise null. */
export function quietHoursEndsAt(now: Date, start: number | null, end: number | null): Date | null {
  if (start == null || end == null || start === end) return null;
  const hour = localHour(now);
  const inQuiet = start < end ? hour >= start && hour < end : hour >= start || hour < end;
  if (!inQuiet) return null;
  const local = new Date(now.getTime() + timeZoneOffsetMs(now));
  const release = new Date(local);
  release.setUTCMinutes(0, 0, 0);
  release.setUTCHours(end);
  if (release <= local) release.setUTCDate(release.getUTCDate() + 1);
  return new Date(release.getTime() - timeZoneOffsetMs(now));
}

interface ShiftContext {
  title: string;
  jobRole: string;
  startsAt: Date;
  endsAt: Date;
  siteName: string;
  siteAddress: string;
  hostName: string;
  accessNotes: string | null;
}

function shiftContext(db: Db, shiftId: string | undefined): ShiftContext | null {
  if (!shiftId) return null;
  const row = db
    .select({ shift: shifts, site: sites, hostName: organisations.name })
    .from(shifts)
    .innerJoin(sites, eq(sites.id, shifts.siteId))
    .innerJoin(organisations, eq(organisations.id, shifts.hostOrgId))
    .where(eq(shifts.id, shiftId))
    .get();
  if (!row) return null;
  return {
    title: row.shift.title,
    jobRole: JOB_ROLE_LABELS[row.shift.jobRole],
    startsAt: row.shift.startsAt,
    endsAt: row.shift.endsAt,
    siteName: row.site.name,
    siteAddress: [row.site.addressLine1, row.site.city, row.site.postcode].filter(Boolean).join(', '),
    hostName: row.hostName,
    accessNotes: row.site.accessNotes,
  };
}

const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
const when = (s: ShiftContext) => `${fmt.format(s.startsAt)} to ${fmtTime.format(s.endsAt)}`;

/** Subject and body for one recipient. Workers get copy written for them; managers get the inbox text plus a link. */
export function composeEmail(db: Db, n: DeliverableNotification, recipient: { firstName: string; role: UserRole }): { subject: string; body: string } {
  const base = webUrl();
  const data = (n.data ?? {}) as Record<string, unknown>;
  const shiftId = typeof data.shiftId === 'string' ? data.shiftId : undefined;
  const link = shiftId ? `${base}/shifts/${shiftId}` : typeof data.timesheetId === 'string' ? `${base}/timesheets` : typeof data.invoiceId === 'string' ? `${base}/statements` : `${base}/notifications`;
  const greeting = `Hi ${recipient.firstName},`;
  const s = shiftContext(db, shiftId);

  if (recipient.role === UserRole.WORKER && s) {
    switch (n.type) {
      case NotificationType.SHIFT_CONFIRMED:
        return {
          subject: `You're booked: ${s.jobRole} at ${s.siteName}, ${fmt.format(s.startsAt)}`,
          body: `${greeting}\n\nYou have been booked for a ${s.jobRole.toLowerCase()} shift at ${s.siteName} (${s.hostName}).\n\nWhen: ${when(s)}\nWhere: ${s.siteAddress}${s.accessNotes ? `\nOn arrival: ${s.accessNotes}` : ''}\n\nPlease arrive a few minutes early and clock in on the app when you get there.\n\nShift details: ${link}\n\nMerge`,
        };
      case NotificationType.SHIFT_OFFER:
        return {
          subject: `Shift offered to you: ${s.jobRole} at ${s.siteName}, ${fmt.format(s.startsAt)}`,
          body: `${greeting}\n\n${s.hostName} would like you for a ${s.jobRole.toLowerCase()} shift at ${s.siteName}.\n\nWhen: ${when(s)}\nWhere: ${s.siteAddress}\n\nAccept or decline in the app: ${link}\n\nMerge`,
        };
      case NotificationType.SHIFT_CANCELLED:
        return {
          subject: `Shift cancelled: ${s.siteName}, ${fmt.format(s.startsAt)}`,
          body: `${greeting}\n\nYour ${s.jobRole.toLowerCase()} shift at ${s.siteName} on ${when(s)} has been cancelled. You do not need to attend.\n\n${n.body}\n\nSee your shifts: ${base}/shifts/supplied\n\nMerge`,
        };
      case NotificationType.SHIFT_AVAILABLE:
        return {
          subject: `New shift you could take: ${s.jobRole} at ${s.siteName}, ${fmt.format(s.startsAt)}`,
          body: `${greeting}\n\nA ${s.jobRole.toLowerCase()} shift is open at ${s.siteName} (${s.hostName}), ${when(s)}.\n\nRequest it in the app: ${link}\n\nMerge`,
        };
      default:
        break;
    }
  }
  return { subject: n.title, body: `${greeting}\n\n${n.body}\n\nOpen in Merge: ${link}\n\nMerge` };
}

interface Recipient {
  id: string;
  firstName: string;
  role: UserRole;
  email: string;
  phone: string | null;
  workerId: string | null;
}

function recipientsFor(db: Db, n: DeliverableNotification): Recipient[] {
  const cols = { id: users.id, firstName: users.firstName, role: users.role, email: users.email, phone: users.phone, workerId: users.workerId };
  if (n.userId) {
    const u = db.select(cols).from(users).where(and(eq(users.id, n.userId), eq(users.status, 'ACTIVE'))).get();
    return u ? [u] : [];
  }
  return db
    .select(cols)
    .from(users)
    .where(and(eq(users.orgId, n.orgId), eq(users.status, 'ACTIVE'), inArray(users.role, [UserRole.PLATFORM_ADMIN, UserRole.ORG_ADMIN, UserRole.ORG_MANAGER])))
    .all();
}

/** Decide and enqueue outbound messages for a freshly created notification. Never throws. */
export function deliverNotification(db: Db, n: DeliverableNotification): void {
  try {
    const data = (n.data ?? {}) as Record<string, unknown>;
    const urgent = data.urgent === true;
    for (const r of recipientsFor(db, n)) {
      const prefs = effectivePreferences(db, r.id);
      // Too far from home: skip release notices the user asked not to hear about.
      if (n.type === NotificationType.SHIFT_AVAILABLE && prefs.maxDistanceKm != null && typeof data.siteLat === 'number' && typeof data.siteLng === 'number' && r.workerId) {
        const w = db.select({ lat: workers.lat, lng: workers.lng }).from(workers).where(eq(workers.id, r.workerId)).get();
        if (w?.lat != null && w.lng != null && distanceKm(w.lat, w.lng, data.siteLat, data.siteLng) > prefs.maxDistanceKm) continue;
      }
      const immediate = urgent || prefs.emailImmediate.includes(n.type);
      if (immediate) {
        const { subject, body } = composeEmail(db, n, r);
        const notBefore = urgent ? undefined : quietHoursEndsAt(n.createdAt, prefs.quietHoursStart, prefs.quietHoursEnd) ?? undefined;
        enqueueEmail(db, { to: r.email, subject, body, userId: r.id, orgId: n.orgId, notificationId: n.id, notBefore }, n.createdAt);
      }
      if (r.phone && (urgent || prefs.smsImmediate.includes(n.type))) {
        const { subject } = composeEmail(db, n, r);
        enqueueSms(db, { to: r.phone, body: `Merge: ${subject}`, userId: r.id, orgId: n.orgId, notificationId: n.id }, n.createdAt);
      }
      // Everything else waits for the digest, which reads the inbox directly.
    }
  } catch (err) {
    console.error('[delivery]', err);
  }
}

const DIGEST_SUBJECT = 'Daily digest';

/**
 * One email per user summarising unread digest-class notifications since their last digest
 * (or the last 24 hours when they have never had one). Returns the number of digests queued.
 */
export function runDigest(db: Db, now: Date): number {
  const recipients = db
    .select({ id: users.id, firstName: users.firstName, role: users.role, email: users.email, orgId: users.orgId })
    .from(users)
    .where(eq(users.status, 'ACTIVE'))
    .all();
  const base = webUrl();
  let queued = 0;
  for (const u of recipients) {
    const prefs = effectivePreferences(db, u.id);
    if (!prefs.emailDigest) continue;
    const digestTypes = DEFAULT_DIGEST.filter((t) => !prefs.emailImmediate.includes(t));
    if (digestTypes.length === 0) continue;
    const last = db
      .select({ createdAt: outboundMessages.createdAt })
      .from(outboundMessages)
      .where(and(eq(outboundMessages.userId, u.id), eq(outboundMessages.subject, DIGEST_SUBJECT)))
      .orderBy(desc(outboundMessages.createdAt))
      .get();
    const since = last?.createdAt ?? new Date(now.getTime() - 24 * 3_600_000);
    const visible = u.role === UserRole.WORKER ? and(eq(notifications.orgId, u.orgId), eq(notifications.userId, u.id)) : and(eq(notifications.orgId, u.orgId), or(isNull(notifications.userId), eq(notifications.userId, u.id)));
    const items = db
      .select()
      .from(notifications)
      .where(and(visible, isNull(notifications.readAt), gt(notifications.createdAt, since), inArray(notifications.type, digestTypes)))
      .orderBy(desc(notifications.createdAt))
      .all();
    if (items.length === 0) continue;
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.type, (counts.get(i.type) ?? 0) + 1);
    const summary = [...counts.entries()].map(([t, c]) => `${c} × ${t.toLowerCase().replace(/_/g, ' ')}`).join(', ');
    const lines = items.slice(0, 10).map((i) => `• ${i.title}`).join('\n');
    const body = `Hi ${u.firstName},\n\nSince your last digest: ${summary}.\n\n${lines}${items.length > 10 ? `\n…and ${items.length - 10} more.` : ''}\n\nSee everything: ${base}/notifications\nChange what you receive: ${base}/settings/notifications\n\nMerge`;
    enqueueEmail(db, { to: u.email, subject: DIGEST_SUBJECT, body, userId: u.id, orgId: u.orgId }, now);
    queued++;
  }
  return queued;
}

/** Send due messages using channels chosen from the environment. For the scheduler. */
export function drainOutbox(db: Db, now: Date, channels: Channels = createChannels()): Promise<{ sent: number; failed: number }> {
  return drain(db, now, channels);
}
