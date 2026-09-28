ALTER TABLE "runs" ADD COLUMN "invoke_deadline_at" timestamp with time zone;--> statement-breakpoint
-- Rows written by the old check-then-insert could repeat on a redelivered job: keep the first.
DELETE FROM "notification_log" a USING "notification_log" b WHERE a."run_id" IS NOT NULL AND a."run_id" = b."run_id" AND a."notifier_id" = b."notifier_id" AND a."on" = b."on" AND a."id" > b."id";--> statement-breakpoint
DELETE FROM "steps" a USING "steps" b WHERE a."run_id" = b."run_id" AND a."phase" = b."phase" AND a."index" = b."index" AND (a."at", a."id") > (b."at", b."id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_log_run_notifier_on" ON "notification_log" USING btree ("run_id","notifier_id","on") WHERE "notification_log"."run_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "steps_run_phase_index" ON "steps" USING btree ("run_id","phase","index");
