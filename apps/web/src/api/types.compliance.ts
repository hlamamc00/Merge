/** Types for the compliance, security and organisation-structure features (area C). */
import type { DocumentStatus, DocumentType, JobRole, UserRole } from '@merge/shared';
import type { AuditEntry, Organisation, User, WorkerDocument } from './types';

export interface SecurityState {
  twoFactorSetupRequired: boolean;
  passwordChangeRequired: boolean;
}

export interface UserWithSecurity extends User {
  twoFactorEnabled?: boolean;
  mustChangePassword?: boolean;
  siteIds?: string[] | null;
  phone?: string | null;
}

export interface LoginResponse {
  token?: string;
  twoFactorRequired?: boolean;
  challengeToken?: string;
}

export interface TwoFactorSetup {
  secret: string;
  otpauthUrl: string;
}

export interface MouSection {
  heading: string;
  body: string;
}

export interface MouDocument {
  version: string;
  title: string;
  summary: string;
  sections: MouSection[];
  text: string;
}

export interface ApprovalStatus {
  status: string;
  blockers: string[];
  mouAcceptedAt: string | null;
  mouVersion: string | null;
  currentMouVersion: string;
  cqcRegistrationNumber: string | null;
}

export interface OrganisationWithCompliance extends Organisation {
  mouAcceptedAt?: string | null;
  mouVersion?: string | null;
  escalationMode?: 'MANUAL' | 'AUTO';
  escalationCeilingPct?: number;
  suspendedReason?: string | null;
  creditHold?: boolean;
  priorityPenaltyUntil?: string | null;
  createdAt?: string;
}

export interface AdminOrganisation extends OrganisationWithCompliance {
  blockers: string[];
  workerCount: number;
  admin: { id: string; name: string; email: string } | null;
}

export interface AdminUser {
  id: string;
  orgId: string;
  orgName: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  status: string;
  twoFactorEnabled: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
}

export interface AuditEntryWithActor extends AuditEntry {
  actor: { id: string; firstName: string; lastName: string; email: string } | null;
}

export interface DocumentWithFile extends WorkerDocument {
  hasFile: boolean;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  uploadedByUserId: string | null;
  replacesDocumentId: string | null;
  supersededAt: string | null;
}

export interface WorkerRef {
  id: string;
  firstName: string;
  lastName: string;
  jobRole: JobRole;
  homeSiteId: string | null;
  homeSiteName?: string | null;
  status: string;
}

export interface ExpiringDocument {
  document: DocumentWithFile;
  worker: WorkerRef;
  daysLeft: number;
  status: DocumentStatus;
}

export interface QueuedDocument {
  document: DocumentWithFile;
  worker: WorkerRef;
  uploadedBy: { id: string; name: string; role: UserRole } | null;
  replacesDocumentId: string | null;
}

export interface ComplianceOverview {
  workers: { total: number; compliant: number; expiring: number; nonCompliant: number };
  documents: { expiringIn30Days: number; expired: number; awaitingVerification: number };
  hostRequirements: number;
  asOf: string;
}

export interface HostRequirement {
  id: string;
  hostOrgId: string;
  hostName?: string;
  name: string;
  description: string | null;
  recordedByHost: boolean;
  createdAt: string;
  archivedAt: string | null;
  holders?: number;
  own?: boolean;
}

export interface WorkerHostRequirement {
  requirementId: string;
  name: string;
  description: string | null;
  hostOrgId: string;
  hostName: string;
  recordedByHost: boolean;
  expiresAt: string | null;
  documentId: string | null;
  recordedAt: string;
  archivedAt: string | null;
  expired: boolean;
}

export interface RequirementHolder {
  workerId: string;
  firstName: string;
  lastName: string;
  jobRole: JobRole;
  orgId: string;
  orgName: string;
  expiresAt: string | null;
  recordedAt: string;
  expired: boolean;
}

export interface MyDocuments {
  workerId: string;
  jobRole: JobRole;
  homeSiteName: string | null;
  documents: DocumentWithFile[];
  hostRequirements: WorkerHostRequirement[];
}

export type { DocumentType };

/** One booked worker on one shift, with each mandatory check as it stood on the day (REP-01, decision 13: status only). */
export interface WorkforceRow {
  shiftId: string;
  siteId: string;
  siteName: string;
  shiftDate: string;
  startsAt: string;
  endsAt: string;
  jobRole: JobRole;
  shiftTitle: string;
  workerId: string;
  workerName: string;
  employerOrgId: string;
  employerName: string;
  attendance: 'COMPLETED' | 'NO_SHOW' | 'CONFIRMED' | 'CANCELLED';
  paidHours: number;
  timesheetStatus: string | null;
  documents: Partial<Record<DocumentType, 'VALID' | 'EXPIRED' | 'UNVERIFIED' | 'MISSING'>>;
  compliantOnDay: boolean;
}

export interface WorkforceReport {
  orgId: string;
  siteId: string | null;
  from: string;
  to: string;
  rows: WorkforceRow[];
  summary: { shifts: number; workers: number; employers: number; nonCompliantOnDay: number };
}
