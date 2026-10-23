import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { OrgType, ServiceType, UserRole } from '@merge/shared';
import { organisations, platformSettings, users, workers } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { hashPassword, requireAuth, signChallengeToken, signToken, verifyPassword, verifyToken, type TokenPayload } from '../lib/auth.js';
import { auth, deps } from '../lib/context.js';
import { HttpError, badRequest, conflict, h, unauthorized } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { generateSecret, otpauthUrl, verifyTotp } from '../lib/totp.js';
import { parseBody, zPostcode } from '../lib/validate.js';
import { ensureSettings } from '../services/settings.js';

const zOrganisation = z.object({
  name: z.string().trim().min(2).max(120),
  serviceTypes: z.array(z.nativeEnum(ServiceType)).default([]),
  cqcRegistrationNumber: z.string().trim().max(40).nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  addressLine1: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  postcode: zPostcode.nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  defaultChargeRate: z.number().positive().max(500).nullable().optional(),
  workerSelfServiceAllowed: z.boolean().optional(),
});

const zAdmin = z.object({
  email: z.string().email().transform((e) => e.toLowerCase()),
  password: z.string().min(8).max(200),
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
});

/** Decision 16: five wrong passwords lock the account for fifteen minutes. */
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MINUTES = 15;

export const authRouter = Router();

/** First-run setup: create the platform-owning agency and its first administrator. Only works once. */
authRouter.post(
  '/bootstrap',
  h(async (req, res) => {
    const { db, now } = deps(req);
    const body = parseBody(req, z.object({ organisation: zOrganisation, admin: zAdmin }));
    const existing = db.select({ id: organisations.id }).from(organisations).where(eq(organisations.type, OrgType.AGENCY)).get();
    if (existing) throw conflict('The platform has already been set up');
    const at = now();
    const settings = ensureSettings(db, at);
    const orgId = newId('org');
    db.insert(organisations).values({ id: orgId, ...body.organisation, type: OrgType.AGENCY, status: 'ACTIVE', createdAt: at, updatedAt: at }).run();
    db.update(platformSettings).set({ ownerOrgId: orgId, updatedAt: at }).where(eq(platformSettings.id, 'default')).run();
    const user = await createUser(db, orgId, body.admin, UserRole.PLATFORM_ADMIN, at);
    // The operator stands behind the MOU it asks everyone else to sign.
    db.update(organisations).set({ mouAcceptedAt: at, mouVersion: settings.mouVersion, mouAcceptedByUserId: user.id }).where(eq(organisations.id, orgId)).run();
    audit(db, { userId: user.id, orgId }, { action: 'CREATE', entityType: 'organisation', entityId: orgId, data: { bootstrap: true } }, at);
    res.status(201).json({ token: signToken({ sub: user.id, orgId, role: user.role }), user: publicUser(user), organisation: db.select().from(organisations).where(eq(organisations.id, orgId)).get() });
  }),
);

/** A care provider joins the network. Decision 12: they must be a registered provider and accept the MOU before approval. */
authRouter.post(
  '/register',
  h(async (req, res) => {
    const { db, now } = deps(req);
    const body = parseBody(req, z.object({ organisation: zOrganisation, admin: zAdmin, mouAccepted: z.boolean().optional() }));
    const at = now();
    const settings = ensureSettings(db, at);
    if (db.select({ id: users.id }).from(users).where(eq(users.email, body.admin.email)).get()) throw conflict('An account with that email already exists');
    const orgId = newId('org');
    // New organisations are vetted by the platform before they can see or post network shifts.
    db.insert(organisations).values({ id: orgId, ...body.organisation, type: OrgType.PROVIDER, status: 'PENDING', createdAt: at, updatedAt: at }).run();
    const user = await createUser(db, orgId, body.admin, UserRole.ORG_ADMIN, at);
    if (body.mouAccepted) {
      db.update(organisations).set({ mouAcceptedAt: at, mouVersion: settings.mouVersion, mouAcceptedByUserId: user.id }).where(eq(organisations.id, orgId)).run();
    }
    audit(db, { userId: user.id, orgId }, { action: 'CREATE', entityType: 'organisation', entityId: orgId, data: { mouAccepted: !!body.mouAccepted, mouVersion: body.mouAccepted ? settings.mouVersion : null } }, at);
    res.status(201).json({ token: signToken({ sub: user.id, orgId, role: user.role }), user: publicUser(user), organisation: db.select().from(organisations).where(eq(organisations.id, orgId)).get() });
  }),
);

