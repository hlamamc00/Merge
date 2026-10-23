/**
 * Workforce report for inspections (REP-01): who worked where, for which employer, and whether
 * every mandatory check was in place on the day. Hosts see compliance status only (decision 13):
 * never pay, references or document details, so the rows carry a status per document type.
 */
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { DocumentType, PLATFORM_TIME_ZONE, requiredDocumentsForRole, shiftPaidHours, type AssignmentStatus, type JobRole, type TimesheetStatus } from '@merge/shared';
import type { Db } from '../db/client.js';
import { organisations, shiftAssignments, shifts, sites, timesheets, workerDocuments, workers, type WorkerDocument } from '../db/schema.js';
import { toCsv } from './settlement.js';

export type DayDocumentStatus = 'VALID' | 'EXPIRED' | 'UNVERIFIED' | 'MISSING';
export type Attendance = 'COMPLETED' | 'NO_SHOW' | 'CONFIRMED' | 'CANCELLED';

export interface WorkforceRow {
  shiftId: string;
  siteId: string;
  siteName: string;
  /** Calendar day of the shift in Europe/London. */
  shiftDate: string;
  startsAt: Date;
  endsAt: Date;
  jobRole: JobRole;
  shiftTitle: string;
  workerId: string;
  workerName: string;
  employerOrgId: string;
  employerName: string;
  attendance: Attendance;
  /** Approved timesheet hours when there is one, otherwise the scheduled hours net of break. */
  paidHours: number;
  timesheetStatus: TimesheetStatus | null;
  documents: Partial<Record<DocumentType, DayDocumentStatus>>;
  compliantOnDay: boolean;
}

export interface WorkforceReport {
  from: Date;
  to: Date;
  rows: WorkforceRow[];
  summary: { shifts: number; workers: number; employers: number; nonCompliantOnDay: number };
}

export interface WorkforceReportInput {
  orgId: string;
  /** One site, or (for site-limited managers) the sites they may see; omitted = every site of the organisation. */
  siteId?: string;
  siteIds?: string[] | null;
  from: Date;
  to: Date;
}

/** Assignments that count as a worker having been booked on the shift (cancellations and refusals do not). */
const WORKED_STATUSES: AssignmentStatus[] = ['CONFIRMED', 'COMPLETED', 'NO_SHOW'];

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: PLATFORM_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** `YYYY-MM-DD` of an instant in the platform time zone (en-CA formats as ISO order). */
export function londonDay(d: Date): string {
  return dayFmt.format(d);
}

/**
 * Status of one document type on a given instant, judged from the full history: a corrected
 * (superseded) document still counts for days before its correction, and a verification after
 * the shift does not make the shift retrospectively compliant.
 */
export function documentStatusOnDay(docs: Pick<WorkerDocument, 'type' | 'verifiedAt' | 'expiresAt' | 'supersededAt' | 'createdAt'>[], type: DocumentType, at: Date): DayDocumentStatus {
  const t = at.getTime();
  const candidates = docs.filter((d) => d.type === type && d.createdAt.getTime() <= t && (!d.supersededAt || d.supersededAt.getTime() > t));
  if (candidates.length === 0) return 'MISSING';
  let best: DayDocumentStatus = 'MISSING';
  for (const d of candidates) {
    const verified = !!d.verifiedAt && d.verifiedAt.getTime() <= t;
    const status: DayDocumentStatus = !verified ? 'UNVERIFIED' : !d.expiresAt || d.expiresAt.getTime() >= t ? 'VALID' : 'EXPIRED';
    if (status === 'VALID') return 'VALID';
    // Prefer the more useful explanation: an unverified renewal over an old expired copy.
    if (status === 'UNVERIFIED' || best === 'MISSING') best = status;
  }
  return best;
}

