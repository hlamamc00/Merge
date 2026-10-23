CREATE TABLE `worker_week_hours` (
	`id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`week_start` integer NOT NULL,
	`internal_hours` real NOT NULL,
	`note` text,
	`source_flag_id` text,
	`set_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worker_week_hours_pair_idx` ON `worker_week_hours` (`worker_id`,`week_start`);--> statement-breakpoint
CREATE INDEX `worker_week_hours_flag_idx` ON `worker_week_hours` (`source_flag_id`);