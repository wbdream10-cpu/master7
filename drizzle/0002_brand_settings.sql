ALTER TABLE `brands` ADD `language` text DEFAULT 'zh-CN' NOT NULL CHECK (`language` IN ('zh-CN','en','ms'));
--> statement-breakpoint
ALTER TABLE `brands` ADD `support_url` text DEFAULT '' NOT NULL CHECK (length(`support_url`)<=1000);