export function workforceReport(db: Db, input: WorkforceReportInput): WorkforceReport {
  const siteFilter = input.siteId ? [input.siteId] : input.siteIds ?? null;
  const rows = db
    .select({ assignment: shiftAssignments, shift: shifts, site: sites, worker: workers, employerName: organisations.name })
    .from(shiftAssignments)
    .innerJoin(shifts, eq(shifts.id, shiftAssignments.shiftId))
    .innerJoin(sites, eq(sites.id, shifts.siteId))
    .innerJoin(workers, eq(workers.id, shiftAssignments.workerId))
    .innerJoin(organisations, eq(organisations.id, shiftAssignments.supplierOrgId))
    .where(
      and(
        eq(shifts.hostOrgId, input.orgId),
        inArray(shiftAssignments.status, WORKED_STATUSES),
        gte(shifts.startsAt, input.from),
        lte(shifts.startsAt, input.to),
        siteFilter ? inArray(shifts.siteId, siteFilter.length ? siteFilter : ['-']) : undefined,
      ),
    )
    .orderBy(shifts.startsAt, sites.name, workers.lastName)
    .all();

  const assignmentIds = rows.map((r) => r.assignment.id);
  const workerIds = [...new Set(rows.map((r) => r.worker.id))];
  const sheets = new Map(
    (assignmentIds.length ? db.select().from(timesheets).where(inArray(timesheets.assignmentId, assignmentIds)).all() : []).map((t) => [t.assignmentId, t]),
  );
  const history = workerIds.length ? db.select().from(workerDocuments).where(inArray(workerDocuments.workerId, workerIds)).all() : [];
  const docsByWorker = new Map<string, WorkerDocument[]>();
  for (const d of history) docsByWorker.set(d.workerId, [...(docsByWorker.get(d.workerId) ?? []), d]);

  const out: WorkforceRow[] = rows.map(({ assignment, shift, site, worker, employerName }) => {
    const ts = sheets.get(assignment.id);
    const docs = docsByWorker.get(worker.id) ?? [];
    const documents: Partial<Record<DocumentType, DayDocumentStatus>> = {};
    for (const type of requiredDocumentsForRole(shift.jobRole)) documents[type] = documentStatusOnDay(docs, type, shift.startsAt);
    const attendance: Attendance = shift.status === 'CANCELLED' ? 'CANCELLED' : assignment.status === 'NO_SHOW' ? 'NO_SHOW' : assignment.status === 'COMPLETED' ? 'COMPLETED' : 'CONFIRMED';
    return {
      shiftId: shift.id,
      siteId: site.id,
      siteName: site.name,
      shiftDate: londonDay(shift.startsAt),
      startsAt: shift.startsAt,
      endsAt: shift.endsAt,
      jobRole: shift.jobRole,
      shiftTitle: shift.title,
      workerId: worker.id,
      workerName: `${worker.firstName} ${worker.lastName}`,
      employerOrgId: assignment.supplierOrgId,
      employerName,
      attendance,
      paidHours: ts?.status === 'APPROVED' ? ts.paidHours : shiftPaidHours(shift.startsAt, shift.endsAt, shift.breakMinutes),
      timesheetStatus: ts?.status ?? null,
      documents,
      compliantOnDay: Object.values(documents).every((s) => s === 'VALID'),
    };
  });

  return {
    from: input.from,
    to: input.to,
    rows: out,
    summary: {
      shifts: new Set(out.map((r) => r.shiftId)).size,
      workers: new Set(out.map((r) => r.workerId)).size,
      employers: new Set(out.map((r) => r.employerOrgId)).size,
      nonCompliantOnDay: out.filter((r) => !r.compliantOnDay).length,
    },
  };
}

/** One column per document type that any row requires, in the canonical DocumentType order. */
export function workforceReportCsv(report: WorkforceReport): string {
  const used = new Set(report.rows.flatMap((r) => Object.keys(r.documents)));
  const types = Object.values(DocumentType).filter((t) => used.has(t));
  const header = ['Date', 'Start', 'End', 'Site', 'Shift', 'Role', 'Worker', 'Employer', 'Attendance', 'Paid hours', 'Timesheet', 'Compliant on day', ...types];
  const lines = report.rows.map((r) => [
    r.shiftDate,
    r.startsAt.toISOString(),
    r.endsAt.toISOString(),
    r.siteName,
    r.shiftTitle,
    r.jobRole,
    r.workerName,
    r.employerName,
    r.attendance,
    r.paidHours,
    r.timesheetStatus ?? '',
    r.compliantOnDay ? 'yes' : 'no',
    ...types.map((t) => r.documents[t] ?? ''),
  ]);
  return toCsv([header, ...lines]);
}
