import type { Request } from 'express';
import type { AuditAction } from '@merge/shared';
import type { Db } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import { newId } from './ids.js';

export interface AuditEntry {
  action: AuditAction;
  entityType: string;
  entityId: string;
  data?: Record<string, unknown>;
}

export function audit(db: Db, actor: { userId?: string | null; orgId?: string | null }, entry: AuditEntry, at: Date): void {
  db.insert(auditLog)
    .values({
      id: newId('aud'),
      actorUserId: actor.userId ?? null,
      actorOrgId: actor.orgId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      data: entry.data ?? null,
      createdAt: at,
    })
    .run();
}

export function auditFromReq(req: Request, db: Db, entry: AuditEntry, at: Date): void {
  audit(db, { userId: req.auth?.user.id, orgId: req.auth?.org.id }, entry, at);
}
