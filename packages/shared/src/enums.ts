/**
 * Domain enums for Merge.
 *
 * These are defined as `const` objects (not TS enums) so they can be used by both
 * the API and the web app without any runtime enum emit, and so the string values
 * are the single source of truth for what is stored in the database.
 */

export const OrgType = {
  /** The organisation that owns and operates the platform. It may also employ its own bank of workers. */
  AGENCY: 'AGENCY',
  /** A care company that joins the network to lend and borrow staff. */
  PROVIDER: 'PROVIDER',
} as const;
export type OrgType = (typeof OrgType)[keyof typeof OrgType];

export const OrgStatus = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
} as const;
export type OrgStatus = (typeof OrgStatus)[keyof typeof OrgStatus];

export const ServiceType = {
  RESIDENTIAL: 'RESIDENTIAL',
  NURSING: 'NURSING',
  DOMICILIARY: 'DOMICILIARY',
  SUPPORTED_LIVING: 'SUPPORTED_LIVING',
  LEARNING_DISABILITY: 'LEARNING_DISABILITY',
  MENTAL_HEALTH: 'MENTAL_HEALTH',
} as const;
export type ServiceType = (typeof ServiceType)[keyof typeof ServiceType];

export const UserRole = {
  /** Agency staff who administer the whole platform. */
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  /** Full control of one organisation (billing, users, settings). */
  ORG_ADMIN: 'ORG_ADMIN',
  /** Day-to-day rota management for one organisation (post shifts, assign workers). */
  ORG_MANAGER: 'ORG_MANAGER',
  /** A care worker with a login; can view and request shifts for themselves when allowed. */
  WORKER: 'WORKER',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const JobRole = {
  CARE_ASSISTANT: 'CARE_ASSISTANT',
  SENIOR_CARER: 'SENIOR_CARER',
  SUPPORT_WORKER: 'SUPPORT_WORKER',
  TEAM_LEADER: 'TEAM_LEADER',
  NURSE: 'NURSE',
  DOMICILIARY_CARER: 'DOMICILIARY_CARER',
  ANCILLARY: 'ANCILLARY',
} as const;
export type JobRole = (typeof JobRole)[keyof typeof JobRole];

export const JOB_ROLE_LABELS: Record<JobRole, string> = {
  CARE_ASSISTANT: 'Care assistant',
  SENIOR_CARER: 'Senior carer',
  SUPPORT_WORKER: 'Support worker',
  TEAM_LEADER: 'Team leader',
  NURSE: 'Registered nurse',
  DOMICILIARY_CARER: 'Domiciliary carer',
  ANCILLARY: 'Ancillary (kitchen / domestic)',
};

/**
 * Which shift roles a worker of a given role is allowed to cover.
 * A nurse may cover a senior carer shift; a care assistant may not cover a nurse shift.
 */
export const ROLE_COVERS: Record<JobRole, readonly JobRole[]> = {
  NURSE: ['NURSE', 'TEAM_LEADER', 'SENIOR_CARER', 'CARE_ASSISTANT', 'SUPPORT_WORKER'],
  TEAM_LEADER: ['TEAM_LEADER', 'SENIOR_CARER', 'CARE_ASSISTANT', 'SUPPORT_WORKER'],
  SENIOR_CARER: ['SENIOR_CARER', 'CARE_ASSISTANT', 'SUPPORT_WORKER'],
  CARE_ASSISTANT: ['CARE_ASSISTANT', 'SUPPORT_WORKER'],
  SUPPORT_WORKER: ['SUPPORT_WORKER', 'CARE_ASSISTANT'],
  DOMICILIARY_CARER: ['DOMICILIARY_CARER', 'CARE_ASSISTANT', 'SUPPORT_WORKER'],
  ANCILLARY: ['ANCILLARY'],
};

export function roleCanCover(workerRole: JobRole, shiftRole: JobRole): boolean {
  return ROLE_COVERS[workerRole].includes(shiftRole);
}

export const Skill = {
  MEDICATION: 'MEDICATION',
  MOVING_AND_HANDLING: 'MOVING_AND_HANDLING',
  DEMENTIA: 'DEMENTIA',
  PEG_FEEDING: 'PEG_FEEDING',
  CATHETER_CARE: 'CATHETER_CARE',
  LEARNING_DISABILITIES: 'LEARNING_DISABILITIES',
  MENTAL_HEALTH: 'MENTAL_HEALTH',
  END_OF_LIFE: 'END_OF_LIFE',
  CHALLENGING_BEHAVIOUR: 'CHALLENGING_BEHAVIOUR',
  EPILEPSY: 'EPILEPSY',
  DIABETES: 'DIABETES',
  HOIST: 'HOIST',
  DRIVER: 'DRIVER',
} as const;
export type Skill = (typeof Skill)[keyof typeof Skill];

export const SKILL_LABELS: Record<Skill, string> = {
  MEDICATION: 'Medication administration',
  MOVING_AND_HANDLING: 'Moving & handling',
  DEMENTIA: 'Dementia care',
  PEG_FEEDING: 'PEG feeding',
  CATHETER_CARE: 'Catheter care',
  LEARNING_DISABILITIES: 'Learning disabilities',
  MENTAL_HEALTH: 'Mental health',
  END_OF_LIFE: 'End of life care',
  CHALLENGING_BEHAVIOUR: 'Challenging behaviour',
  EPILEPSY: 'Epilepsy (incl. rescue meds)',
  DIABETES: 'Diabetes',
  HOIST: 'Hoist use',
  DRIVER: 'Driver (own vehicle)',
};

export const DocumentType = {
  DBS: 'DBS',
  RIGHT_TO_WORK: 'RIGHT_TO_WORK',
  PHOTO_ID: 'PHOTO_ID',
  REFERENCES: 'REFERENCES',
  MANDATORY_TRAINING: 'MANDATORY_TRAINING',
  MOVING_AND_HANDLING_TRAINING: 'MOVING_AND_HANDLING_TRAINING',
  SAFEGUARDING_TRAINING: 'SAFEGUARDING_TRAINING',
  MEDICATION_TRAINING: 'MEDICATION_TRAINING',
  NMC_PIN: 'NMC_PIN',
} as const;
export type DocumentType = (typeof DocumentType)[keyof typeof DocumentType];

export const DOCUMENT_LABELS: Record<DocumentType, string> = {
  DBS: 'Enhanced DBS check',
  RIGHT_TO_WORK: 'Right to work',
  PHOTO_ID: 'Photo ID',
  REFERENCES: 'Employment references',
  MANDATORY_TRAINING: 'Mandatory training / Care Certificate',
  MOVING_AND_HANDLING_TRAINING: 'Moving & handling training',
  SAFEGUARDING_TRAINING: 'Safeguarding training',
  MEDICATION_TRAINING: 'Medication training',
  NMC_PIN: 'NMC PIN',
};

export const DocumentStatus = {
  VALID: 'VALID',
  EXPIRING: 'EXPIRING',
  EXPIRED: 'EXPIRED',
  PENDING_VERIFICATION: 'PENDING_VERIFICATION',
  MISSING: 'MISSING',
} as const;
export type DocumentStatus = (typeof DocumentStatus)[keyof typeof DocumentStatus];

export const ComplianceStatus = {
  COMPLIANT: 'COMPLIANT',
  EXPIRING: 'EXPIRING',
  NON_COMPLIANT: 'NON_COMPLIANT',
} as const;
export type ComplianceStatus = (typeof ComplianceStatus)[keyof typeof ComplianceStatus];

export const WorkerStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  ON_LEAVE: 'ON_LEAVE',
} as const;
export type WorkerStatus = (typeof WorkerStatus)[keyof typeof WorkerStatus];

