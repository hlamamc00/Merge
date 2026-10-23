import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { sites } from '../db/schema.js';
import { MANAGERS, allowedSiteIds, assertOrgAccess, assertSiteAccess, requireAuth, requireRole } from '../lib/auth.js';
import { auth, deps } from '../lib/context.js';
import { badRequest, h } from '../lib/errors.js';
import { parseQuery, zDate } from '../lib/validate.js';
import { londonDay, workforceReport, workforceReportCsv } from '../services/workforceReport.js';

/**
 * Regulator-ready reports (REP-01). A host's managers report on their own sites; a site-limited
 * manager only on theirs; the platform admin on any organisation.
 */
export const reportsRouter = Router();
reportsRouter.use(requireAuth);

const DAY = 86_400_000;

reportsRouter.get(
  '/workforce',
  requireRole(...MANAGERS),
  h((req, res) => {
    const { db, now } = deps(req);
    const q = parseQuery(req, z.object({ orgId: z.string().optional(), siteId: z.string().optional(), from: zDate.optional(), to: zDate.optional(), format: z.enum(['json', 'csv']).default('json') }));
    const orgId = q.orgId ?? auth(req).org.id;
    assertOrgAccess(req, orgId);
    if (q.siteId) assertSiteAccess(req, q.siteId);
    const to = q.to ?? now();
    const from = q.from ?? new Date(to.getTime() - 90 * DAY);
    if (to.getTime() < from.getTime()) throw badRequest('to must be after from');
    const report = workforceReport(db, { orgId, siteId: q.siteId, siteIds: allowedSiteIds(req), from, to });
    if (q.format === 'csv') {
      const site = q.siteId ? db.select({ name: sites.name }).from(sites).where(eq(sites.id, q.siteId)).get()?.name ?? q.siteId : 'all-sites';
      const slug = site.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="workforce-${slug}-${londonDay(from)}-${londonDay(to)}.csv"`);
      res.send(workforceReportCsv(report));
      return;
    }
    res.json({ orgId, siteId: q.siteId ?? null, ...report });
  }),
);
