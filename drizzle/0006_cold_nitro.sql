-- IF NOT EXISTS: the deployed database already had both columns without this migration recorded (2026-10-10).
ALTER TABLE "profile" ADD COLUMN IF NOT EXISTS "data_from" date;--> statement-breakpoint
ALTER TABLE "profile" ADD COLUMN IF NOT EXISTS "device_switch_dismissed" date;
