/**
 * Compliance helpers shared by the workers, compliance and admin routes:
 * the memorandum of understanding (decision 12), approval checks, document reports and host requirements (decision 11).
 */
import { and, asc, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { DocumentStatus, EXPIRING_SOON_DAYS, addDays, complianceSummary, type DocumentType } from '@merge/shared';
import type { Db } from '../db/client.js';
import { hostRequirements, organisations, sites, users, workerDocuments, workerHostRequirements, workers, type Organisation, type WorkerDocument } from '../db/schema.js';

// ---------- Memorandum of understanding ----------

export interface MouSection {
  heading: string;
  body: string;
}

export const MOU_SECTIONS: MouSection[] = [
  {
    heading: 'Who can join',
    body: 'Merge is for regulated care providers. Your organisation must be registered with the Care Quality Commission (or the equivalent regulator for your nation) and must give its registration number. The platform operator checks this before activating your account and may ask for evidence at any time.',
  },
  {
    heading: 'Your own staff are your responsibility',
    body: 'Every worker you make available on the network is employed (or engaged) by you. You confirm that each of them holds the mandatory checks and training for their role: an enhanced DBS check, right to work, photo ID, references, and up-to-date mandatory training (including moving and handling and safeguarding, plus medication training and an NMC PIN where the role needs them). You keep these records current on the platform. A host may ask for additional, host-specific requirements (for example a site induction); you declare which of your workers hold them, truthfully.',
  },
  {
    heading: 'When one of your workers is lent out',
    body: 'A worker sent to another organisation remains your employee and is accountable to you. You must have a framework for receiving and acting on reports from a host about a lent worker (conduct, attendance, competence or safeguarding), and you agree to respond to such reports promptly. Hosts may stop a named worker from being sent to them again. Repeated no-shows by your workers are a disciplinary matter for you, and the platform may remove your priority access or suspend your organisation while they persist.',
  },
  {
    heading: 'What the platform shares',
    body: 'Other organisations see only what the platform shows them: a worker\'s name, role, skills, compliance status and reliability, and the shifts and sites involved in a booking. Pay rates, private notes and the documents themselves stay with the employer. You will not use data obtained through the platform for any purpose other than arranging and delivering the cover booked, and you will not approach another organisation\'s workers to recruit them on the strength of a Merge booking.',
  },
  {
    heading: 'Money',
    body: 'Hosts pay the platform for the hours worked and the platform pays the supplying organisation, less the platform fee shown at the time of booking. Charge rates must be at or above the platform floor, which guarantees the worker at least the national minimum wage after employer costs. Hours are paid as clocked and approved; disputes are raised through the platform within the stated window. Hosts whose platform invoices fall overdue cannot post further shifts until they are settled.',
  },
  {
    heading: 'The operator\'s role',
    body: 'The platform operator vets organisations, runs the dispatch and settlement process, arbitrates disputes and may suspend any organisation that breaches this memorandum or the law. The operator may also supply its own bank of workers on the same terms as every other supplier. The operator does not employ your workers and is not a party to the employment relationship.',
  },
];

export function mouDocument(version: string) {
  return {
    version,
    title: 'Merge network memorandum of understanding',
    summary: 'The commitments every organisation makes to the rest of the network when it joins Merge.',
    sections: MOU_SECTIONS,
    text: MOU_SECTIONS.map((s) => `${s.heading}\n${s.body}`).join('\n\n'),
  };
}

// ---------- Approval ----------

/** Reasons an organisation cannot yet be approved (empty when it can). */
export function approvalBlockers(org: Organisation): string[] {
  const out: string[] = [];
  if (!org.cqcRegistrationNumber?.trim()) out.push('No CQC (regulator) registration number has been given');
  if (!org.mouAcceptedAt) out.push('The memorandum of understanding has not been accepted');
  return out;
}

// ---------- Documents ----------

export const ALLOWED_DOCUMENT_MIME_TYPES: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** The documents that currently count: a corrected (superseded) document is history only. */
export function activeDocuments<T extends { supersededAt: Date | null }>(docs: T[]): T[] {
  return docs.filter((d) => !d.supersededAt);
}

/** Rows the browser may see: never the storage key. */
export function publicDocument(d: WorkerDocument) {
  const { fileKey, ...rest } = d;
  return { ...rest, hasFile: !!fileKey };
}

export interface WorkerScope {
  /** Organisation whose workers are in scope. */
  orgId: string;
  /** Sites the caller is limited to (null = every site). */
  siteIds: string[] | null;
}

/** Workers the caller may see: their organisation's, narrowed to their sites when site-scoped (unassigned workers stay visible). */
export function scopedWorkers(db: Db, scope: WorkerScope) {
  const rows = db.select().from(workers).where(eq(workers.orgId, scope.orgId)).all();
  if (!scope.siteIds) return rows;
  const allowed = new Set(scope.siteIds);
  return rows.filter((w) => !w.homeSiteId || allowed.has(w.homeSiteId));
}

export interface ExpiringDocument {
  document: ReturnType<typeof publicDocument>;
  worker: { id: string; firstName: string; lastName: string; jobRole: string; homeSiteId: string | null; status: string };
  daysLeft: number;
  status: DocumentStatus;
}

/** Documents expiring within `days` (including already expired), soonest first. */
export function expiringDocuments(db: Db, workerRows: (typeof workers.$inferSelect)[], now: Date, days: number, type?: DocumentType): ExpiringDocument[] {
  if (workerRows.length === 0) return [];
  const byId = new Map(workerRows.map((w) => [w.id, w]));
  const horizon = addDays(now, days);
  const rows = db
    .select()
    .from(workerDocuments)
    .where(and(inArray(workerDocuments.workerId, [...byId.keys()]), isNull(workerDocuments.supersededAt), lte(workerDocuments.expiresAt, horizon), type ? eq(workerDocuments.type, type) : undefined))
    .orderBy(asc(workerDocuments.expiresAt))
    .all();
  return rows
    .filter((d) => d.expiresAt)
    .map((d) => {
      const w = byId.get(d.workerId)!;
      const daysLeft = Math.ceil((d.expiresAt!.getTime() - now.getTime()) / 86_400_000);
      return {
        document: publicDocument(d),
        worker: { id: w.id, firstName: w.firstName, lastName: w.lastName, jobRole: w.jobRole, homeSiteId: w.homeSiteId, status: w.status },
        daysLeft,
        status: daysLeft <= 0 ? DocumentStatus.EXPIRED : !d.verifiedAt ? DocumentStatus.PENDING_VERIFICATION : DocumentStatus.EXPIRING,
      };
    });
}

/** Unverified documents awaiting a manager's check, oldest first. */
export function verificationQueue(db: Db, workerRows: (typeof workers.$inferSelect)[]) {
  if (workerRows.length === 0) return [];
  const byId = new Map(workerRows.map((w) => [w.id, w]));
  const rows = db
    .select()
    .from(workerDocuments)
    .where(and(inArray(workerDocuments.workerId, [...byId.keys()]), isNull(workerDocuments.supersededAt), isNull(workerDocuments.verifiedAt)))
    .orderBy(asc(workerDocuments.createdAt))
    .all();
  const uploaderIds = [...new Set(rows.map((r) => r.uploadedByUserId).filter((x): x is string => !!x))];
  const uploaders = uploaderIds.length ? db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, role: users.role }).from(users).where(inArray(users.id, uploaderIds)).all() : [];
  const uploaderById = new Map(uploaders.map((u) => [u.id, u]));
  return rows.map((d) => {
    const w = byId.get(d.workerId)!;
    const u = d.uploadedByUserId ? uploaderById.get(d.uploadedByUserId) : undefined;
    return {
      document: publicDocument(d),
      worker: { id: w.id, firstName: w.firstName, lastName: w.lastName, jobRole: w.jobRole, homeSiteId: w.homeSiteId, status: w.status },
      uploadedBy: u ? { id: u.id, name: `${u.firstName} ${u.lastName}`, role: u.role } : null,
      replacesDocumentId: d.replacesDocumentId,
    };
  });
}

