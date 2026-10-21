CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`actor_org_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`data` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_log_time_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `capacity_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`job_role` text,
	`headcount` integer DEFAULT 1 NOT NULL,
	`hours_requested` real NOT NULL,
	`hours_filled` real DEFAULT 0 NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`site_id` text,
	`postcode_areas` text,
	`radius_km` real,
	`note` text,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`created_by_user_id` text,
	`closed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `capacity_flags_org_idx` ON `capacity_flags` (`org_id`);--> statement-breakpoint
CREATE INDEX `capacity_flags_status_idx` ON `capacity_flags` (`status`,`kind`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`host_org_id` text NOT NULL,
	`supplier_org_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`status` text DEFAULT 'ISSUED' NOT NULL,
	`currency` text DEFAULT 'GBP' NOT NULL,
	`total_hours` real DEFAULT 0 NOT NULL,
	`subtotal` real DEFAULT 0 NOT NULL,
	`platform_fee` real DEFAULT 0 NOT NULL,
	`supplier_amount` real DEFAULT 0 NOT NULL,
	`issued_at` integer,
	`paid_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`host_org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_number_idx` ON `invoices` (`number`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`data` text,
	`read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notifications_org_idx` ON `notifications` (`org_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `org_relationships` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`other_org_id` text NOT NULL,
	`kind` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`other_org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_relationships_pair_idx` ON `org_relationships` (`org_id`,`other_org_id`);--> statement-breakpoint
CREATE TABLE `organisations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`service_types` text DEFAULT '[]' NOT NULL,
	`cqc_registration_number` text,
	`email` text,
	`phone` text,
	`address_line_1` text,
	`city` text,
	`postcode` text,
	`lat` real,
	`lng` real,
	`default_charge_rate` real,
	`worker_self_service_allowed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `platform_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`platform_name` text DEFAULT 'Merge' NOT NULL,
	`owner_org_id` text,
	`priority_window_minutes` integer DEFAULT 120 NOT NULL,
	`agency_window_minutes` integer DEFAULT 60 NOT NULL,
	`agency_position` text DEFAULT 'AFTER_PRIORITY' NOT NULL,
	`urgent_threshold_minutes` integer DEFAULT 720 NOT NULL,
	`min_lead_before_start_minutes` integer DEFAULT 60 NOT NULL,
	`preferred_partners_get_priority` integer DEFAULT true NOT NULL,
	`platform_fee_pct` real DEFAULT 8 NOT NULL,
	`currency` text DEFAULT 'GBP' NOT NULL,
	`min_rest_hours` real DEFAULT 11 NOT NULL,
	`max_weekly_hours` real DEFAULT 48 NOT NULL,
	`max_shift_hours` real DEFAULT 14 NOT NULL,
	`late_cancellation_hours` real DEFAULT 24 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ratings` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`from_org_id` text NOT NULL,
	`to_org_id` text NOT NULL,
	`worker_id` text,
	`score` integer NOT NULL,
	`comment` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`assignment_id`) REFERENCES `shift_assignments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ratings_pair_idx` ON `ratings` (`assignment_id`,`from_org_id`);--> statement-breakpoint
CREATE TABLE `shift_access` (
	`id` text PRIMARY KEY NOT NULL,
	`shift_id` text NOT NULL,
	`org_id` text NOT NULL,
	`tier` text NOT NULL,
	`opens_at` integer NOT NULL,
	`rank` integer NOT NULL,
	`reason` text NOT NULL,
	`matched_flag_id` text,
	`notified_at` integer,
	FOREIGN KEY (`shift_id`) REFERENCES `shifts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shift_access_pair_idx` ON `shift_access` (`shift_id`,`org_id`);--> statement-breakpoint
CREATE INDEX `shift_access_org_idx` ON `shift_access` (`org_id`,`opens_at`);--> statement-breakpoint
CREATE INDEX `shift_access_open_idx` ON `shift_access` (`opens_at`,`notified_at`);--> statement-breakpoint
CREATE TABLE `shift_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`shift_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`supplier_org_id` text NOT NULL,
	`status` text NOT NULL,
	`tier_at_request` text,
	`matched_flag_id` text,
	`requested_by_user_id` text,
	`responded_by_user_id` text,
	`requested_at` integer NOT NULL,
	`responded_at` integer,
	`cancelled_at` integer,
	`cancelled_by_org_id` text,
	`cancellation_reason` text,
	`late_cancellation` integer DEFAULT false NOT NULL,
	`hours_override` integer DEFAULT false NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`shift_id`) REFERENCES `shifts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shift_assignments_shift_idx` ON `shift_assignments` (`shift_id`);--> statement-breakpoint
