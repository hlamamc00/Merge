import { Router } from 'express';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { NotificationType, UserRole } from '@merge/shared';
import { notificationPreferences, notifications, users } from '../db/schema.js';
import { requireAuth } from '../lib/auth.js';
import { auth, deps } from '../lib/context.js';
import { h } from '../lib/errors.js';
import { parseBody, parseQuery, zQueryBool } from '../lib/validate.js';
import { DEFAULT_DIGEST, DEFAULT_IMMEDIATE, effectivePreferences } from '../services/delivery.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

function visibleTo(req: Parameters<typeof deps>[0]) {
  const { org, user } = auth(req);
  // Managers see organisation-wide notifications plus their own; workers only their own.
  return user.role === UserRole.WORKER ? and(eq(notifications.orgId, org.id), eq(notifications.userId, user.id)) : and(eq(notifications.orgId, org.id), or(isNull(notifications.userId), eq(notifications.userId, user.id)));
}

notificationsRouter.get(
  '/',
  h((req, res) => {
    const { db } = deps(req);
    const q = parseQuery(req, z.object({ unread: zQueryBool, limit: z.coerce.number().int().min(1).max(200).default(50) }));
    const rows = db
      .select()
      .from(notifications)
      .where(and(visibleTo(req), q.unread ? isNull(notifications.readAt) : undefined))
      .orderBy(desc(notifications.createdAt))
      .limit(q.limit)
      .all();
    const unread = db.select({ id: notifications.id }).from(notifications).where(and(visibleTo(req), isNull(notifications.readAt))).all().length;
    res.json({ unread, notifications: rows });
  }),
);

notificationsRouter.post(
  '/read-all',
  h((req, res) => {
    const { db, now } = deps(req);
    db.update(notifications).set({ readAt: now() }).where(and(visibleTo(req), isNull(notifications.readAt))).run();
    res.json({ ok: true });
  }),
);

notificationsRouter.post(
  '/:id/read',
  h((req, res) => {
    const { db, now } = deps(req);
    db.update(notifications).set({ readAt: now() }).where(and(eq(notifications.id, req.params.id!), visibleTo(req))).run();
    res.json({ ok: true });
  }),
);

// ---------- delivery preferences ----------

const ALL_TYPES = Object.values(NotificationType);

notificationsRouter.get(
  '/preferences',
  h((req, res) => {
    const { db } = deps(req);
    const { user } = auth(req);
    const prefs = effectivePreferences(db, user.id);
    res.json({ ...prefs, phone: user.phone, email: user.email, defaults: { immediate: DEFAULT_IMMEDIATE, digest: DEFAULT_DIGEST }, types: ALL_TYPES });
  }),
);

notificationsRouter.put(
  '/preferences',
  h((req, res) => {
    const { db, now } = deps(req);
    const { user } = auth(req);
    const body = parseBody(
      req,
      z.object({
        emailImmediate: z.array(z.nativeEnum(NotificationType)).optional(),
        emailDigest: z.boolean().optional(),
        smsImmediate: z.array(z.nativeEnum(NotificationType)).optional(),
        quietHoursStart: z.number().int().min(0).max(23).nullable().optional(),
        quietHoursEnd: z.number().int().min(0).max(23).nullable().optional(),
        maxDistanceKm: z.number().min(1).max(500).nullable().optional(),
        phone: z.string().trim().max(30).nullable().optional(),
      }),
    );
    const at = now();
    const current = effectivePreferences(db, user.id);
    const next = {
      emailImmediate: body.emailImmediate ?? current.emailImmediate,
      emailDigest: body.emailDigest ?? current.emailDigest,
      smsImmediate: body.smsImmediate ?? current.smsImmediate,
      quietHoursStart: body.quietHoursStart === undefined ? current.quietHoursStart : body.quietHoursStart,
      quietHoursEnd: body.quietHoursEnd === undefined ? current.quietHoursEnd : body.quietHoursEnd,
      maxDistanceKm: body.maxDistanceKm === undefined ? current.maxDistanceKm : body.maxDistanceKm,
      updatedAt: at,
    };
    db.insert(notificationPreferences).values({ userId: user.id, ...next }).onConflictDoUpdate({ target: notificationPreferences.userId, set: next }).run();
    if (body.phone !== undefined) db.update(users).set({ phone: body.phone }).where(eq(users.id, user.id)).run();
    res.json({ ...effectivePreferences(db, user.id), phone: body.phone === undefined ? user.phone : body.phone, email: user.email, defaults: { immediate: DEFAULT_IMMEDIATE, digest: DEFAULT_DIGEST }, types: ALL_TYPES });
  }),
);