/**
 * Capacity flags are how an organisation tells the network, at a point in time,
 * that it has more staff than work (SURPLUS) or more work than staff (SHORTAGE).
 *
 * SURPLUS flags drive the priority queue: while a surplus flag is active and
 * unfulfilled, the organisation receives matching shifts before the wider network.
 * SHORTAGE flags let the agency and the network see demand building and let the
 * platform proactively match surplus to shortage.
 */
export const CapacityFlagKind = {
  SURPLUS: 'SURPLUS',
  SHORTAGE: 'SHORTAGE',
} as const;
export type CapacityFlagKind = (typeof CapacityFlagKind)[keyof typeof CapacityFlagKind];

export const CapacityFlagStatus = {
  ACTIVE: 'ACTIVE',
  FULFILLED: 'FULFILLED',
  EXPIRED: 'EXPIRED',
  WITHDRAWN: 'WITHDRAWN',
} as const;
export type CapacityFlagStatus = (typeof CapacityFlagStatus)[keyof typeof CapacityFlagStatus];

export const ShiftStatus = {
  DRAFT: 'DRAFT',
  OPEN: 'OPEN',
  FILLED: 'FILLED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
} as const;
export type ShiftStatus = (typeof ShiftStatus)[keyof typeof ShiftStatus];

export const ShiftVisibility = {
  /** Staged release: priority orgs → agency bank → whole network (default). */
  NETWORK: 'NETWORK',
  /** Only organisations with a matching surplus flag or preferred-partner status. */
  PRIORITY_ONLY: 'PRIORITY_ONLY',
  /** Only the host's preferred partners. */
  PREFERRED_ONLY: 'PREFERRED_ONLY',
  /** Only the platform-owning agency's own bank. */
  AGENCY_ONLY: 'AGENCY_ONLY',
} as const;
export type ShiftVisibility = (typeof ShiftVisibility)[keyof typeof ShiftVisibility];

