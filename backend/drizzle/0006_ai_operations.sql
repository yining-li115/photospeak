CREATE TABLE IF NOT EXISTS "ai_operations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"capability" text NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"idempotency_key_version" text NOT NULL,
	"dedupe_expires_at" timestamp with time zone,
	"request_hash" text NOT NULL,
	"request_hash_key_id" text NOT NULL,
	"contract_version" integer DEFAULT 1 NOT NULL,
	"execution_fingerprint" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"provider_capability" text DEFAULT 'none' NOT NULL,
	"provider_idempotency_key" text NOT NULL,
	"provider_request_id" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"response_status" integer,
	"response_envelope" text,
	"error_code" text,
	"response_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD COLUMN "operation_id" text;
--> statement-breakpoint
UPDATE "ai_usage_events" SET "operation_id" = "request_id" WHERE "operation_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "ai_usage_events" ALTER COLUMN "operation_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_operations" ADD CONSTRAINT "ai_operations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_operations_user_capability_key_idx" ON "ai_operations" USING btree ("user_id","capability","idempotency_key_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_operations_state_lease_idx" ON "ai_operations" USING btree ("state","lease_until");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_operations_result_expiry_idx" ON "ai_operations" USING btree ("response_expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_operations_dedupe_expiry_state_idx" ON "ai_operations" USING btree ("dedupe_expires_at","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_operations_request_hash_key_idx" ON "ai_operations" USING btree ("request_hash_key_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_usage_events_user_operation_id_idx" ON "ai_usage_events" USING btree ("user_id","operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_usage_events_created_at_idx" ON "ai_usage_events" USING btree ("created_at","id");
