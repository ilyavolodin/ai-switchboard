ALTER TABLE "event_raw" ADD COLUMN "origin" text DEFAULT 'push' NOT NULL;--> statement-breakpoint
UPDATE "event_raw" SET "origin" = "headers"->>'x-switchboard-origin', "headers" = "headers" - 'x-switchboard-origin' WHERE "headers"->>'x-switchboard-origin' IN ('poll', 'test');
