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
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => ({ orgIdx: index('workers_org_idx').on(t.orgId) }),
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
    issuedAt: ts('issued_at'),
    paidAt: ts('paid_at'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => ({ numberIdx: uniqueIndex('invoices_number_idx').on(t.number) }),
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

export type Organisation = typeof organisations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Site = typeof sites.$inferSelect;
export type Worker = typeof workers.$inferSelect;
export type WorkerDocument = typeof workerDocuments.$inferSelect;
export type CapacityFlag = typeof capacityFlags.$inferSelect;
export type Shift = typeof shifts.$inferSelect;
export type ShiftAccessRow = typeof shiftAccess.$inferSelect;
export type ShiftAssignment = typeof shiftAssignments.$inferSelect;
export type Timesheet = typeof timesheets.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type PlatformSettingsRow = typeof platformSettings.$inferSelect;
