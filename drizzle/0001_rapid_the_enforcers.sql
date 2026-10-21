CREATE TABLE `brands` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`tagline` text DEFAULT '欢迎来到服务中心' NOT NULL,
	`color` text DEFAULT '#2165e8' NOT NULL,
	`logo` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `members` (
	`email` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `audit` ADD `tenant_id` text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE `notices` ADD `tenant_id` text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE `tickets` ADD `tenant_id` text DEFAULT 'main' NOT NULL;