CREATE TABLE IF NOT EXISTS "apple_credentials" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text,
	"apple_user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"encrypted_refresh_token" text,
	"encryption_key_id" text NOT NULL,
	"status" text DEFAULT 'pending_login' NOT NULL,
	"activated_at" timestamp with time zone,
	"login_reservation_id" text,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"revocation_started_at" timestamp with time zone,
	"last_revocation_attempt_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "rotation_idempotency_key_hash" text;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "rotation_replay_envelope" text;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "rotation_replay_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_state" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_authorized_session_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_lease_owner" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "apple_login_reservation_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "apple_login_reservation_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "apple_token_revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "apple_manual_revoke_required_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "apple_credentials" ADD CONSTRAINT "apple_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "apple_credentials_token_hash_idx" ON "apple_credentials" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apple_credentials_user_status_idx" ON "apple_credentials" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apple_credentials_recovery_idx" ON "apple_credentials" USING btree ("status","next_attempt_at","lease_until");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_deletion_recovery_idx" ON "users" USING btree ("deletion_state","deletion_next_attempt_at","deletion_lease_until");