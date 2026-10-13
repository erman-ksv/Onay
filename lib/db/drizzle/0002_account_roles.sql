ALTER TABLE "tezjet_users" ADD COLUMN "roles" jsonb;
--> statement-breakpoint
UPDATE "tezjet_users" SET "roles" = jsonb_build_array("role");
--> statement-breakpoint
ALTER TABLE "tezjet_users" ALTER COLUMN "roles" SET DEFAULT '["passenger"]'::jsonb;
--> statement-breakpoint
ALTER TABLE "tezjet_users" ALTER COLUMN "roles" SET NOT NULL;
--> statement-breakpoint
UPDATE "tezjet_users" SET "driver_approval_status" = 'pending'
WHERE "roles" ? 'driver' AND "driver_approval_status" IS NULL;
