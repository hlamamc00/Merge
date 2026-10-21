import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { OrgType, ServiceType, UserRole } from '@merge/shared';
import { organisations, platformSettings, users, workers } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { hashPassword, requireAuth, signToken, verifyPassword } from '../lib/auth.js';
import { auth, deps } from '../lib/context.js';
import { badRequest, conflict, h, unauthorized } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
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
    ensureSettings(db, at);
    const orgId = newId('org');
    db.insert(organisations).values({ id: orgId, ...body.organisation, type: OrgType.AGENCY, status: 'ACTIVE', createdAt: at, updatedAt: at }).run();
    db.update(platformSettings).set({ ownerOrgId: orgId, updatedAt: at }).where(eq(platformSettings.id, 'default')).run();
    const user = await createUser(db, orgId, body.admin, UserRole.PLATFORM_ADMIN, at);
    audit(db, { userId: user.id, orgId }, { action: 'CREATE', entityType: 'organisation', entityId: orgId, data: { bootstrap: true } }, at);
    res.status(201).json({ token: signToken({ sub: user.id, orgId, role: user.role }), user: publicUser(user), organisation: db.select().from(organisations).where(eq(organisations.id, orgId)).get() });
  }),
);

/** A care provider joins the network. */
authRouter.post(
  '/register',
  h(async (req, res) => {
    const { db, now } = deps(req);
    const body = parseBody(req, z.object({ organisation: zOrganisation, admin: zAdmin }));
    const at = now();
    ensureSettings(db, at);
    if (db.select({ id: users.id }).from(users).where(eq(users.email, body.admin.email)).get()) throw conflict('An account with that email already exists');
    const orgId = newId('org');
    db.insert(organisations).values({ id: orgId, ...body.organisation, type: OrgType.PROVIDER, status: 'ACTIVE', createdAt: at, updatedAt: at }).run();
    const user = await createUser(db, orgId, body.admin, UserRole.ORG_ADMIN, at);
    audit(db, { userId: user.id, orgId }, { action: 'CREATE', entityType: 'organisation', entityId: orgId }, at);
    res.status(201).json({ token: signToken({ sub: user.id, orgId, role: user.role }), user: publicUser(user), organisation: db.select().from(organisations).where(eq(organisations.id, orgId)).get() });
  }),
);

authRouter.post(
  '/login',
  h(async (req, res) => {
    const { db, now } = deps(req);
    const body = parseBody(req, z.object({ email: z.string().email().transform((e) => e.toLowerCase()), password: z.string() }));
    const user = db.select().from(users).where(eq(users.email, body.email)).get();
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) throw unauthorized('Incorrect email or password');
    if (user.status !== 'ACTIVE') throw unauthorized('Account is not active');
    const at = now();
    db.update(users).set({ lastLoginAt: at }).where(eq(users.id, user.id)).run();
    audit(db, { userId: user.id, orgId: user.orgId }, { action: 'LOGIN', entityType: 'user', entityId: user.id }, at);
    const organisation = db.select().from(organisations).where(eq(organisations.id, user.orgId)).get();
    res.json({ token: signToken({ sub: user.id, orgId: user.orgId, role: user.role }), user: publicUser(user), organisation });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  h((req, res) => {
    const { db } = deps(req);
    const { user, org, settings } = auth(req);
    const worker = user.workerId ? db.select().from(workers).where(eq(workers.id, user.workerId)).get() : null;
    res.json({
      user: publicUser(user),
      organisation: org,
      worker,
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
      },
    });
  }),
);

async function createUser(db: ReturnType<typeof deps>['db'], orgId: string, admin: z.infer<typeof zAdmin>, role: UserRole, at: Date) {
  const id = newId('usr');
  db.insert(users)
    .values({ id, orgId, email: admin.email, passwordHash: await hashPassword(admin.password), firstName: admin.firstName, lastName: admin.lastName, role, status: 'ACTIVE', createdAt: at })
    .run();
  const user = db.select().from(users).where(eq(users.id, id)).get();
  if (!user) throw badRequest('Could not create user');
  return user;
}

export function publicUser(u: typeof users.$inferSelect) {
  const { passwordHash: _ph, ...rest } = u;
  return rest;
}

export { zOrganisation };
