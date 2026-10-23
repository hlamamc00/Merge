import type {
  AssignmentStatus,
  CapacityFlagKind,
  CapacityFlagStatus,
  ComplianceStatus,
  DispatchTier,
  DocumentStatus,
  DocumentType,
  InvoiceStatus,
  JobRole,
  NotificationType,
  OrgStatus,
  OrgType,
  RelationshipKind,
  ServiceType,
  ShiftStatus,
  ShiftVisibility,
  Skill,
  TimesheetStatus,
  UserRole,
  WorkerStatus,
} from '@merge/shared';

export interface User {
  id: string;
  orgId: string;
  workerId: string | null;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface Organisation {
  id: string;
  name: string;
  type: OrgType;
  status: OrgStatus;
  serviceTypes: ServiceType[];
  cqcRegistrationNumber?: string | null;
  email?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  postcode?: string | null;
  lat?: number | null;
  lng?: number | null;
  defaultChargeRate?: number | null;
  workerSelfServiceAllowed?: boolean;
}

export interface PlatformInfo {
  name: string;
  ownerOrgId: string | null;
  currency: string;
  platformFeePct: number;
  priorityWindowMinutes: number;
  agencyWindowMinutes: number;
  agencyPosition: string;
  urgentThresholdMinutes: number;
  lateCancellationHours: number;
}

export interface Me {
  user: User;
  organisation: Organisation;
  worker: Worker | null;
  platform: PlatformInfo;
}

export interface Site {
  id: string;
  orgId?: string;
  name: string;
  serviceType: ServiceType | null;
  addressLine1: string | null;
  city: string | null;
  postcode: string;
  lat: number | null;
  lng: number | null;
  accessNotes: string | null;
}

export interface Worker {
  id: string;
  orgId: string;
  userId: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  jobRole: JobRole;
  skills: Skill[];
  status: WorkerStatus;
  shareable: boolean;
  contractedHoursPerWeek: number | null;
  maxHoursPerWeek: number | null;
  optedOutOf48h: boolean;
  postcode: string | null;
  lat: number | null;
  lng: number | null;
  travelRadiusKm: number | null;
  hourlyPayRate?: number | null;
  notes?: string | null;
  /** Decision 18: set once the personal data has been erased (the row stays as "Former Worker"). */
  erasedAt?: string | null;
  createdAt: string;
}

export interface ComplianceItem {
  type: DocumentType;
  status: DocumentStatus;
  expiresAt: string | null;
}

export interface ComplianceSummary {
  status: ComplianceStatus;
  items: ComplianceItem[];
}

export interface WorkerListItem extends Worker {
  compliance: ComplianceSummary;
}

export interface WorkerDocument {
  id: string;
  workerId: string;
  type: DocumentType;
  reference: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  fileUrl: string | null;
  verifiedAt: string | null;
  verifiedByUserId: string | null;
  notes: string | null;
  createdAt: string;
}

export interface Unavailability {
  id: string;
  workerId: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
}

/** Decision 8: where the "hours with the employer" figure for a week comes from. */
export type WeekHoursSource = 'RECORDED' | 'FLAG' | 'CONTRACT';

/** One ISO week of a worker's hours with their own employer, as GET /workers/:id/weeks returns it. */
export interface WorkerWeek {
  /** Monday 00:00 Europe/London, ISO instant. */
  weekStart: string;
  /** The figure eligibility counts against the 48h limit for that week. */
  internalHours: number;
  contractedHoursPerWeek: number | null;
  source: WeekHoursSource;
  note: string | null;
  sourceFlagId: string | null;
}

export interface WorkerDetail extends Worker {
  compliance: ComplianceSummary;
  documents: WorkerDocument[];
  unavailability: Unavailability[];
  upcoming: { assignment: Assignment; shift: Shift }[];
  averageRating: number | null;
  login: { id: string; email: string; status: string } | null;
}

export interface CapacityFlag {
  id: string;
  orgId: string;
  orgName?: string;
  kind: CapacityFlagKind;
  jobRole: JobRole | null;
  headcount: number;
  hoursRequested: number;
  hoursFilled: number;
  hoursRemaining: number;
  startsAt: string;
  endsAt: string;
  siteId: string | null;
  postcodeAreas: string[] | null;
  radiusKm: number | null;
  note: string | null;
  status: CapacityFlagStatus;
  createdAt: string;
  /** Staff a surplus flag named as free for the period (decision 8). */
  releasedWorkers?: number;
}

export interface NetworkCapacity {
  summary: { jobRole: JobRole | 'ANY'; surplusHoursRemaining: number; surplusOrgs: number; shortageHoursRemaining: number; shortageOrgs: number }[];
  flags?: CapacityFlag[];
}

export interface Shift {
  id: string;
  hostOrgId: string;
  siteId: string;
  jobRole: JobRole;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  breakMinutes: number;
  headcount: number;
  filledCount: number;
  requiredSkills: Skill[];
  extraRequiredDocuments: DocumentType[];
  /** null for worker logins: they are paid by their employer, not at this rate. */
  chargeRate: number | null;
  currency: string;
  visibility: ShiftVisibility;
  priorityWindowMinutesOverride: number | null;
  autoConfirm: boolean;
  status: ShiftStatus;
  urgent: boolean;
  publishedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  paidHours?: number;
  placesLeft?: number;
}

export interface Access {
  tier?: DispatchTier;
  opensAt?: string;
  open: boolean;
  reason?: string;
  matchedFlagId?: string | null;
}

export interface Assignment {
  id: string;
  shiftId: string;
  workerId: string;
  supplierOrgId: string;
  status: AssignmentStatus;
  tierAtRequest: DispatchTier | null;
  matchedFlagId: string | null;
  requestedAt: string;
  respondedAt: string | null;
  cancelledAt: string | null;
  cancelledByOrgId: string | null;
  cancellationReason: string | null;
  lateCancellation: boolean;
  hoursOverride: boolean;
  note: string | null;
}

export interface WorkerSummary {
  id: string;
  firstName: string;
  lastName: string;
  jobRole: JobRole;
  skills?: Skill[];
}

export interface AvailableShift extends Shift {
  site: Site;
  hostName: string;
  access: Access;
  myAssignments: Assignment[];
}

export interface PostedShift extends Shift {
  site: Site;
  pendingRequests: number;
  confirmed: number;
}

export interface SuppliedShift extends Shift {
  site: Site;
  hostName: string;
  assignment: Assignment;
  worker: WorkerSummary;
}

export interface AllShift extends Shift {
  site: Site;
  hostName: string;
}

export interface PlanEntry {
  orgId: string;
  orgName?: string;
  orgType?: OrgType;
  tier: DispatchTier;
  opensAt: string;
  rank: number;
  reason: string;
  matchedFlagId?: string | null;
  notifiedAt?: string | null;
  distanceKm?: number;
}

export interface DispatchPreview {
  persisted: boolean;
  urgent: boolean;
  stages?: { tier: DispatchTier; opensAt: string }[];
  entries: PlanEntry[];
  excluded?: { orgId: string; orgName?: string; reason: string }[];
}

export interface ShiftDetail extends Shift {
  site: Site;
  hostName: string;
  /** The viewer's own organisation posted the shift. */
  isHost: boolean;
  /** Host or platform admin: may see the full plan and all assignments and act for the host. */
  canManage: boolean;
  access: Access | null;
  plan?: PlanEntry[];
  assignments: (Assignment & { supplierName: string; worker: WorkerSummary })[];
}

export interface EligibilityIssue {
  code: string;
  message: string;
}

export interface EligibleWorker extends WorkerSummary {
  shareable: boolean;
  alreadyRequested: boolean;
  eligible: boolean;
  blockers: EligibilityIssue[];
  warnings: EligibilityIssue[];
  facts: { shiftHours: number; weeklyHoursAfter: number; restGapHours: number | null; distanceKm: number | null };
}

export interface Candidate extends WorkerSummary {
  orgId: string;
  orgName: string;
  tier?: DispatchTier;
  distanceKm: number | null;
  warnings: EligibilityIssue[];
  previousShiftsWithYou: number;
  yourAverageRating: number | null;
}

export interface AssignmentListItem extends Assignment {
  supplierName: string;
  worker: WorkerSummary;
  shift: { id: string; title: string; jobRole: JobRole; startsAt: string; endsAt: string; chargeRate: number | null; status: ShiftStatus; hostOrgId: string; siteName: string };
}

export interface Timesheet {
  id: string;
  assignmentId: string;
  shiftId: string;
  workerId: string;
  hostOrgId: string;
  supplierOrgId: string;
  clockInAt: string | null;
  clockOutAt: string | null;
  breakMinutes: number;
  paidHours: number;
  /** null for worker logins: they are paid by their employer, not at this rate. */
  chargeRate: number | null;
  platformFeePct: number;
  hostCost: number;
  platformFee: number;
  supplierAmount: number;
  status: TimesheetStatus;
  submittedAt: string | null;
  approvedAt: string | null;
  disputedAt: string | null;
  disputeReason: string | null;
  notes: string | null;
  invoiceId: string | null;
}

export interface TimesheetListItem extends Timesheet {
  hostName: string;
  supplierName: string;
  worker: WorkerSummary;
  shift: { id: string; title: string; jobRole: JobRole; startsAt: string; endsAt: string; breakMinutes: number };
}

export interface Invoice {
  id: string;
  number: string;
  hostOrgId: string;
  supplierOrgId: string;
  hostName?: string;
  supplierName?: string;
  periodStart: string;
  periodEnd: string;
  status: InvoiceStatus;
  currency: string;
  totalHours: number;
  subtotal: number;
  platformFee: number;
  supplierAmount: number;
  issuedAt: string | null;
  paidAt: string | null;
}

export interface InvoiceDetail extends Invoice {
  lines: (Timesheet & { shift: { id: string; title: string; jobRole: JobRole; startsAt: string; endsAt: string }; worker: { id: string; firstName: string; lastName: string } })[];
}

export interface Notification {
  id: string;
  orgId: string;
  userId: string | null;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

export interface Relationship {
  id: string;
  otherOrgId: string;
  otherOrgName: string;
  kind: RelationshipKind;
  note: string | null;
  createdAt: string;
}

export interface DirectoryOrg {
  id: string;
  name: string;
  type: OrgType;
  serviceTypes: ServiceType[];
  city: string | null;
  postcode: string | null;
  status: OrgStatus;
}

export interface OrgStats {
  periodDays: number;
  shiftsPosted: number;
  shiftsOpen: number;
  fillRatePct: number | null;
  shiftsSupplied: number;
  hoursSupplied: number;
  approvedSpend: number;
  approvedEarnings: number;
  timesheetsAwaitingApproval: number;
  lateCancellations: number;
}

export interface AdminOverview {
  organisations: { total: number; active: number };
  workers: { total: number; shareable: number };
  shifts: { open: number; postedLast30d: number; fillRatePct: number | null; urgentLast30d: number };
  capacity: { surplusHours: number; shortageHours: number; surplusOrgs: number; shortageOrgs: number };
  bookings: { confirmedLast30d: number; lateCancellationsLast30d: number; noShowsLast30d: number };
  money: { approvedChargeLast30d: number; platformFeeLast30d: number; timesheetsAwaitingApproval: number };
}

export interface PlatformSettings {
  id: string;
  platformName: string;
  ownerOrgId: string | null;
  priorityWindowMinutes: number;
  agencyWindowMinutes: number;
  agencyPosition: string;
  urgentThresholdMinutes: number;
  minLeadBeforeStartMinutes: number;
  preferredPartnersGetPriority: boolean;
  platformFeePct: number;
  currency: string;
  minRestHours: number;
  maxWeeklyHours: number;
  maxShiftHours: number;
  lateCancellationHours: number;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  actorUserId: string | null;
  actorOrgId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}