export function complianceOverview(db: Db, workerRows: (typeof workers.$inferSelect)[], now: Date) {
  const active = workerRows.filter((w) => w.status === 'ACTIVE');
  const ids = workerRows.map((w) => w.id);
  const docs = ids.length ? activeDocuments(db.select().from(workerDocuments).where(inArray(workerDocuments.workerId, ids)).all()) : [];
  let compliant = 0;
  let expiring = 0;
  let nonCompliant = 0;
  for (const w of active) {
    const s = complianceSummary(docs.filter((d) => d.workerId === w.id), w.jobRole, now).status;
    if (s === 'COMPLIANT') compliant++;
    else if (s === 'EXPIRING') expiring++;
    else nonCompliant++;
  }
  const soon = addDays(now, EXPIRING_SOON_DAYS).getTime();
  return {
    workers: { total: active.length, compliant, expiring, nonCompliant },
    documents: {
      expiringIn30Days: docs.filter((d) => d.expiresAt && d.expiresAt.getTime() > now.getTime() && d.expiresAt.getTime() <= soon).length,
      expired: docs.filter((d) => d.expiresAt && d.expiresAt.getTime() <= now.getTime()).length,
      awaitingVerification: docs.filter((d) => !d.verifiedAt).length,
    },
  };
}

// ---------- Host requirements ----------

export function hostRequirementsForWorker(db: Db, workerId: string, now: Date) {
  return db
    .select({
      requirementId: workerHostRequirements.requirementId,
      name: hostRequirements.name,
      description: hostRequirements.description,
      hostOrgId: hostRequirements.hostOrgId,
      hostName: organisations.name,
      recordedByHost: hostRequirements.recordedByHost,
      expiresAt: workerHostRequirements.expiresAt,
      documentId: workerHostRequirements.documentId,
      recordedAt: workerHostRequirements.createdAt,
      archivedAt: hostRequirements.archivedAt,
    })
    .from(workerHostRequirements)
    .innerJoin(hostRequirements, eq(hostRequirements.id, workerHostRequirements.requirementId))
    .innerJoin(organisations, eq(organisations.id, hostRequirements.hostOrgId))
    .where(eq(workerHostRequirements.workerId, workerId))
    .orderBy(desc(workerHostRequirements.createdAt))
    .all()
    .map((r) => ({ ...r, expired: !!r.expiresAt && r.expiresAt.getTime() <= now.getTime() }));
}

/** Sites of an organisation as id → name, for labelling workers' home sites. */
export function siteNames(db: Db, orgId: string): Record<string, string> {
  return Object.fromEntries(db.select({ id: sites.id, name: sites.name }).from(sites).where(eq(sites.orgId, orgId)).all().map((s) => [s.id, s.name]));
}
