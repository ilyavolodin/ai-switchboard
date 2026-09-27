CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"role" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"batch_id" uuid PRIMARY KEY NOT NULL,
	"process_id" uuid NOT NULL,
	"rule" text NOT NULL,
	"input" jsonb,
	"requested_at" timestamp with time zone NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision" text,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"scope" text NOT NULL,
	"target_id" text,
	"field" text,
	"before" jsonb,
	"after" jsonb,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"process_id" uuid NOT NULL,
	"batch_key" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"fire_after" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"size" integer DEFAULT 0 NOT NULL,
	"outcome" text DEFAULT 'open' NOT NULL,
	"outcome_reason" text,
	"approval_state" text DEFAULT 'none' NOT NULL,
	"schedule_id" text,
	"merged_into" uuid,
	"dry_run" boolean DEFAULT false NOT NULL,
	"requested_by" text,
	"decisions" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"trigger_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"outcome" text NOT NULL,
	"filter" jsonb,
	"batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_raw" (
	"ref" text PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"body" "bytea" NOT NULL,
	"headers" jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"verify" text DEFAULT 'ok' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"artifact" jsonb NOT NULL,
	"artifact_key" text NOT NULL,
	"attributes" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"delivery_id" text,
	"raw_ref" text NOT NULL,
	"stage" text NOT NULL,
	"stage_reason" text,
	"replay_of" uuid
);
--> statement-breakpoint
CREATE TABLE "executors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type_id" text NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"caps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"soft_hold_until" timestamp with time zone,
	"soft_hold_reason" text,
	"health" jsonb,
	"secrets_resolved_at" timestamp with time zone,
	"meters_read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_state" (
	"instance_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_state_instance_id_key_pk" PRIMARY KEY("instance_id","key")
);
--> statement-breakpoint
CREATE TABLE "meter_readings" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "meter_readings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"executor_id" uuid NOT NULL,
	"meter_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"used" double precision,
	"limit" double precision,
	"utilization" double precision NOT NULL,
	"resets_at" timestamp with time zone,
	"estimated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type_id" text NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"health" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_types" (
	"plugin" text NOT NULL,
	"kind" text NOT NULL,
	"type_id" text NOT NULL,
	"display_name" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_types_kind_type_id_pk" PRIMARY KEY("kind","type_id")
);
--> statement-breakpoint
CREATE TABLE "plugins" (
	"name" text PRIMARY KEY NOT NULL,
	"plugin_id" text NOT NULL,
	"display_name" text NOT NULL,
	"version" text NOT NULL,
	"integrity" text,
	"sdk_range" text NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"status_message" text,
	"origin" text DEFAULT 'baked' NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"invalid_event_count" integer DEFAULT 0 NOT NULL,
	"loaded_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "process_versions" (
	"process_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"document" jsonb NOT NULL,
	"saved_by" text NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "process_versions_process_id_version_pk" PRIMARY KEY("process_id","version")
);
--> statement-breakpoint
CREATE TABLE "processes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"document" jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"breaker_state" text DEFAULT 'closed' NOT NULL,
	"breaker_opened_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replicas" (
	"id" text PRIMARY KEY NOT NULL,
	"hostname" text NOT NULL,
	"version" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_updates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "run_updates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"process_version" integer NOT NULL,
	"executor_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"status_reason" text,
	"external_id" text,
	"external_url" text,
	"input" jsonb,
	"result" jsonb,
	"usage" jsonb,
	"errors" jsonb,
	"binding_limit" text,
	"dry_run" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"invoked_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"next_poll_at" timestamp with time zone,
	"poll_count" integer DEFAULT 0 NOT NULL,
	"first_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_ticks" (
	"process_id" uuid NOT NULL,
	"schedule_id" text NOT NULL,
	"tick_at" timestamp with time zone NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"batch_id" uuid,
	"catch_up" boolean DEFAULT false NOT NULL,
	CONSTRAINT "schedule_ticks_process_id_schedule_id_tick_at_pk" PRIMARY KEY("process_id","schedule_id","tick_at")
);
--> statement-breakpoint
CREATE TABLE "secret_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type_id" text NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"health" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type_id" text NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"caps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"watermark" text,
	"health" jsonb,
	"last_event_at" timestamp with time zone,
	"last_verify_failure_at" timestamp with time zone,
	"secrets_resolved_at" timestamp with time zone,
	"provisioned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stats_hourly" (
	"dimension" text NOT NULL,
	"key" text NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"counters" jsonb NOT NULL,
	CONSTRAINT "stats_hourly_dimension_key_hour_pk" PRIMARY KEY("dimension","key","hour")
);
--> statement-breakpoint
CREATE TABLE "steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"index" integer NOT NULL,
	"provider_id" text NOT NULL,
	"action" text NOT NULL,
	"args" jsonb,
	"status" text NOT NULL,
	"error" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"oidc_subject" text,
	"password_hash" text,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE INDEX "approvals_pending" ON "approvals" USING btree ("requested_at") WHERE "approvals"."decision" IS NULL;--> statement-breakpoint
CREATE INDEX "audit_at" ON "audit_log" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_target" ON "audit_log" USING btree ("scope","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "batches_one_open" ON "batches" USING btree ("process_id","batch_key") WHERE "batches"."outcome" = 'open' AND "batches"."kind" = 'event';--> statement-breakpoint
CREATE INDEX "batches_process" ON "batches" USING btree ("process_id","opened_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "batches_fire" ON "batches" USING btree ("fire_after") WHERE "batches"."outcome" = 'open';--> statement-breakpoint
CREATE INDEX "dispatches_dedupe" ON "dispatches" USING btree ("process_id","dedupe_key","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "dispatches_event" ON "dispatches" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "dispatches_batch" ON "dispatches" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "dispatches_process_created" ON "dispatches" USING btree ("process_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "event_raw_received" ON "event_raw" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "events_received" ON "events" USING btree ("received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_source_received" ON "events" USING btree ("source_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_artifact" ON "events" USING btree ("artifact_key");--> statement-breakpoint
CREATE INDEX "events_artifact_id" ON "events" USING btree (("artifact"->>'id'));--> statement-breakpoint
CREATE UNIQUE INDEX "events_delivery" ON "events" USING btree ("source_id","delivery_id","type","artifact_key") WHERE "events"."delivery_id" IS NOT NULL AND "events"."replay_of" IS NULL;--> statement-breakpoint
CREATE INDEX "meter_readings_latest" ON "meter_readings" USING btree ("executor_id","meter_id","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "run_updates_run" ON "run_updates" USING btree ("run_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_batch" ON "runs" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "runs_process_invoked" ON "runs" USING btree ("process_id","invoked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "runs_executor_invoked" ON "runs" USING btree ("executor_id","invoked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "runs_open" ON "runs" USING btree ("status") WHERE "runs"."status" IN ('invoking','running','uncertain');--> statement-breakpoint
CREATE INDEX "runs_external" ON "runs" USING btree ("executor_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "secret_providers_name" ON "secret_providers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "steps_run" ON "steps" USING btree ("run_id");