authRouter.post(
  '/login',
  h(async (req, res) => {
    const { db, now } = deps(req);
    const body = parseBody(req, z.object({ email: z.string().email().transform((e) => e.toLowerCase()), password: z.string() }));
    const at = now();
    const user = db.select().from(users).where(eq(users.email, body.email)).get();
    if (!user) throw unauthorized('Incorrect email or password');
    assertNotLocked(user, at);
    if (!(await verifyPassword(body.password, user.passwordHash))) {
      recordFailure(db, user, at);
      throw unauthorized('Incorrect email or password');
    }
    assertCanSignIn(db, user);
    if (user.failedLoginCount > 0 || user.lockedUntil) db.update(users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, user.id)).run();
    if (user.totpEnabledAt) {
      // Password accepted; the session token is only issued once the authenticator code checks out.
      res.json({ twoFactorRequired: true, challengeToken: signChallengeToken({ sub: user.id, orgId: user.orgId, role: user.role }) });
      return;
    }
    res.json(completeLogin(db, user, at));
  }),
);

/** Second step of login for accounts with an authenticator app. */
authRouter.post(
  '/2fa/verify',
  h((req, res) => {
    const { db, now } = deps(req);
    const body = parseBody(req, z.object({ challengeToken: z.string(), code: z.string() }));
    const at = now();
    let payload: TokenPayload;
    try {
      payload = verifyToken(body.challengeToken);
    } catch {
      throw unauthorized('Sign-in challenge expired; enter your password again');
    }
    if (payload.purpose !== '2fa') throw unauthorized('Not a sign-in challenge');
    const user = db.select().from(users).where(eq(users.id, payload.sub)).get();
    if (!user || !user.totpSecret || !user.totpEnabledAt) throw unauthorized('Two-factor authentication is not enabled on this account');
    assertNotLocked(user, at);
    if (!verifyTotp(user.totpSecret, body.code, at)) {
      recordFailure(db, user, at);
      throw unauthorized('Incorrect authenticator code');
    }
    assertCanSignIn(db, user);
    res.json(completeLogin(db, user, at));
  }),
);

/** Start enrolling an authenticator app: returns the secret to scan. Nothing changes until /2fa/enable confirms a code. */
authRouter.post(
  '/2fa/setup',
  requireAuth,
  h((req, res) => {
    const { db } = deps(req);
    const { user, settings } = auth(req);
    if (user.totpEnabledAt) throw conflict('Two-factor authentication is already enabled; disable it first to re-enrol');
    const secret = generateSecret();
    db.update(users).set({ totpSecret: secret }).where(eq(users.id, user.id)).run();
    res.json({ secret, otpauthUrl: otpauthUrl(secret, user.email, settings.platformName) });
  }),
);

authRouter.post(
  '/2fa/enable',
  requireAuth,
  h((req, res) => {
    const { db, now } = deps(req);
    const { user } = auth(req);
    const body = parseBody(req, z.object({ code: z.string() }));
    if (user.totpEnabledAt) throw conflict('Two-factor authentication is already enabled');
    if (!user.totpSecret) throw badRequest('Call /auth/2fa/setup first');
    const at = now();
    if (!verifyTotp(user.totpSecret, body.code, at)) throw badRequest('That code is not right; check the time on your phone and try again');
    db.update(users).set({ totpEnabledAt: at }).where(eq(users.id, user.id)).run();
    audit(db, { userId: user.id, orgId: user.orgId }, { action: 'UPDATE', entityType: 'user', entityId: user.id, data: { twoFactorEnabled: true } }, at);
    res.json({ enabled: true, enabledAt: at });
  }),
);

