CREATE TABLE "hrv_days" (
	"user_id" integer NOT NULL,
	"bucket" integer NOT NULL,
	"offsets" integer[] NOT NULL,
	"values" smallint[] NOT NULL,
	CONSTRAINT "hrv_days_user_id_bucket_pk" PRIMARY KEY("user_id","bucket")
);
--> statement-breakpoint
CREATE TABLE "sleep_short_awakenings" (
	"user_id" integer NOT NULL,
	"session_id" text NOT NULL,
	"start_ts" bigint NOT NULL,
	"end_ts" bigint NOT NULL,
	"stage" text NOT NULL,
	CONSTRAINT "sleep_short_awakenings_user_id_session_id_start_ts_pk" PRIMARY KEY("user_id","session_id","start_ts")
);
--> statement-breakpoint
CREATE TABLE "spo2_days" (
	"user_id" integer NOT NULL,
	"bucket" integer NOT NULL,
	"offsets" integer[] NOT NULL,
	"values" smallint[] NOT NULL,
	CONSTRAINT "spo2_days_user_id_bucket_pk" PRIMARY KEY("user_id","bucket")
);
--> statement-breakpoint
ALTER TABLE "daily_metrics" ADD COLUMN "non_rem_hr_bpm" double precision;--> statement-breakpoint
ALTER TABLE "hrv_days" ADD CONSTRAINT "hrv_days_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sleep_short_awakenings" ADD CONSTRAINT "sleep_short_awakenings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sleep_short_awakenings" ADD CONSTRAINT "sleep_short_awakenings_user_id_session_id_sleep_sessions_user_id_id_fk" FOREIGN KEY ("user_id","session_id") REFERENCES "public"."sleep_sessions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spo2_days" ADD CONSTRAINT "spo2_days_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Version 35 reads new fields from types already synced (the non-REM heart rate on daily-heart-rate-variability, brief
-- awakenings on sleep). A synced account only re-fetches their last few days, so rewind both cursors to the 180-day
-- backfill: the next sync re-lists them quietly (no import banner; backfill progress is left as done).
UPDATE "sync_state" SET "synced_through" = LEAST("synced_through", EXTRACT(EPOCH FROM now())::bigint - 181 * 86400) WHERE "type" IN ('daily-heart-rate-variability', 'sleep') AND "synced_through" IS NOT NULL;
