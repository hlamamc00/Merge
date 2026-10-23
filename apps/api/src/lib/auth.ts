import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole } from '@merge/shared';
import { config } from '../config.js';
import { organisations, platformSettings, sites, users, workers } from '../db/schema.js';
import { deps } from './context.js';
import { HttpError, forbidden, unauthorized } from './errors.js';

export interface TokenPayload {
  sub: string;
  orgId: string;
  role: UserRole;
  /** Absent on a normal session token; '2fa' marks the short-lived token issued between password and authenticator code. */
  purpose?: '2fa';
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn } as jwt.SignOptions);
}

/** Issued after a correct password when the account has two-factor enabled; only good for POST /auth/2fa/verify. */
export function signChallengeToken(payload: Omit<TokenPayload, 'purpose'>): string {
  return jwt.sign({ ...payload, purpose: '2fa' }, config.jwtSecret, { expiresIn: '5m' } as jwt.SignOptions);
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

/** Roles that must use an authenticator app when the platform requires it (decision 16). */
const TWO_FACTOR_ROLES: UserRole[] = [UserRole.PLATFORM_ADMIN, UserRole.ORG_ADMIN, UserRole.ORG_MANAGER];

/**
 * Paths a signed-in user may call while a security gate is still open: enough to see who they are,
 * set up their authenticator, and change a temporary password. Everything else is refused with
 * the gate's code so the web app can redirect.
 */
const GATE_ALLOW_LIST = [/^\/api\/v1\/auth\/me$/, /^\/api\/v1\/auth\/2fa\//, /^\/api\/v1\/onboarding\/change-password$/, /^\/api\/v1\/auth\/change-password$/];

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(unauthorized());
  let payload: TokenPayload;
  try {
    payload = verifyToken(header.slice(7));
  } catch {
    return next(unauthorized('Invalid or expired token'));
  }
  if (payload.purpose) return next(unauthorized('Finish signing in first'));
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

  const path = req.originalUrl.split('?')[0] ?? '';
  const gated = !GATE_ALLOW_LIST.some((re) => re.test(path));
  if (gated) {
    if (user.mustChangePassword) return next(new HttpError(403, 'You must change your temporary password before continuing', { code: 'PASSWORD_CHANGE_REQUIRED' }));
    if (settings.twoFactorRequiredForManagers && TWO_FACTOR_ROLES.includes(user.role) && !user.totpEnabledAt) {
      return next(new HttpError(403, 'Two-factor authentication must be set up before continuing', { code: 'TWO_FACTOR_REQUIRED' }));
    }
  }
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

/**
 * Decision 10: a manager can be limited to some of the organisation's sites.
 * Returns the site ids they may act on, or null when they may act on every site
 * (organisation admins, platform admins, and managers with no restriction).
 */
export function allowedSiteIds(req: Request): string[] | null {
  const user = req.auth?.user;
  if (!user) return [];
  if (user.role !== UserRole.ORG_MANAGER) return null;
  return user.siteIds && user.siteIds.length > 0 ? user.siteIds : null;
}

export function isSiteScoped(req: Request): boolean {
  return allowedSiteIds(req) !== null;
}

/** Throws unless the caller may act on the given site (which must also belong to their organisation). */
export function assertSiteAccess(req: Request, siteId: string): void {
  const { db } = deps(req);
  const site = db.select({ id: sites.id, orgId: sites.orgId }).from(sites).where(eq(sites.id, siteId)).get();
  if (!site) throw new HttpError(404, 'Site not found');
  assertOrgAccess(req, site.orgId);
  const allowed = allowedSiteIds(req);
  if (allowed && !allowed.includes(siteId)) throw forbidden('You are not assigned to that site');
}
