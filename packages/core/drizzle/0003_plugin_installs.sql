ALTER TABLE "plugins" ADD COLUMN "install_spec" text;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "install_version" text;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "installed_at" timestamp with time zone;