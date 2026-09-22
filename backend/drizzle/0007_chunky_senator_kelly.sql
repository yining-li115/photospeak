CREATE TABLE "app_store_notifications" (
	"notification_uuid" text PRIMARY KEY NOT NULL,
	"notification_type" text NOT NULL,
	"subtype" text,
	"environment" text NOT NULL,
	"original_transaction_id" text,
	"payload_sha256" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_store_transactions" (
	"transaction_id" text PRIMARY KEY NOT NULL,
	"original_transaction_id" text NOT NULL,
	"user_id" text NOT NULL,
	"product_id" text NOT NULL,
	"environment" text NOT NULL,
	"ownership_type" text,
	"purchase_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"signed_at" timestamp with time zone NOT NULL,
	"payload_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_usage_reservations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"period_month" text NOT NULL,
	"client_session_id" text NOT NULL,
	"capability" text NOT NULL,
	"operation_key_hash" text NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user_entitlements" ADD COLUMN "store_product_id" text;--> statement-breakpoint
ALTER TABLE "user_entitlements" ADD COLUMN "original_transaction_id" text;--> statement-breakpoint
ALTER TABLE "app_store_transactions" ADD CONSTRAINT "app_store_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_usage_reservations" ADD CONSTRAINT "subscription_usage_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_store_notifications_original_idx" ON "app_store_notifications" USING btree ("original_transaction_id");--> statement-breakpoint
CREATE INDEX "app_store_transactions_original_idx" ON "app_store_transactions" USING btree ("original_transaction_id");--> statement-breakpoint
CREATE INDEX "app_store_transactions_user_expiry_idx" ON "app_store_transactions" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_usage_user_month_session_capability_idx" ON "subscription_usage_reservations" USING btree ("user_id","period_month","client_session_id","capability");--> statement-breakpoint
CREATE INDEX "subscription_usage_user_period_idx" ON "subscription_usage_reservations" USING btree ("user_id","period_month","capability","state");