authRouter.post(
  '/2fa/disable',
  requireAuth,
  h((req, res) => {
    const { db, now } = deps(req);
    const { user } = auth(req);
    const body = parseBody(req, z.object({ code: z.string() }));
    if (!user.totpEnabledAt || !user.totpSecret) throw conflict('Two-factor authentication is not enabled');
    const at = now();
    if (!verifyTotp(user.totpSecret, body.code, at)) throw badRequest('That code is not right');
    db.update(users).set({ totpSecret: null, totpEnabledAt: null }).where(eq(users.id, user.id)).run();
    audit(db, { userId: user.id, orgId: user.orgId }, { action: 'UPDATE', entityType: 'user', entityId: user.id, data: { twoFactorEnabled: false } }, at);
    res.json({ enabled: false });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  h((req, res) => {
    const { db } = deps(req);
    const { user, org, settings } = auth(req);
    const worker = user.workerId ? db.select().from(workers).where(eq(workers.id, user.workerId)).get() : null;
    const twoFactorSetupRequired = settings.twoFactorRequiredForManagers && user.role !== UserRole.WORKER && !user.totpEnabledAt;
    res.json({
      user: publicUser(user),
      organisation: org,
      worker,
      security: { twoFactorSetupRequired, passwordChangeRequired: user.mustChangePassword },
      platform: {
        name: settings.platformName,
        ownerOrgId: settings.ownerOrgId,
        currency: settings.currency,
        platformFeePct: settings.platformFeePct,
        priorityWindowMinutes: settings.priorityWindowMinutes,
        agencyWindowMinutes: settings.agencyWindowMinutes,
        agencyPosition: settings.agencyPosition,
        urgentThresholdMinutes: settings.urgentThresholdMinutes,
        lateCancellationHours: settings.lateCancellationHours,
        twoFactorRequiredForManagers: settings.twoFactorRequiredForManagers,
        mouVersion: settings.mouVersion,
      },
    });
  }),
);

function assertNotLocked(user: typeof users.$inferSelect, at: Date): void {
  if (user.lockedUntil && user.lockedUntil.getTime() > at.getTime()) {
    const minutes = Math.max(1, Math.ceil((user.lockedUntil.getTime() - at.getTime()) / 60_000));
    throw new HttpError(423, `Account locked after too many failed attempts; try again in ${minutes} minute${minutes === 1 ? '' : 's'}`, { lockedUntil: user.lockedUntil });
  }
}

function recordFailure(db: ReturnType<typeof deps>['db'], user: typeof users.$inferSelect, at: Date): void {
  const failed = (user.lockedUntil && user.lockedUntil.getTime() <= at.getTime() ? 0 : user.failedLoginCount) + 1;
  const lock = failed >= LOCKOUT_THRESHOLD;
  const lockedUntil = lock ? new Date(at.getTime() + LOCKOUT_MINUTES * 60_000) : null;
  db.update(users).set({ failedLoginCount: lock ? 0 : failed, lockedUntil }).where(eq(users.id, user.id)).run();
  if (lock) audit(db, { userId: null, orgId: user.orgId }, { action: 'UPDATE', entityType: 'user', entityId: user.id, data: { lockedUntil, reason: 'too many failed sign-in attempts' } }, at);
}

function assertCanSignIn(db: ReturnType<typeof deps>['db'], user: typeof users.$inferSelect): void {
  if (user.status !== 'ACTIVE') throw unauthorized('Account is not active');
  if (user.role === UserRole.WORKER) {
    const linked = user.workerId ? db.select({ status: workers.status }).from(workers).where(eq(workers.id, user.workerId)).get() : undefined;
    if (!linked || linked.status !== 'ACTIVE') throw unauthorized('Account is not active');
  }
}

function completeLogin(db: ReturnType<typeof deps>['db'], user: typeof users.$inferSelect, at: Date) {
  db.update(users).set({ lastLoginAt: at, failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, user.id)).run();
  audit(db, { userId: user.id, orgId: user.orgId }, { action: 'LOGIN', entityType: 'user', entityId: user.id }, at);
  const organisation = db.select().from(organisations).where(eq(organisations.id, user.orgId)).get();
  return { token: signToken({ sub: user.id, orgId: user.orgId, role: user.role }), user: publicUser({ ...user, lastLoginAt: at, failedLoginCount: 0, lockedUntil: null }), organisation };
}

async function createUser(db: ReturnType<typeof deps>['db'], orgId: string, admin: z.infer<typeof zAdmin>, role: UserRole, at: Date) {
  const id = newId('usr');
  db.insert(users)
    .values({ id, orgId, email: admin.email, passwordHash: await hashPassword(admin.password), firstName: admin.firstName, lastName: admin.lastName, role, status: 'ACTIVE', createdAt: at })
    .run();
  const user = db.select().from(users).where(eq(users.id, id)).get();
  if (!user) throw badRequest('Could not create user');
  return user;
}

/** What other users and the browser may see of a user: never the password hash or the authenticator secret. */
export function publicUser(u: typeof users.$inferSelect) {
  const { passwordHash: _ph, totpSecret: _ts, totpEnabledAt, ...rest } = u;
  return { ...rest, twoFactorEnabled: !!totpEnabledAt, totpEnabledAt };
}

export { zOrganisation };
