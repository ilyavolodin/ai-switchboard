CREATE TABLE "notification_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notification_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"notifier_id" text NOT NULL,
	"on" text NOT NULL,
	"process_id" uuid,
	"batch_id" uuid,
	"run_id" uuid,
	"title" text NOT NULL,
	"text" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_alerts" (
	"key" text PRIMARY KEY NOT NULL,
	"last_sent_at" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "events_from" uuid;--> statement-breakpoint
ALTER TABLE "batches" ADD COLUMN "tick_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "match_decisions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "processes" ADD COLUMN "breaker_reset_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "invoke_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "last_polled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "silence_alerted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "notification_log_batch" ON "notification_log" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "notification_log_run" ON "notification_log" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "notification_log_at" ON "notification_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "events_pending_match" ON "events" USING btree ("received_at") WHERE "events"."stage" = 'received';