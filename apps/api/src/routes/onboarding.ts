/**
 * Onboarding: bulk worker import, email invitations, forgotten and changed passwords.
 * Public routes (token-based) are declared before the auth guard.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { UserRole } from '@merge/shared';
import { authTokens, importJobs, organisations, users, workers } from '../db/schema.js';
import { auditFromReq } from '../lib/audit.js';
import { ADMINS, MANAGERS, assertOrgAccess, hashPassword, isPlatformAdmin, requireAuth, requireRole, signToken, verifyPassword } from '../lib/auth.js';
import { auth, deps } from '../lib/context.js';
import { HttpError, badRequest, conflict, forbidden, h, notFound, unauthorized } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { parseBody } from '../lib/validate.js';
import type { Db } from '../db/client.js';
import { applyRows, orgSites, parseUpload, rowsToObjects, templateCsv, validateRows } from '../services/import.js';
import { enqueueEmail, webUrl } from '../services/mail.js';

export const onboardingRouter = Router();

// ---------- passwords and tokens ----------

const COMMON_PASSWORDS = new Set(['password', 'password1', 'password123', 'passw0rd', '1234567890', 'qwertyuiop', 'letmein123', 'welcome123', 'admin12345', 'merge12345', 'iloveyou12', 'changeme123']);

export function validatePassword(password: string, email: string): string | null {
  if (password.length < 10) return 'Password must be at least 10 characters';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'That password is too common';
  if (password.toLowerCase() === email.toLowerCase()) return 'Password cannot be your email address';
  return null;
}

const zPassword = z.string().min(1).max(200);

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function issueToken(db: Db, userId: string, kind: 'INVITE' | 'RESET', ttlMs: number, now: Date): string {
  const token = randomBytes(32).toString('base64url');
  db.insert(authTokens).values({ id: newId('tok'), userId, kind, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + ttlMs), usedAt: null, createdAt: now }).run();
  return token;
}

function findToken(db: Db, token: string, kind: 'INVITE' | 'RESET', now: Date) {
  const row = db.select().from(authTokens).where(and(eq(authTokens.tokenHash, hashToken(token)), eq(authTokens.kind, kind))).get();
  if (!row) throw notFound('Link');
  if (row.usedAt) throw new HttpError(410, 'This link has already been used');
  if (row.expiresAt.getTime() <= now.getTime()) throw new HttpError(410, 'This link has expired');
  return row;
}

const INVITE_TTL = 7 * 24 * 3_600_000;
const RESET_TTL = 3_600_000;

export interface InvitationInput {
  orgId: string;
  email: string;
  role: UserRole;
  firstName: string;
  lastName: string;
  workerId?: string | null;
  siteIds?: string[] | null;
}

/** Create an invited user (unusable password until accepted) and email the invitation link. */
export async function createInvitation(db: Db, input: InvitationInput, invitedBy: { userId: string; name: string }, now: Date): Promise<{ userId: string; token: string }> {
  const email = input.email.toLowerCase();
  if (db.select({ id: users.id }).from(users).where(eq(users.email, email)).get()) throw conflict('An account with that email already exists');
  let worker: { id: string; userId: string | null } | undefined;
  if (input.workerId) {
    worker = db.select({ id: workers.id, userId: workers.userId }).from(workers).where(and(eq(workers.id, input.workerId), eq(workers.orgId, input.orgId))).get();
    if (!worker) throw notFound('Worker');
    if (worker.userId) throw conflict('Worker already has a login');
  }
  const org = db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, input.orgId)).get();
  const userId = newId('usr');
  db.insert(users)
    .values({ id: userId, orgId: input.orgId, workerId: worker?.id ?? null, email, passwordHash: await hashPassword(randomBytes(24).toString('base64url')), firstName: input.firstName, lastName: input.lastName, role: input.role, status: 'ACTIVE', siteIds: input.siteIds ?? null, mustChangePassword: true, createdAt: now })
    .run();
  if (worker) db.update(workers).set({ userId, updatedAt: now }).where(eq(workers.id, worker.id)).run();
  const token = issueToken(db, userId, 'INVITE', INVITE_TTL, now);
  sendInvitationEmail(db, { userId, email, firstName: input.firstName, orgName: org?.name ?? 'your organisation', role: input.role, invitedBy: invitedBy.name, token, orgId: input.orgId }, now);
  return { userId, token };
}

