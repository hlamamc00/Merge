CREATE TABLE `auth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_tokens_hash_idx` ON `auth_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `auth_tokens_user_idx` ON `auth_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `credits` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`timesheet_id` text,
	`host_org_id` text NOT NULL,
	`supplier_org_id` text NOT NULL,
	`amount` real NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'REQUESTED' NOT NULL,
	`requested_by_user_id` text,
	`decided_by_user_id` text,
	`applied_to_host_invoice_id` text,
	`applied_to_remittance_id` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `credits_invoice_idx` ON `credits` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `host_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`host_org_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`status` text DEFAULT 'ISSUED' NOT NULL,
	`currency` text DEFAULT 'GBP' NOT NULL,
	`subtotal` real DEFAULT 0 NOT NULL,
	`credits` real DEFAULT 0 NOT NULL,
	`total` real DEFAULT 0 NOT NULL,
	`due_at` integer NOT NULL,
	`issued_at` integer NOT NULL,
	`paid_at` integer,
	`payment_reference` text,
	`reminded_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`host_org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `host_invoices_number_idx` ON `host_invoices` (`number`);--> statement-breakpoint
CREATE INDEX `host_invoices_host_idx` ON `host_invoices` (`host_org_id`,`status`);--> statement-breakpoint
CREATE TABLE `host_requirements` (
	`id` text PRIMARY KEY NOT NULL,
	`host_org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`recorded_by_host` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`host_org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `host_requirements_host_idx` ON `host_requirements` (`host_org_id`);--> statement-breakpoint
CREATE TABLE `import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`created_by_user_id` text,
	`file_name` text,
	`status` text NOT NULL,
	`total_rows` integer DEFAULT 0 NOT NULL,
	`created_count` integer DEFAULT 0 NOT NULL,
	`updated_count` integer DEFAULT 0 NOT NULL,
	`invited_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`errors` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`applied_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `import_jobs_org_idx` ON `import_jobs` (`org_id`);--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email_immediate` text DEFAULT '[]' NOT NULL,
	`email_digest` integer DEFAULT true NOT NULL,
	`sms_immediate` text DEFAULT '[]' NOT NULL,
	`quiet_hours_start` integer,
	`quiet_hours_end` integer,
	`max_distance_km` real,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `outbound_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`to_address` text NOT NULL,
	`subject` text,
	`body` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`provider_reference` text,
	`error` text,
	`notification_id` text,
	`user_id` text,
	`org_id` text,
	`created_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE INDEX `outbound_messages_status_idx` ON `outbound_messages` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `remittances` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`supplier_org_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`status` text DEFAULT 'ISSUED' NOT NULL,
	`currency` text DEFAULT 'GBP' NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	`credits` real DEFAULT 0 NOT NULL,
	`total` real DEFAULT 0 NOT NULL,
	`issued_at` integer NOT NULL,
	`paid_at` integer,
	`payment_reference` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`supplier_org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `remittances_number_idx` ON `remittances` (`number`);--> statement-breakpoint
CREATE INDEX `remittances_supplier_idx` ON `remittances` (`supplier_org_id`,`status`);--> statement-breakpoint
CREATE TABLE `shift_series` (
	`id` text PRIMARY KEY NOT NULL,
	`host_org_id` text NOT NULL,
	`title` text NOT NULL,
	`pattern` text NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`host_org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `worker_bars` (
	`id` text PRIMARY KEY NOT NULL,
	`host_org_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`site_id` text,
	`reason` text NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`lifted_at` integer,
	`lifted_by_user_id` text,
	FOREIGN KEY (`host_org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `worker_bars_host_idx` ON `worker_bars` (`host_org_id`);--> statement-breakpoint
CREATE INDEX `worker_bars_worker_idx` ON `worker_bars` (`worker_id`);--> statement-breakpoint
CREATE TABLE `worker_host_requirements` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`requirement_id` text NOT NULL,
	`document_id` text,
	`expires_at` integer,
	`recorded_by_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requirement_id`) REFERENCES `host_requirements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_host_requirements_pair_idx` ON `worker_host_requirements` (`worker_id`,`requirement_id`);--> statement-breakpoint
CREATE TABLE `worker_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`host_org_id` text NOT NULL,
	`supplier_org_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`assignment_id` text,
	`category` text NOT NULL,
	`description` text NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`employer_response` text,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`acknowledged_at` integer,
	`closed_at` integer,
	FOREIGN KEY (`host_org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `worker_reports_supplier_idx` ON `worker_reports` (`supplier_org_id`,`status`);--> statement-breakpoint
CREATE INDEX `worker_reports_worker_idx` ON `worker_reports` (`worker_id`);--> statement-breakpoint
ALTER TABLE `invoices` ADD `agency_sale` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `host_invoice_id` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `remittance_id` text;--> statement-breakpoint
ALTER TABLE `organisations` ADD `mou_accepted_at` integer;--> statement-breakpoint
ALTER TABLE `organisations` ADD `mou_version` text;--> statement-breakpoint
ALTER TABLE `organisations` ADD `mou_accepted_by_user_id` text;--> statement-breakpoint
ALTER TABLE `organisations` ADD `escalation_mode` text DEFAULT 'MANUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE `organisations` ADD `escalation_ceiling_pct` real DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE `organisations` ADD `priority_penalty_until` integer;--> statement-breakpoint
ALTER TABLE `organisations` ADD `suspended_reason` text;--> statement-breakpoint
ALTER TABLE `organisations` ADD `credit_hold` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_settings` ADD `national_minimum_wage` real DEFAULT 12.71 NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_settings` ADD `employer_on_cost_pct` real DEFAULT 25 NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_settings` ADD `no_show_window_days` integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_settings` ADD `no_show_priority_penalty_threshold` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_settings` ADD `no_show_priority_penalty_days` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_settings` ADD `no_show_suspension_threshold` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_settings` ADD `request_reminder_hours` real DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_settings` ADD `request_reminder_before_start_hours` real DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_settings` ADD `document_retention_years` integer DEFAULT 6 NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_settings` ADD `mou_version` text DEFAULT '1.0' NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_settings` ADD `two_factor_required_for_managers` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `platform_settings` ADD `default_escalation_mode` text DEFAULT 'MANUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE `shift_assignments` ADD `operator_reminded_at` integer;--> statement-breakpoint
ALTER TABLE `shifts` ADD `original_charge_rate` real;--> statement-breakpoint
ALTER TABLE `shifts` ADD `escalation_step` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `shifts` ADD `last_escalated_at` integer;--> statement-breakpoint
ALTER TABLE `shifts` ADD `series_id` text;--> statement-breakpoint
ALTER TABLE `shifts` ADD `required_host_requirement_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `site_ids` text;--> statement-breakpoint
ALTER TABLE `users` ADD `phone` text;--> statement-breakpoint
ALTER TABLE `users` ADD `must_change_password` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_secret` text;--> statement-breakpoint
ALTER TABLE `users` ADD `totp_enabled_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `failed_login_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `locked_until` integer;--> statement-breakpoint
ALTER TABLE `worker_documents` ADD `file_key` text;--> statement-breakpoint
ALTER TABLE `worker_documents` ADD `file_name` text;--> statement-breakpoint
ALTER TABLE `worker_documents` ADD `mime_type` text;--> statement-breakpoint
ALTER TABLE `worker_documents` ADD `file_size` integer;--> statement-breakpoint
ALTER TABLE `worker_documents` ADD `uploaded_by_user_id` text;--> statement-breakpoint
ALTER TABLE `worker_documents` ADD `replaces_document_id` text;--> statement-breakpoint
ALTER TABLE `worker_documents` ADD `superseded_at` integer;--> statement-breakpoint
ALTER TABLE `workers` ADD `home_site_id` text;--> statement-breakpoint
ALTER TABLE `workers` ADD `consent_to_share_at` integer;--> statement-breakpoint
CREATE INDEX `workers_home_site_idx` ON `workers` (`home_site_id`);