CREATE INDEX `shift_assignments_worker_idx` ON `shift_assignments` (`worker_id`);--> statement-breakpoint
CREATE INDEX `shift_assignments_supplier_idx` ON `shift_assignments` (`supplier_org_id`);--> statement-breakpoint
CREATE TABLE `shifts` (
	`id` text PRIMARY KEY NOT NULL,
	`host_org_id` text NOT NULL,
	`site_id` text NOT NULL,
	`job_role` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`break_minutes` integer DEFAULT 0 NOT NULL,
	`headcount` integer DEFAULT 1 NOT NULL,
	`filled_count` integer DEFAULT 0 NOT NULL,
	`required_skills` text DEFAULT '[]' NOT NULL,
	`extra_required_documents` text DEFAULT '[]' NOT NULL,
	`charge_rate` real NOT NULL,
	`currency` text DEFAULT 'GBP' NOT NULL,
	`visibility` text DEFAULT 'NETWORK' NOT NULL,
	`priority_window_minutes_override` integer,
	`auto_confirm` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`urgent` integer DEFAULT false NOT NULL,
	`published_at` integer,
	`cancelled_at` integer,
	`cancellation_reason` text,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`host_org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shifts_host_idx` ON `shifts` (`host_org_id`);--> statement-breakpoint
CREATE INDEX `shifts_status_idx` ON `shifts` (`status`,`starts_at`);--> statement-breakpoint
CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`service_type` text,
	`address_line_1` text,
	`city` text,
	`postcode` text NOT NULL,
	`lat` real,
	`lng` real,
	`access_notes` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sites_org_idx` ON `sites` (`org_id`);--> statement-breakpoint
CREATE TABLE `timesheets` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`shift_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`host_org_id` text NOT NULL,
	`supplier_org_id` text NOT NULL,
	`clock_in_at` integer,
	`clock_out_at` integer,
	`clock_in_lat` real,
	`clock_in_lng` real,
	`break_minutes` integer DEFAULT 0 NOT NULL,
	`paid_hours` real DEFAULT 0 NOT NULL,
	`charge_rate` real NOT NULL,
	`platform_fee_pct` real NOT NULL,
	`host_cost` real DEFAULT 0 NOT NULL,
	`platform_fee` real DEFAULT 0 NOT NULL,
	`supplier_amount` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`submitted_at` integer,
	`approved_at` integer,
	`approved_by_user_id` text,
	`disputed_at` integer,
	`dispute_reason` text,
	`notes` text,
	`invoice_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`assignment_id`) REFERENCES `shift_assignments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shift_id`) REFERENCES `shifts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`host_org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `timesheets_assignment_idx` ON `timesheets` (`assignment_id`);--> statement-breakpoint
CREATE INDEX `timesheets_host_idx` ON `timesheets` (`host_org_id`,`status`);--> statement-breakpoint
CREATE INDEX `timesheets_supplier_idx` ON `timesheets` (`supplier_org_id`,`status`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`worker_id` text,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_org_idx` ON `users` (`org_id`);--> statement-breakpoint
CREATE TABLE `worker_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`type` text NOT NULL,
	`reference` text,
	`issued_at` integer,
	`expires_at` integer,
	`file_url` text,
	`verified_at` integer,
	`verified_by_user_id` text,
	`notes` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `worker_documents_worker_idx` ON `worker_documents` (`worker_id`);--> statement-breakpoint
CREATE TABLE `worker_unavailability` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `worker_unavailability_worker_idx` ON `worker_unavailability` (`worker_id`);--> statement-breakpoint
CREATE TABLE `workers` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`email` text,
	`phone` text,
	`job_role` text NOT NULL,
	`skills` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL,
	`shareable` integer DEFAULT true NOT NULL,
	`contracted_hours_per_week` real,
	`max_hours_per_week` real,
	`opted_out_of_48h` integer DEFAULT false NOT NULL,
	`postcode` text,
	`lat` real,
	`lng` real,
	`travel_radius_km` real,
	`hourly_pay_rate` real,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workers_org_idx` ON `workers` (`org_id`);