function sendInvitationEmail(db: Db, p: { userId: string; email: string; firstName: string; orgName: string; role: UserRole; invitedBy: string; token: string; orgId: string }, now: Date): void {
  const link = `${webUrl()}/invite/${p.token}`;
  const what = p.role === UserRole.WORKER ? 'see shifts you can take, confirm where to go, and clock in and out' : 'manage shifts, workers and timesheets';
  enqueueEmail(
    db,
    {
      to: p.email,
      subject: `${p.invitedBy} has invited you to Merge`,
      body: `Hi ${p.firstName},\n\n${p.invitedBy} at ${p.orgName} has set up a Merge account for you, so you can ${what}.\n\nChoose your password here (the link works for 7 days):\n${link}\n\nIf you were not expecting this, you can ignore this email.\n\nMerge`,
      userId: p.userId,
      orgId: p.orgId,
    },
    now,
  );
}

// ---------- public: invitations and password reset ----------

onboardingRouter.get(
  '/invitations/:token',
  h((req, res) => {
    const { db, now } = deps(req);
    const row = findToken(db, req.params.token!, 'INVITE', now());
    const user = db.select().from(users).where(eq(users.id, row.userId)).get();
    if (!user) throw notFound('Invitation');
    const org = db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, user.orgId)).get();
    res.json({ email: user.email, firstName: user.firstName, lastName: user.lastName, organisationName: org?.name, role: user.role, expiresAt: row.expiresAt });
  }),
);

onboardingRouter.post(
  '/invitations/:token/accept',
  h(async (req, res) => {
    const { db, now } = deps(req);
    const body = parseBody(req, z.object({ password: zPassword }));
    const at = now();
    const row = findToken(db, req.params.token!, 'INVITE', at);
    const user = db.select().from(users).where(eq(users.id, row.userId)).get();
    if (!user) throw notFound('Invitation');
    const problem = validatePassword(body.password, user.email);
    if (problem) throw badRequest(problem);
    db.update(users).set({ passwordHash: await hashPassword(body.password), mustChangePassword: false, status: 'ACTIVE', lastLoginAt: at }).where(eq(users.id, user.id)).run();
    db.update(authTokens).set({ usedAt: at }).where(eq(authTokens.id, row.id)).run();
    res.json({ token: signToken({ sub: user.id, orgId: user.orgId, role: user.role }), user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role, orgId: user.orgId } });
  }),
);

onboardingRouter.post(
  '/forgot-password',
  h((req, res) => {
    const { db, now } = deps(req);
    const body = parseBody(req, z.object({ email: z.string().email().transform((e) => e.toLowerCase()) }));
    const at = now();
    const user = db.select().from(users).where(and(eq(users.email, body.email), eq(users.status, 'ACTIVE'))).get();
    // Always 200: the response must not reveal whether the address exists.
    if (user) {
      const recent = db
        .select({ id: authTokens.id })
        .from(authTokens)
        .where(and(eq(authTokens.userId, user.id), eq(authTokens.kind, 'RESET'), isNull(authTokens.usedAt), gt(authTokens.createdAt, new Date(at.getTime() - 10 * 60_000))))
        .get();
      if (!recent) {
        const token = issueToken(db, user.id, 'RESET', RESET_TTL, at);
        enqueueEmail(
          db,
          {
            to: user.email,
            subject: 'Reset your Merge password',
            body: `Hi ${user.firstName},\n\nSomeone asked to reset the password for this Merge account. If that was you, choose a new password here (the link works for one hour):\n${webUrl()}/reset-password/${token}\n\nIf it was not you, ignore this email and your password stays the same.\n\nMerge`,
            userId: user.id,
            orgId: user.orgId,
          },
          at,
        );
      }
    }
    res.json({ ok: true });
  }),
);

onboardingRouter.post(
  '/reset-password',
  h(async (req, res) => {
    const { db, now } = deps(req);
    const body = parseBody(req, z.object({ token: z.string().min(10), password: zPassword }));
    const at = now();
    const row = findToken(db, body.token, 'RESET', at);
    const user = db.select().from(users).where(eq(users.id, row.userId)).get();
    if (!user) throw notFound('Link');
    const problem = validatePassword(body.password, user.email);
    if (problem) throw badRequest(problem);
    db.update(users).set({ passwordHash: await hashPassword(body.password), mustChangePassword: false, failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, user.id)).run();
    db.update(authTokens).set({ usedAt: at }).where(eq(authTokens.id, row.id)).run();
    res.json({ ok: true });
  }),
);

