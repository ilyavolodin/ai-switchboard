ALTER TABLE "events" ADD COLUMN "trace_context" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "trace_context" text;