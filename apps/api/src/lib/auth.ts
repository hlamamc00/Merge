import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole } from '@merge/shared';
import { config } from '../config.js';
import { organisations, platformSettings, users, workers } from '../db/schema.js';
import { deps } from './context.js';
import { forbidden, unauthorized } from './errors.js';

export interface TokenPayload {
  sub: string;
  orgId: string;
  role: UserRole;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn } as jwt.SignOptions);
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, config.jwtSecret) as TokenPayload;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(unauthorized());
  let payload: TokenPayload;
  try {
    payload = verifyToken(header.slice(7));
  } catch {
    return next(unauthorized('Invalid or expired token'));
  }
  const { db } = deps(req);
  const user = db.select().from(users).where(eq(users.id, payload.sub)).get();
  if (!user || user.status !== 'ACTIVE') return next(unauthorized('Account is not active'));
  if (user.role === UserRole.WORKER) {
    // A worker login lives and dies with the worker record: deactivating the worker ends their access.
    const linked = user.workerId ? db.select({ status: workers.status }).from(workers).where(eq(workers.id, user.workerId)).get() : undefined;
    if (!linked || linked.status !== 'ACTIVE') return next(unauthorized('Account is not active'));
  }
  const org = db.select().from(organisations).where(eq(organisations.id, user.orgId)).get();
  if (!org) return next(unauthorized('Organisation not found'));
  if (org.status === 'SUSPENDED' && user.role !== UserRole.PLATFORM_ADMIN) return next(forbidden('Your organisation is suspended'));
  const settings = db.select().from(platformSettings).where(eq(platformSettings.id, 'default')).get();
  if (!settings) return next(new Error('Platform settings missing; run migrations/seed'));
  req.auth = { user, org, settings };
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const role = req.auth?.user.role;
    if (!role || !roles.includes(role)) return next(forbidden());
    next();
  };
}

export const MANAGERS: UserRole[] = [UserRole.PLATFORM_ADMIN, UserRole.ORG_ADMIN, UserRole.ORG_MANAGER];
export const ADMINS: UserRole[] = [UserRole.PLATFORM_ADMIN, UserRole.ORG_ADMIN];

export function isPlatformAdmin(req: Request): boolean {
  return req.auth?.user.role === UserRole.PLATFORM_ADMIN;
}

export function isManager(req: Request): boolean {
  return !!req.auth && MANAGERS.includes(req.auth.user.role);
}

/** Platform admins may act on any organisation; everyone else only on their own. */
export function assertOrgAccess(req: Request, orgId: string): void {
  if (isPlatformAdmin(req)) return;
  if (req.auth?.org.id !== orgId) throw forbidden('That belongs to another organisation');
}