export const DispatchTier = {
  PRIORITY: 'PRIORITY',
  AGENCY: 'AGENCY',
  NETWORK: 'NETWORK',
} as const;
export type DispatchTier = (typeof DispatchTier)[keyof typeof DispatchTier];

/** Where the platform-owning agency's own worker bank sits in the release order. */
export const AgencyPosition = {
  /** Agency bank sees shifts before anyone else. */
  FIRST: 'FIRST',
  /** Agency bank is released together with priority (surplus-flagged) organisations. */
  WITH_PRIORITY: 'WITH_PRIORITY',
  /** Priority organisations first, then the agency bank, then the network (default). */
  AFTER_PRIORITY: 'AFTER_PRIORITY',
  /** Agency bank is released together with the rest of the network. */
  WITH_NETWORK: 'WITH_NETWORK',
  /** Agency bank is the safety net: only after the whole network has had its window. */
  LAST: 'LAST',
} as const;
export type AgencyPosition = (typeof AgencyPosition)[keyof typeof AgencyPosition];

export const AssignmentStatus = {
  /** Supplier (or worker) has asked to take the shift; host must confirm. */
  REQUESTED: 'REQUESTED',
  /** Host has offered the shift to a specific worker; supplier must accept. */
  OFFERED: 'OFFERED',
  CONFIRMED: 'CONFIRMED',
  DECLINED: 'DECLINED',
  WITHDRAWN: 'WITHDRAWN',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW',
  COMPLETED: 'COMPLETED',
} as const;
export type AssignmentStatus = (typeof AssignmentStatus)[keyof typeof AssignmentStatus];

export const TimesheetStatus = {
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  APPROVED: 'APPROVED',
  DISPUTED: 'DISPUTED',
  REJECTED: 'REJECTED',
} as const;
export type TimesheetStatus = (typeof TimesheetStatus)[keyof typeof TimesheetStatus];

export const InvoiceStatus = {
  DRAFT: 'DRAFT',
  ISSUED: 'ISSUED',
  PAID: 'PAID',
  VOID: 'VOID',
} as const;
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

export const RelationshipKind = {
  PREFERRED: 'PREFERRED',
  BLOCKED: 'BLOCKED',
} as const;
export type RelationshipKind = (typeof RelationshipKind)[keyof typeof RelationshipKind];

export const NotificationType = {
  SHIFT_AVAILABLE: 'SHIFT_AVAILABLE',
  SHIFT_REQUEST: 'SHIFT_REQUEST',
  SHIFT_OFFER: 'SHIFT_OFFER',
  SHIFT_CONFIRMED: 'SHIFT_CONFIRMED',
  SHIFT_DECLINED: 'SHIFT_DECLINED',
  SHIFT_CANCELLED: 'SHIFT_CANCELLED',
  SHIFT_UNFILLED: 'SHIFT_UNFILLED',
  TIMESHEET_SUBMITTED: 'TIMESHEET_SUBMITTED',
  TIMESHEET_APPROVED: 'TIMESHEET_APPROVED',
  TIMESHEET_DISPUTED: 'TIMESHEET_DISPUTED',
  DOCUMENT_EXPIRING: 'DOCUMENT_EXPIRING',
  FLAG_FULFILLED: 'FLAG_FULFILLED',
  /** A surplus flag ran out without being withdrawn or fulfilled (DSP-03). */
  FLAG_EXPIRED: 'FLAG_EXPIRED',
  INVOICE_ISSUED: 'INVOICE_ISSUED',
  SYSTEM: 'SYSTEM',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

export const AuditAction = {
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  PUBLISH: 'PUBLISH',
  CANCEL: 'CANCEL',
  REQUEST: 'REQUEST',
  OFFER: 'OFFER',
  CONFIRM: 'CONFIRM',
  DECLINE: 'DECLINE',
  WITHDRAW: 'WITHDRAW',
  APPROVE: 'APPROVE',
  DISPUTE: 'DISPUTE',
  LOGIN: 'LOGIN',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];
