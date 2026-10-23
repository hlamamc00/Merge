/** Types for the dispatch and trust features (floor rate, escalation, reliability, bars, reports, series). */
import type { AvailableShift, Candidate, EligibilityIssue, PostedShift, ShiftDetail } from './types';

export type ComplianceStatus = 'COMPLIANT' | 'EXPIRING' | 'NON_COMPLIANT';

export interface FloorRate {
  floor: number;
  basis: { nationalMinimumWage: number; employerOnCostPct: number; platformFeePct: number; formula: string };
}

export interface Reliability {
  orgId: string;
  orgName?: string;
  windowDays: number;
  noShows: number;
  lateCancellations: number;
  confirmedOrCompleted: number;
  score: number;
  priorityPenaltyUntil: string | null;
  status: string;
}

export interface EscalationEvent {
  at: string;
  mode: 'AUTO' | 'MANUAL';
  step: number;
  previousRate: number;
  newRate: number;
  opened: boolean;
}

export interface EscalationInfo {
  mode: 'AUTO' | 'MANUAL';
  ceilingPct: number;
  ceilingRate: number;
  originalChargeRate: number;
  step: number;
  stepDue: number;
  lastEscalatedAt: string | null;
  suggestedRaisePct: number;
  history: EscalationEvent[];
}

export interface Eligibility {
  eligible: boolean;
  blockers: EligibilityIssue[];
  warnings: EligibilityIssue[];
}

/** A board row: distance from the viewer, and (for worker logins) whether they can take it. */
export interface BoardShift extends AvailableShift {
  distanceKm: number | null;
  eligible?: boolean;
  blockers?: EligibilityIssue[];
  warnings?: EligibilityIssue[];
}

export interface ShiftDetailPlus extends Omit<ShiftDetail, 'assignments'> {
  assignments: (ShiftDetail['assignments'][number] & { complianceStatus?: ComplianceStatus })[];
  distanceKm?: number | null;
  myEligibility?: Eligibility;
  floor?: number;
  escalation?: EscalationInfo;
  originalChargeRate?: number | null;
  escalationStep?: number;
  seriesId?: string | null;
  requiredHostRequirementIds?: string[];
}

export interface CandidatePlus extends Candidate {
  complianceStatus: ComplianceStatus;
  reliability: Reliability;
}

export interface PostedShiftPlus extends PostedShift {
  escalationDue: boolean;
  seriesId: string | null;
}

export interface EscalateResponse {
  id: string;
  chargeRate: number;
  previousRate: number;
  newRate: number;
  opened: boolean;
  step: number;
  floor: number;
}

export interface BulkResult {
  results: { id: string; ok: boolean; status?: string; error?: string }[];
}

export interface HostRequirement {
  id: string;
  name: string;
  description: string | null;
  recordedByHost: boolean;
}

export interface SeriesPattern {
  startTime: string;
  durationHours: number;
  weekdays: number[];
  from: string;
  to: string;
}

export interface SeriesResponse {
  seriesId: string;
  count: number;
  shifts: { id: string; startsAt: string; status: string }[];
}

export interface WorkerBar {
  id: string;
  hostOrgId: string;
  workerId: string;
  siteId: string | null;
  reason: string | null;
  shared: boolean;
  role: 'host' | 'employer';
  hostName: string;
  siteName: string | null;
  createdAt: string;
  liftedAt: string | null;
  worker: { id: string; firstName: string; lastName: string; jobRole: string; orgId: string };
}

export type ReportCategory = 'SAFEGUARDING' | 'CONDUCT' | 'ATTENDANCE' | 'COMPETENCE' | 'OTHER';

export interface WorkerReport {
  id: string;
  hostOrgId: string;
  supplierOrgId: string;
  workerId: string;
  assignmentId: string | null;
  category: ReportCategory;
  description: string;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'CLOSED';
  employerResponse: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
  closedAt: string | null;
  hostName: string;
  supplierName: string;
  raisedBy?: string | null;
  worker: { id: string; firstName: string; lastName: string; jobRole: string; orgId: string };
}

export const REPORT_CATEGORY_LABELS: Record<ReportCategory, string> = {
  SAFEGUARDING: 'Safeguarding',
  CONDUCT: 'Conduct',
  ATTENDANCE: 'Attendance',
  COMPETENCE: 'Competence',
  OTHER: 'Other',
};
