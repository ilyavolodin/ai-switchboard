CREATE TABLE "login_attempts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "login_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"key" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "remove_requested_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "login_attempts_key_at" ON "login_attempts" USING btree ("key","at");--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "binding_limit";