// ---------- authenticated ----------

onboardingRouter.use(requireAuth);

onboardingRouter.post(
  '/change-password',
  h(async (req, res) => {
    const { db, now } = deps(req);
    const { user } = auth(req);
    const body = parseBody(req, z.object({ currentPassword: z.string(), newPassword: zPassword }));
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) throw unauthorized('Current password is incorrect');
    const problem = validatePassword(body.newPassword, user.email);
    if (problem) throw badRequest(problem);
    const at = now();
    db.update(users).set({ passwordHash: await hashPassword(body.newPassword), mustChangePassword: false }).where(eq(users.id, user.id)).run();
    auditFromReq(req, db, { action: 'UPDATE', entityType: 'user', entityId: user.id, data: { passwordChanged: true } }, at);
    res.json({ ok: true });
  }),
);

const zInvitation = z.object({
  orgId: z.string().optional(),
  email: z.string().email().transform((e) => e.toLowerCase()),
  role: z.enum([UserRole.ORG_ADMIN, UserRole.ORG_MANAGER, UserRole.WORKER]),
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  workerId: z.string().nullable().optional(),
  siteIds: z.array(z.string()).nullable().optional(),
});

onboardingRouter.post(
  '/invitations',
  requireRole(...MANAGERS),
  h(async (req, res) => {
    const { db, now } = deps(req);
    const { user, org } = auth(req);
    const body = parseBody(req, zInvitation);
    const orgId = body.orgId ?? org.id;
    assertOrgAccess(req, orgId);
    if (body.role !== UserRole.WORKER && !ADMINS.includes(user.role)) throw forbidden('Only organisation admins can invite managers and admins');
    if (body.role === UserRole.WORKER && !body.workerId) throw badRequest('A worker invitation needs the workerId of the worker record');
    const at = now();
    const { userId } = await createInvitation(db, { orgId, email: body.email, role: body.role, firstName: body.firstName, lastName: body.lastName, workerId: body.workerId ?? null, siteIds: body.siteIds ?? null }, { userId: user.id, name: `${user.firstName} ${user.lastName}` }, at);
    auditFromReq(req, db, { action: 'CREATE', entityType: 'user', entityId: userId, data: { invited: true, role: body.role, workerId: body.workerId } }, at);
    res.status(201).json({ userId, email: body.email, role: body.role });
  }),
);

onboardingRouter.post(
  '/invitations/resend',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const { user } = auth(req);
    const body = parseBody(req, z.object({ userId: z.string() }));
    const target = db.select().from(users).where(eq(users.id, body.userId)).get();
    if (!target) throw notFound('User');
    assertOrgAccess(req, target.orgId);
    if (!target.mustChangePassword) throw conflict('That user has already accepted their invitation');
    const at = now();
    db.update(authTokens).set({ usedAt: at }).where(and(eq(authTokens.userId, target.id), eq(authTokens.kind, 'INVITE'), isNull(authTokens.usedAt))).run();
    const token = issueToken(db, target.id, 'INVITE', INVITE_TTL, at);
    const org = db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, target.orgId)).get();
    sendInvitationEmail(db, { userId: target.id, email: target.email, firstName: target.firstName, orgName: org?.name ?? 'your organisation', role: target.role, invitedBy: `${user.firstName} ${user.lastName}`, token, orgId: target.orgId }, at);
    res.json({ ok: true });
  }),
);

/** Invitations awaiting acceptance for my organisation. */
onboardingRouter.get(
  '/invitations',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db } = deps(req);
    const { org } = auth(req);
    const orgId = typeof req.query.orgId === 'string' && isPlatformAdmin(req) ? req.query.orgId : org.id;
    const rows = db
      .select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName, role: users.role, workerId: users.workerId, createdAt: users.createdAt })
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.mustChangePassword, true), eq(users.status, 'ACTIVE')))
      .orderBy(desc(users.createdAt))
      .all();
    res.json(rows);
  }),
);

// ---------- bulk import ----------

