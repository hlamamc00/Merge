/**
 * Merge database schema (Drizzle ORM, SQLite dialect).
 *
 * The schema is deliberately plain so it can be ported to Postgres by swapping the
 * column builders; timestamps are stored as epoch milliseconds, JSON as text.
 */
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  AgencyPosition,
  AssignmentStatus,
  AuditAction,
  CapacityFlagKind,
  CapacityFlagStatus,
  DispatchTier,
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

const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });
const bool = (name: string) => integer(name, { mode: 'boolean' });
const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>();

export const platformSettings = sqliteTable('platform_settings', {
  id: text('id').primaryKey(), // always 'default'
  platformName: text('platform_name').notNull().default('Merge'),
  ownerOrgId: text('owner_org_id'),
  priorityWindowMinutes: integer('priority_window_minutes').notNull().default(120),
  agencyWindowMinutes: integer('agency_window_minutes').notNull().default(60),
  agencyPosition: text('agency_position').$type<AgencyPosition>().notNull().default('AFTER_PRIORITY'),
  urgentThresholdMinutes: integer('urgent_threshold_minutes').notNull().default(720),
  minLeadBeforeStartMinutes: integer('min_lead_before_start_minutes').notNull().default(60),
  preferredPartnersGetPriority: bool('preferred_partners_get_priority').notNull().default(true),
  platformFeePct: real('platform_fee_pct').notNull().default(8),
  currency: text('currency').notNull().default('GBP'),
  minRestHours: real('min_rest_hours').notNull().default(11),
  maxWeeklyHours: real('max_weekly_hours').notNull().default(48),
  maxShiftHours: real('max_shift_hours').notNull().default(14),
  /** Cancelling a confirmed assignment inside this many hours of the start counts as a late cancellation. */
  lateCancellationHours: real('late_cancellation_hours').notNull().default(24),
  /** Decision 3: floor charge = minimum wage × (1 + on-cost %) ÷ (1 − platform fee %). */
  nationalMinimumWage: real('national_minimum_wage').notNull().default(12.71),
  employerOnCostPct: real('employer_on_cost_pct').notNull().default(25),
  /** Decision 4: repeated no-shows by an employer's workers. */
  noShowWindowDays: integer('no_show_window_days').notNull().default(90),
  noShowPriorityPenaltyThreshold: integer('no_show_priority_penalty_threshold').notNull().default(2),
  noShowPriorityPenaltyDays: integer('no_show_priority_penalty_days').notNull().default(30),
  noShowSuspensionThreshold: integer('no_show_suspension_threshold').notNull().default(3),
  /** Decision 7: remind the operator about an unanswered request. */
  requestReminderHours: real('request_reminder_hours').notNull().default(12),
  requestReminderBeforeStartHours: real('request_reminder_before_start_hours').notNull().default(24),
  /** Decision 18. */
  documentRetentionYears: integer('document_retention_years').notNull().default(6),
  /** Decision 12: the memorandum of understanding every organisation accepts. */
  mouVersion: text('mou_version').notNull().default('1.0'),
  /** Decision 16. */
  twoFactorRequiredForManagers: bool('two_factor_required_for_managers').notNull().default(true),
  /** Decision 6 default for new hosts. */
  defaultEscalationMode: text('default_escalation_mode').$type<'MANUAL' | 'AUTO'>().notNull().default('MANUAL'),
  updatedAt: ts('updated_at').notNull(),
});

