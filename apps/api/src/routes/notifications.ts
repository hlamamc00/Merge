import { Router } from 'express';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { UserRole } from '@merge/shared';
import { notifications } from '../db/schema.js';
import { requireAuth } from '../lib/auth.js';
import { auth, deps } from '../lib/context.js';
import { h } from '../lib/errors.js';
import { parseQuery, zQueryBool } from '../lib/validate.js';

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