onboardingRouter.get(
  '/import/template.csv',
  requireRole(...MANAGERS),
  h((_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="merge-worker-import-template.csv"');
    res.send(templateCsv());
  }),
);

const zUpload = z.object({ fileName: z.string().min(1).max(200), contentBase64: z.string().min(1).max(20_000_000), orgId: z.string().optional() });

async function parseAndValidate(db: Db, orgId: string, fileName: string, contentBase64: string) {
  const buffer = Buffer.from(contentBase64, 'base64');
  const rows = await parseUpload(fileName, buffer);
  if (rows.length < 2) throw badRequest('The file has no data rows (the first row must be the column headers)');
  const objects = rowsToObjects(rows);
  const headerKnown = Object.keys(objects[0]?.values ?? {}).length > 0;
  if (!headerKnown) throw badRequest('None of the column headers were recognised; download the template to see the expected columns');
  return { rows, objects, ...validateRows(objects, orgSites(db, orgId)) };
}

onboardingRouter.post(
  '/import/preview',
  requireRole(...MANAGERS),
  h(async (req, res) => {
    const { db, now } = deps(req);
    const { user, org } = auth(req);
    const body = parseBody(req, zUpload);
    const orgId = body.orgId ?? org.id;
    assertOrgAccess(req, orgId);
    const { objects, valid, errors } = await parseAndValidate(db, orgId, body.fileName, body.contentBase64);
    const at = now();
    const jobId = newId('imp');
    db.insert(importJobs).values({ id: jobId, orgId, createdByUserId: user.id, fileName: body.fileName, status: 'PREVIEW', totalRows: objects.length, failedCount: errors.length, errors, createdAt: at }).run();
    res.json({
      jobId,
      totalRows: objects.length,
      validRows: valid.length,
      invitable: valid.filter((r) => r.invite && r.email).length,
      errors,
      sample: valid.slice(0, 10).map((r) => ({ line: r.line, name: `${r.firstName} ${r.lastName}`, email: r.email, jobRole: r.jobRole, skills: r.skills, homeSiteId: r.homeSiteId, documents: r.documents.length, invite: r.invite })),
    });
  }),
);

onboardingRouter.post(
  '/import/:jobId/apply',
  requireRole(...MANAGERS),
  h(async (req, res) => {
    const { db, now } = deps(req);
    const { user, org } = auth(req);
    const body = parseBody(req, zUpload.extend({ invite: z.boolean().default(true) }));
    const job = db.select().from(importJobs).where(eq(importJobs.id, req.params.jobId!)).get();
    if (!job) throw notFound('Import');
    assertOrgAccess(req, job.orgId);
    if (job.status === 'APPLIED') throw conflict('This import has already been applied');
    const { objects, valid, errors } = await parseAndValidate(db, job.orgId, body.fileName, body.contentBase64);
    const at = now();
    const invitedBy = { userId: user.id, name: `${user.firstName} ${user.lastName}` };
    const result = await applyRows(db, job.orgId, valid, { invite: body.invite, verifierUserId: user.id }, at, async (w) => {
      await createInvitation(db, { orgId: job.orgId, email: w.email, role: UserRole.WORKER, firstName: w.firstName, lastName: w.lastName, workerId: w.id }, invitedBy, at);
    });
    const allErrors = [...errors, ...result.failures];
    db.update(importJobs)
      .set({ status: 'APPLIED', totalRows: objects.length, createdCount: result.created, updatedCount: result.updated, invitedCount: result.invited, failedCount: allErrors.length, errors: allErrors, appliedAt: at })
      .where(eq(importJobs.id, job.id))
      .run();
    auditFromReq(req, db, { action: 'CREATE', entityType: 'import_job', entityId: job.id, data: { created: result.created, updated: result.updated, invited: result.invited, documents: result.documents, failed: allErrors.length } }, at);
    res.json({ jobId: job.id, created: result.created, updated: result.updated, invited: result.invited, documents: result.documents, failed: allErrors.length, errors: allErrors, workerIds: result.workerIds });
    void org;
  }),
);

onboardingRouter.get(
  '/import/jobs',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db } = deps(req);
    const { org } = auth(req);
    res.json(db.select().from(importJobs).where(eq(importJobs.orgId, org.id)).orderBy(desc(importJobs.createdAt)).limit(20).all());
  }),
);