export const organisations = sqliteTable('organisations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').$type<OrgType>().notNull(),
  status: text('status').$type<OrgStatus>().notNull().default('ACTIVE'),
  serviceTypes: json<ServiceType[]>('service_types').notNull().default([]),
  cqcRegistrationNumber: text('cqc_registration_number'),
  email: text('email'),
  phone: text('phone'),
  addressLine1: text('address_line_1'),
  city: text('city'),
  postcode: text('postcode'),
  lat: real('lat'),
  lng: real('lng'),
  /** Suggested hourly charge rate when posting shifts. */
  defaultChargeRate: real('default_charge_rate'),
  /** Whether this organisation lets its own workers request shifts themselves (rather than a manager assigning). */
  workerSelfServiceAllowed: bool('worker_self_service_allowed').notNull().default(false),
  /** Decision 12: MOU acceptance recorded at registration. */
  mouAcceptedAt: ts('mou_accepted_at'),
  mouVersion: text('mou_version'),
  mouAcceptedByUserId: text('mou_accepted_by_user_id'),
  /** Decision 6: how this host handles shifts still open close to their start. */
  escalationMode: text('escalation_mode').$type<'MANUAL' | 'AUTO'>().notNull().default('MANUAL'),
  /** Maximum automatic uplift on the charge rate, as a percentage of the original rate. */
  escalationCeilingPct: real('escalation_ceiling_pct').notNull().default(20),
  /** Decision 4: priority access removed until this time after repeated no-shows. */
  priorityPenaltyUntil: ts('priority_penalty_until'),
  suspendedReason: text('suspended_reason'),
  /** Decision 1: hosts overdue on platform invoices cannot post until cleared. */
  creditHold: bool('credit_hold').notNull().default(false),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
});

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organisations.id),
    workerId: text('worker_id'),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    role: text('role').$type<UserRole>().notNull(),
    status: text('status').notNull().default('ACTIVE'),
    /** Decision 10: a manager limited to these sites; null = every site of the organisation. */
    siteIds: json<string[]>('site_ids'),
    phone: text('phone'),
    mustChangePassword: bool('must_change_password').notNull().default(false),
    /** Decision 16: authenticator-app two-factor. */
    totpSecret: text('totp_secret'),
    totpEnabledAt: ts('totp_enabled_at'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: ts('locked_until'),
    lastLoginAt: ts('last_login_at'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => ({ emailIdx: uniqueIndex('users_email_idx').on(t.email), orgIdx: index('users_org_idx').on(t.orgId) }),
);

export const sites = sqliteTable(
  'sites',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organisations.id),
    name: text('name').notNull(),
    serviceType: text('service_type').$type<ServiceType>(),
    addressLine1: text('address_line_1'),
    city: text('city'),
    postcode: text('postcode').notNull(),
    lat: real('lat'),
    lng: real('lng'),
    accessNotes: text('access_notes'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => ({ orgIdx: index('sites_org_idx').on(t.orgId) }),
);

export const orgRelationships = sqliteTable(
  'org_relationships',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organisations.id),
    otherOrgId: text('other_org_id').notNull().references(() => organisations.id),
    kind: text('kind').$type<RelationshipKind>().notNull(),
    note: text('note'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => ({ pairIdx: uniqueIndex('org_relationships_pair_idx').on(t.orgId, t.otherOrgId) }),
);

export const workers = sqliteTable(
  'workers',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organisations.id),
    userId: text('user_id'),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    email: text('email'),
    phone: text('phone'),
    jobRole: text('job_role').$type<JobRole>().notNull(),
    skills: json<Skill[]>('skills').notNull().default([]),
    status: text('status').$type<WorkerStatus>().notNull().default('ACTIVE'),
    shareable: bool('shareable').notNull().default(true),
    contractedHoursPerWeek: real('contracted_hours_per_week'),
    maxHoursPerWeek: real('max_hours_per_week'),
    optedOutOf48h: bool('opted_out_of_48h').notNull().default(false),
    postcode: text('postcode'),
    lat: real('lat'),
    lng: real('lng'),
    travelRadiusKm: real('travel_radius_km'),
    /** Private to the employer: what the employer pays the worker. Never exposed to other organisations. */
    hourlyPayRate: real('hourly_pay_rate'),
    notes: text('notes'),
    /** Decision 10: the site this worker is based at. */
    homeSiteId: text('home_site_id'),
    /** Decision 14 / data protection: consent to be shown to other organisations. */
    consentToShareAt: ts('consent_to_share_at'),
    /** Decision 18: personal data erased (GDPR); the row stays so financial and safety records keep their links. */
    erasedAt: ts('erased_at'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => ({ orgIdx: index('workers_org_idx').on(t.orgId), homeSiteIdx: index('workers_home_site_idx').on(t.homeSiteId) }),
);

export const workerDocuments = sqliteTable(
  'worker_documents',
  {
    id: text('id').primaryKey(),
    workerId: text('worker_id').notNull().references(() => workers.id),
    type: text('type').$type<DocumentType>().notNull(),
    reference: text('reference'),
    issuedAt: ts('issued_at'),
    expiresAt: ts('expires_at'),
    fileUrl: text('file_url'),
    verifiedAt: ts('verified_at'),
    verifiedByUserId: text('verified_by_user_id'),
    notes: text('notes'),
    /** Uploaded file (decision 18): key in the storage adapter. */
    fileKey: text('file_key'),
    fileName: text('file_name'),
    mimeType: text('mime_type'),
    fileSize: integer('file_size'),
    uploadedByUserId: text('uploaded_by_user_id'),
    /** Verified documents are immutable: a correction creates a new row that replaces the old one. */
    replacesDocumentId: text('replaces_document_id'),
    supersededAt: ts('superseded_at'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => ({ workerIdx: index('worker_documents_worker_idx').on(t.workerId) }),
);

export const workerUnavailability = sqliteTable(
  'worker_unavailability',
  {
    id: text('id').primaryKey(),
    workerId: text('worker_id').notNull().references(() => workers.id),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    reason: text('reason'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => ({ workerIdx: index('worker_unavailability_worker_idx').on(t.workerId) }),
);

/**
 * Decision 8: the hours a worker is actually rostered for by their own employer in one ISO week.
 * Absent a row, eligibility assumes the full contracted hours; a row (recorded by hand or by a
 * surplus flag naming the worker) replaces that assumption for the week.
 */
export const workerWeekHours = sqliteTable(
  'worker_week_hours',
  {
    id: text('id').primaryKey(),
    workerId: text('worker_id').notNull().references(() => workers.id),
    /** Monday 00:00 Europe/London of the week (startOfIsoWeek), as an instant. */
    weekStart: ts('week_start').notNull(),
    internalHours: real('internal_hours').notNull(),
    note: text('note'),
    /** Set when a surplus flag created the row, so withdrawing the flag can undo it. */
    sourceFlagId: text('source_flag_id'),
    setByUserId: text('set_by_user_id'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => ({ pairIdx: uniqueIndex('worker_week_hours_pair_idx').on(t.workerId, t.weekStart), flagIdx: index('worker_week_hours_flag_idx').on(t.sourceFlagId) }),
);

export const capacityFlags = sqliteTable(
  'capacity_flags',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organisations.id),
    kind: text('kind').$type<CapacityFlagKind>().notNull(),
    jobRole: text('job_role').$type<JobRole>(),
    headcount: integer('headcount').notNull().default(1),
    hoursRequested: real('hours_requested').notNull(),
    hoursFilled: real('hours_filled').notNull().default(0),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    siteId: text('site_id'),
    postcodeAreas: json<string[]>('postcode_areas'),
    radiusKm: real('radius_km'),
    note: text('note'),
    status: text('status').$type<CapacityFlagStatus>().notNull().default('ACTIVE'),
    createdByUserId: text('created_by_user_id'),
    closedAt: ts('closed_at'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => ({ orgIdx: index('capacity_flags_org_idx').on(t.orgId), statusIdx: index('capacity_flags_status_idx').on(t.status, t.kind) }),
);

export const shifts = sqliteTable(
  'shifts',
  {
    id: text('id').primaryKey(),
    hostOrgId: text('host_org_id').notNull().references(() => organisations.id),
    siteId: text('site_id').notNull().references(() => sites.id),
    jobRole: text('job_role').$type<JobRole>().notNull(),
    title: text('title').notNull(),
    description: text('description'),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    breakMinutes: integer('break_minutes').notNull().default(0),
    headcount: integer('headcount').notNull().default(1),
    filledCount: integer('filled_count').notNull().default(0),
    requiredSkills: json<Skill[]>('required_skills').notNull().default([]),
    extraRequiredDocuments: json<DocumentType[]>('extra_required_documents').notNull().default([]),
    chargeRate: real('charge_rate').notNull(),
    currency: text('currency').notNull().default('GBP'),
    visibility: text('visibility').$type<ShiftVisibility>().notNull().default('NETWORK'),
    priorityWindowMinutesOverride: integer('priority_window_minutes_override'),
    /** First eligible request is confirmed automatically. */
    autoConfirm: bool('auto_confirm').notNull().default(false),
    /** Decision 6: automatic escalation state. */
    originalChargeRate: real('original_charge_rate'),
    escalationStep: integer('escalation_step').notNull().default(0),
    lastEscalatedAt: ts('last_escalated_at'),
    /** Recurring posting: shifts created together share a series. */
    seriesId: text('series_id'),
    /** Decision 11: host-specific requirements (ids in host_requirements) a worker must hold. */
    requiredHostRequirementIds: json<string[]>('required_host_requirement_ids').notNull().default([]),
    status: text('status').$type<ShiftStatus>().notNull().default('DRAFT'),
    urgent: bool('urgent').notNull().default(false),
    publishedAt: ts('published_at'),
    cancelledAt: ts('cancelled_at'),
    cancellationReason: text('cancellation_reason'),
    createdByUserId: text('created_by_user_id'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => ({
    hostIdx: index('shifts_host_idx').on(t.hostOrgId),
    statusIdx: index('shifts_status_idx').on(t.status, t.startsAt),
  }),
);

/** The persisted dispatch plan: one row per organisation that can see the shift, and from when. */
export const shiftAccess = sqliteTable(
  'shift_access',
  {
    id: text('id').primaryKey(),
    shiftId: text('shift_id').notNull().references(() => shifts.id),
    orgId: text('org_id').notNull().references(() => organisations.id),
    tier: text('tier').$type<DispatchTier>().notNull(),
    opensAt: ts('opens_at').notNull(),
    rank: integer('rank').notNull(),
    reason: text('reason').notNull(),
    matchedFlagId: text('matched_flag_id'),
    notifiedAt: ts('notified_at'),
  },
  (t) => ({
    pairIdx: uniqueIndex('shift_access_pair_idx').on(t.shiftId, t.orgId),
    orgIdx: index('shift_access_org_idx').on(t.orgId, t.opensAt),
    openIdx: index('shift_access_open_idx').on(t.opensAt, t.notifiedAt),
  }),
);

export const shiftAssignments = sqliteTable(
  'shift_assignments',
  {
    id: text('id').primaryKey(),
    shiftId: text('shift_id').notNull().references(() => shifts.id),
    workerId: text('worker_id').notNull().references(() => workers.id),
    supplierOrgId: text('supplier_org_id').notNull().references(() => organisations.id),
    status: text('status').$type<AssignmentStatus>().notNull(),
    tierAtRequest: text('tier_at_request').$type<DispatchTier>(),
    matchedFlagId: text('matched_flag_id'),
    requestedByUserId: text('requested_by_user_id'),
    respondedByUserId: text('responded_by_user_id'),
    requestedAt: ts('requested_at').notNull(),
    respondedAt: ts('responded_at'),
    cancelledAt: ts('cancelled_at'),
    cancelledByOrgId: text('cancelled_by_org_id'),
    cancellationReason: text('cancellation_reason'),
    lateCancellation: bool('late_cancellation').notNull().default(false),
    hoursOverride: bool('hours_override').notNull().default(false),
    note: text('note'),
    /** Decision 7: when the operator was reminded that this request is still unanswered. */
    operatorRemindedAt: ts('operator_reminded_at'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => ({
    shiftIdx: index('shift_assignments_shift_idx').on(t.shiftId),
    workerIdx: index('shift_assignments_worker_idx').on(t.workerId),
    supplierIdx: index('shift_assignments_supplier_idx').on(t.supplierOrgId),
  }),
);

export const timesheets = sqliteTable(
  'timesheets',
  {
    id: text('id').primaryKey(),
    assignmentId: text('assignment_id').notNull().references(() => shiftAssignments.id),
    shiftId: text('shift_id').notNull().references(() => shifts.id),
    workerId: text('worker_id').notNull().references(() => workers.id),
    hostOrgId: text('host_org_id').notNull().references(() => organisations.id),
    supplierOrgId: text('supplier_org_id').notNull().references(() => organisations.id),
    clockInAt: ts('clock_in_at'),
    clockOutAt: ts('clock_out_at'),
    clockInLat: real('clock_in_lat'),
    clockInLng: real('clock_in_lng'),
    breakMinutes: integer('break_minutes').notNull().default(0),
    paidHours: real('paid_hours').notNull().default(0),
    chargeRate: real('charge_rate').notNull(),
    platformFeePct: real('platform_fee_pct').notNull(),
    hostCost: real('host_cost').notNull().default(0),
    platformFee: real('platform_fee').notNull().default(0),
    supplierAmount: real('supplier_amount').notNull().default(0),
    status: text('status').$type<TimesheetStatus>().notNull().default('DRAFT'),
    submittedAt: ts('submitted_at'),
    approvedAt: ts('approved_at'),
    approvedByUserId: text('approved_by_user_id'),
    disputedAt: ts('disputed_at'),
    disputeReason: text('dispute_reason'),
    notes: text('notes'),
    invoiceId: text('invoice_id'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => ({
    assignmentIdx: uniqueIndex('timesheets_assignment_idx').on(t.assignmentId),
    hostIdx: index('timesheets_host_idx').on(t.hostOrgId, t.status),
    supplierIdx: index('timesheets_supplier_idx').on(t.supplierOrgId, t.status),
  }),
);

export const invoices = sqliteTable(
  'invoices',
  {
    id: text('id').primaryKey(),
    number: text('number').notNull(),
    hostOrgId: text('host_org_id').notNull().references(() => organisations.id),
    supplierOrgId: text('supplier_org_id').notNull().references(() => organisations.id),
    periodStart: ts('period_start').notNull(),
    periodEnd: ts('period_end').notNull(),
    status: text('status').$type<InvoiceStatus>().notNull().default('ISSUED'),
    currency: text('currency').notNull().default('GBP'),
    totalHours: real('total_hours').notNull().default(0),
    subtotal: real('subtotal').notNull().default(0),
    platformFee: real('platform_fee').notNull().default(0),
    supplierAmount: real('supplier_amount').notNull().default(0),
    /** Decision 2: supply from the platform owner's own bank is the agency's own sale (no platform fee). */
    agencySale: bool('agency_sale').notNull().default(false),
    /** Decision 1: the consolidated invoice the host pays and the remittance the supplier receives. */
    hostInvoiceId: text('host_invoice_id'),
    remittanceId: text('remittance_id'),
    issuedAt: ts('issued_at'),
    paidAt: ts('paid_at'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => ({ numberIdx: uniqueIndex('invoices_number_idx').on(t.number) }),
);

/** Decision 1: one invoice per host per period from the platform, covering every supplier. */
export const hostInvoices = sqliteTable(
  'host_invoices',
  {
    id: text('id').primaryKey(),
    number: text('number').notNull(),
    hostOrgId: text('host_org_id').notNull().references(() => organisations.id),
    periodStart: ts('period_start').notNull(),
    periodEnd: ts('period_end').notNull(),
    status: text('status').$type<'ISSUED' | 'PAID' | 'OVERDUE' | 'VOID'>().notNull().default('ISSUED'),
    currency: text('currency').notNull().default('GBP'),
    subtotal: real('subtotal').notNull().default(0),
    credits: real('credits').notNull().default(0),
    total: real('total').notNull().default(0),
    dueAt: ts('due_at').notNull(),
    issuedAt: ts('issued_at').notNull(),
    paidAt: ts('paid_at'),
    paymentReference: text('payment_reference'),
    remindedAt: ts('reminded_at'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => ({ numberIdx: uniqueIndex('host_invoices_number_idx').on(t.number), hostIdx: index('host_invoices_host_idx').on(t.hostOrgId, t.status) }),
);

/** Decision 1: what the platform pays each supplier per period. */
export const remittances = sqliteTable(
  'remittances',
  {
    id: text('id').primaryKey(),
    number: text('number').notNull(),
    supplierOrgId: text('supplier_org_id').notNull().references(() => organisations.id),
    periodStart: ts('period_start').notNull(),
    periodEnd: ts('period_end').notNull(),
    status: text('status').$type<'ISSUED' | 'PAID' | 'VOID'>().notNull().default('ISSUED'),
    currency: text('currency').notNull().default('GBP'),
    amount: real('amount').notNull().default(0),
    credits: real('credits').notNull().default(0),
    total: real('total').notNull().default(0),
    issuedAt: ts('issued_at').notNull(),
    paidAt: ts('paid_at'),
    paymentReference: text('payment_reference'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => ({ numberIdx: uniqueIndex('remittances_number_idx').on(t.number), supplierIdx: index('remittances_supplier_idx').on(t.supplierOrgId, t.status) }),
);

/** Decision 5: a credit against a statement line, raised by the platform after a host query. */
export const credits = sqliteTable(
  'credits',
  {
    id: text('id').primaryKey(),
    invoiceId: text('invoice_id').notNull().references(() => invoices.id),
    timesheetId: text('timesheet_id'),
    hostOrgId: text('host_org_id').notNull(),
    supplierOrgId: text('supplier_org_id').notNull(),
    /** Positive amount reduces what the host owes and what the supplier receives (platform fee pro rata). */
    amount: real('amount').notNull(),
    reason: text('reason').notNull(),
    status: text('status').$type<'REQUESTED' | 'APPROVED' | 'REJECTED' | 'APPLIED'>().notNull().default('REQUESTED'),
    requestedByUserId: text('requested_by_user_id'),
    decidedByUserId: text('decided_by_user_id'),
    appliedToHostInvoiceId: text('applied_to_host_invoice_id'),
    appliedToRemittanceId: text('applied_to_remittance_id'),
    createdAt: ts('created_at').notNull(),
    decidedAt: ts('decided_at'),
  },
  (t) => ({ invoiceIdx: index('credits_invoice_idx').on(t.invoiceId) }),
);

export const ratings = sqliteTable(
  'ratings',
  {
    id: text('id').primaryKey(),
    assignmentId: text('assignment_id').notNull().references(() => shiftAssignments.id),
    fromOrgId: text('from_org_id').notNull().references(() => organisations.id),
    toOrgId: text('to_org_id').notNull().references(() => organisations.id),
    /** Set when the host rates the worker; null when the supplier rates the host site. */
    workerId: text('worker_id'),
    score: integer('score').notNull(),
    comment: text('comment'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => ({ pairIdx: uniqueIndex('ratings_pair_idx').on(t.assignmentId, t.fromOrgId) }),
);

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organisations.id),
    userId: text('user_id'),
    type: text('type').$type<NotificationType>().notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    data: json<Record<string, unknown>>('data'),
    readAt: ts('read_at'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => ({ orgIdx: index('notifications_org_idx').on(t.orgId, t.createdAt) }),
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    actorUserId: text('actor_user_id'),
    actorOrgId: text('actor_org_id'),
    action: text('action').$type<AuditAction>().notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    data: json<Record<string, unknown>>('data'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => ({ entityIdx: index('audit_log_entity_idx').on(t.entityType, t.entityId), timeIdx: index('audit_log_time_idx').on(t.createdAt) }),
);

/** Invitation and password-reset tokens (stored hashed). */
export const authTokens = sqliteTable(
  'auth_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id),
    kind: text('kind').$type<'INVITE' | 'RESET'>().notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => ({ hashIdx: uniqueIndex('auth_tokens_hash_idx').on(t.tokenHash), userIdx: index('auth_tokens_user_idx').on(t.userId) }),
);

/** Outbox for email and SMS: any provider can drain it (decision 15 deferred the provider). */
export const outboundMessages = sqliteTable(
  'outbound_messages',
  {
    id: text('id').primaryKey(),
    channel: text('channel').$type<'EMAIL' | 'SMS'>().notNull(),
    toAddress: text('to_address').notNull(),
    subject: text('subject'),
    body: text('body').notNull(),
    status: text('status').$type<'PENDING' | 'SENT' | 'FAILED'>().notNull().default('PENDING'),
    providerReference: text('provider_reference'),
    error: text('error'),
    notificationId: text('notification_id'),
    userId: text('user_id'),
    orgId: text('org_id'),
    createdAt: ts('created_at').notNull(),
    sentAt: ts('sent_at'),
  },
  (t) => ({ statusIdx: index('outbound_messages_status_idx').on(t.status, t.createdAt) }),
);

export const notificationPreferences = sqliteTable('notification_preferences', {
  userId: text('user_id').primaryKey().references(() => users.id),
  /** Notification types delivered by email as they happen; everything else goes in the daily digest. */
  emailImmediate: json<string[]>('email_immediate').notNull().default([]),
  emailDigest: bool('email_digest').notNull().default(true),
  smsImmediate: json<string[]>('sms_immediate').notNull().default([]),
  /** Quiet hours (local), e.g. 22 and 7: non-urgent messages wait. */
  quietHoursStart: integer('quiet_hours_start'),
  quietHoursEnd: integer('quiet_hours_end'),
  maxDistanceKm: real('max_distance_km'),
  updatedAt: ts('updated_at').notNull(),
});

/** Decision 14: a host bars a named worker from its shifts (all sites or one site). */
export const workerBars = sqliteTable(
  'worker_bars',
  {
    id: text('id').primaryKey(),
    hostOrgId: text('host_org_id').notNull().references(() => organisations.id),
    workerId: text('worker_id').notNull().references(() => workers.id),
    siteId: text('site_id'),
    reason: text('reason').notNull(),
    createdByUserId: text('created_by_user_id'),
    createdAt: ts('created_at').notNull(),
    liftedAt: ts('lifted_at'),
    liftedByUserId: text('lifted_by_user_id'),
  },
  (t) => ({ hostIdx: index('worker_bars_host_idx').on(t.hostOrgId), workerIdx: index('worker_bars_worker_idx').on(t.workerId) }),
);

/** Decision 14: a host reports a concern about a lent worker to the worker's employer. */
export const workerReports = sqliteTable(
  'worker_reports',
  {
    id: text('id').primaryKey(),
    hostOrgId: text('host_org_id').notNull().references(() => organisations.id),
    supplierOrgId: text('supplier_org_id').notNull().references(() => organisations.id),
    workerId: text('worker_id').notNull().references(() => workers.id),
    assignmentId: text('assignment_id'),
    category: text('category').$type<'SAFEGUARDING' | 'CONDUCT' | 'ATTENDANCE' | 'COMPETENCE' | 'OTHER'>().notNull(),
    description: text('description').notNull(),
    status: text('status').$type<'OPEN' | 'ACKNOWLEDGED' | 'CLOSED'>().notNull().default('OPEN'),
    employerResponse: text('employer_response'),
    createdByUserId: text('created_by_user_id'),
    createdAt: ts('created_at').notNull(),
    acknowledgedAt: ts('acknowledged_at'),
    closedAt: ts('closed_at'),
  },
  (t) => ({ supplierIdx: index('worker_reports_supplier_idx').on(t.supplierOrgId, t.status), workerIdx: index('worker_reports_worker_idx').on(t.workerId) }),
);

/** Decision 11: training or clearance a host requires beyond the standard mandatory set. */
export const hostRequirements = sqliteTable(
  'host_requirements',
  {
    id: text('id').primaryKey(),
    hostOrgId: text('host_org_id').notNull().references(() => organisations.id),
    name: text('name').notNull(),
    description: text('description'),
    /** e.g. a site induction that the host itself records for a worker. */
    recordedByHost: bool('recorded_by_host').notNull().default(false),
    createdAt: ts('created_at').notNull(),
    archivedAt: ts('archived_at'),
  },
  (t) => ({ hostIdx: index('host_requirements_host_idx').on(t.hostOrgId) }),
);

/** A worker holds a host requirement (declared by the employer, or recorded by the host when recordedByHost). */
export const workerHostRequirements = sqliteTable(
  'worker_host_requirements',
  {
    id: text('id').primaryKey(),
    workerId: text('worker_id').notNull().references(() => workers.id),
    requirementId: text('requirement_id').notNull().references(() => hostRequirements.id),
    documentId: text('document_id'),
    expiresAt: ts('expires_at'),
    recordedByUserId: text('recorded_by_user_id'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => ({ pairIdx: uniqueIndex('worker_host_requirements_pair_idx').on(t.workerId, t.requirementId) }),
);

/** Bulk worker import runs (CSV or spreadsheet). */
export const importJobs = sqliteTable(
  'import_jobs',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull().references(() => organisations.id),
    createdByUserId: text('created_by_user_id'),
    fileName: text('file_name'),
    status: text('status').$type<'PREVIEW' | 'APPLIED' | 'FAILED'>().notNull(),
    totalRows: integer('total_rows').notNull().default(0),
    createdCount: integer('created_count').notNull().default(0),
    updatedCount: integer('updated_count').notNull().default(0),
    invitedCount: integer('invited_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    errors: json<Array<{ row: number; message: string }>>('errors').notNull().default([]),
    createdAt: ts('created_at').notNull(),
    appliedAt: ts('applied_at'),
  },
  (t) => ({ orgIdx: index('import_jobs_org_idx').on(t.orgId) }),
);

/** A recurring posting: the pattern that generated a set of shifts. */
export const shiftSeries = sqliteTable('shift_series', {
  id: text('id').primaryKey(),
  hostOrgId: text('host_org_id').notNull().references(() => organisations.id),
  title: text('title').notNull(),
  pattern: json<Record<string, unknown>>('pattern').notNull(),
  createdByUserId: text('created_by_user_id'),
  createdAt: ts('created_at').notNull(),
});

export type Organisation = typeof organisations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Site = typeof sites.$inferSelect;
export type Worker = typeof workers.$inferSelect;
export type WorkerDocument = typeof workerDocuments.$inferSelect;
export type WorkerWeekHours = typeof workerWeekHours.$inferSelect;
export type CapacityFlag = typeof capacityFlags.$inferSelect;
export type Shift = typeof shifts.$inferSelect;
export type ShiftAccessRow = typeof shiftAccess.$inferSelect;
export type ShiftAssignment = typeof shiftAssignments.$inferSelect;
export type Timesheet = typeof timesheets.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type PlatformSettingsRow = typeof platformSettings.$inferSelect;
export type HostInvoice = typeof hostInvoices.$inferSelect;
export type Remittance = typeof remittances.$inferSelect;
export type Credit = typeof credits.$inferSelect;
export type WorkerBar = typeof workerBars.$inferSelect;
export type WorkerReport = typeof workerReports.$inferSelect;
export type HostRequirement = typeof hostRequirements.$inferSelect;
export type ImportJob = typeof importJobs.$inferSelect;
export type OutboundMessage = typeof outboundMessages.$inferSelect;
