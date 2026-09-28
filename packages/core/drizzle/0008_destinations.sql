-- The "executor" concept is now "destination" (SDK 2.0.0). Every change is a RENAME or an
-- in-place UPDATE, so no row is lost: tables, columns and indexes keep their data, and stored
-- values that carried the old word are rewritten to the new one.
ALTER TABLE "executors" RENAME TO "destinations";--> statement-breakpoint
ALTER TABLE "destinations" RENAME CONSTRAINT "executors_pkey" TO "destinations_pkey";--> statement-breakpoint
ALTER TABLE "runs" RENAME COLUMN "executor_id" TO "destination_id";--> statement-breakpoint
ALTER TABLE "meter_readings" RENAME COLUMN "executor_id" TO "destination_id";--> statement-breakpoint
ALTER INDEX "runs_executor_invoked" RENAME TO "runs_destination_invoked";--> statement-breakpoint
-- Plugin registry: the kind, and the reference plugins' package names and ids.
UPDATE "plugin_types" SET "kind" = 'destination' WHERE "kind" = 'executor';--> statement-breakpoint
UPDATE "plugins" SET
  "name" = replace("name", '@ai-switchboard/executor-', '@ai-switchboard/destination-'),
  "plugin_id" = replace("plugin_id", 'executor-', 'destination-')
WHERE "name" LIKE '@ai-switchboard/executor-%'
  AND NOT EXISTS (
    SELECT 1 FROM "plugins" p2
    WHERE p2."name" = replace("plugins"."name", '@ai-switchboard/executor-', '@ai-switchboard/destination-')
  );--> statement-breakpoint
UPDATE "plugin_types" SET "plugin" = replace("plugin", '@ai-switchboard/executor-', '@ai-switchboard/destination-')
WHERE "plugin" LIKE '@ai-switchboard/executor-%';--> statement-breakpoint
-- Process documents: the top-level `executor` key becomes `destination`.
UPDATE "processes"
SET "document" = ("document" - 'executor') || jsonb_build_object('destination', "document"->'executor')
WHERE "document" ? 'executor';--> statement-breakpoint
UPDATE "process_versions"
SET "document" = ("document" - 'executor') || jsonb_build_object('destination', "document"->'executor')
WHERE "document" ? 'executor';--> statement-breakpoint
-- Audit log: the scope, the per-field rows of process changes, and whole documents kept in
-- before/after.
UPDATE "audit_log" SET "scope" = 'destination' WHERE "scope" = 'executor';--> statement-breakpoint
UPDATE "audit_log" SET "field" = 'destination' WHERE "scope" = 'process' AND "field" = 'executor';--> statement-breakpoint
UPDATE "audit_log"
SET "before" = ("before" - 'executor') || jsonb_build_object('destination', "before"->'executor')
WHERE jsonb_typeof("before") = 'object' AND "before" ? 'executor';--> statement-breakpoint
UPDATE "audit_log"
SET "after" = ("after" - 'executor') || jsonb_build_object('destination', "after"->'executor')
WHERE jsonb_typeof("after") = 'object' AND "after" ? 'executor';--> statement-breakpoint
-- Pipeline records: hold and throttle reasons (`executor_disabled`, `executor_unhealthy`,
-- `executor_runs_per_hour`, `executor_usage_per_day:<dim>`, ...), gate and budget check names and
-- counters in the trace, and run status reasons (`executor_unavailable`).
UPDATE "batches" SET "outcome_reason" = 'destination_' || substr("outcome_reason", 10)
WHERE "outcome_reason" LIKE 'executor\_%';--> statement-breakpoint
UPDATE "batches" SET "decisions" = replace("decisions"::text, '"executor', '"destination')::jsonb
WHERE "decisions"::text LIKE '%"executor%';--> statement-breakpoint
UPDATE "runs" SET "status_reason" = 'destination_' || substr("status_reason", 10)
WHERE "status_reason" LIKE 'executor\_%';--> statement-breakpoint
-- Hourly statistics and system alert rate-limit keys.
UPDATE "stats_hourly" SET "dimension" = 'destination' WHERE "dimension" = 'executor';--> statement-breakpoint
UPDATE "system_alerts" SET "key" = 'destination_' || substr("key", 10)
WHERE "key" LIKE 'executor\_%'
  AND NOT EXISTS (
    SELECT 1 FROM "system_alerts" a2 WHERE a2."key" = 'destination_' || substr("system_alerts"."key", 10)
  );
