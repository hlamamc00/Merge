import type { NotificationType } from '@merge/shared';
import type { Db } from '../db/client.js';
import { notifications } from '../db/schema.js';
import { newId } from './ids.js';

export interface OutboundNotification {
  orgId: string;
  userId?: string | null;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * A delivery channel (email, SMS, push, webhook…). The in-app inbox is always written;
 * channels are best-effort extras. Add real providers by implementing this interface.
 */
export interface NotificationChannel {
  name: string;
  send(n: OutboundNotification & { id: string; createdAt: Date }): Promise<void> | void;
}

export class Notifier {
  constructor(
    private readonly db: Db,
    private readonly channels: NotificationChannel[] = [],
    private readonly now: () => Date = () => new Date(),
  ) {}

  send(n: OutboundNotification): string {
    const id = newId('ntf');
    const createdAt = this.now();
    this.db
      .insert(notifications)
      .values({ id, orgId: n.orgId, userId: n.userId ?? null, type: n.type, title: n.title, body: n.body, data: n.data ?? null, readAt: null, createdAt })
      .run();
    for (const ch of this.channels) {
      Promise.resolve(ch.send({ ...n, id, createdAt })).catch((err) => console.error(`[notify:${ch.name}]`, err));
    }
    return id;
  }

  sendMany(list: OutboundNotification[]): void {
    for (const n of list) this.send(n);
  }
}

/** Development channel: prints notifications to the console. */
export const consoleChannel: NotificationChannel = {
  name: 'console',
  send(n) {
    console.log(`[notify] → org ${n.orgId}${n.userId ? ` user ${n.userId}` : ''}: ${n.title} — ${n.body}`);
  },
};
