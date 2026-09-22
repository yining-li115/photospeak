ALTER TABLE "ai_usage_events" ADD COLUMN "estimated_cost_micros" integer;--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD COLUMN "billing_currency" text;