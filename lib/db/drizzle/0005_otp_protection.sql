CREATE TABLE "otp_rate_limits" (
  "key" text PRIMARY KEY NOT NULL,
  "state" jsonb NOT NULL,
  "expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "otp_rate_limits_expiry_idx" ON "otp_rate_limits" ("expires_at");
--> statement-breakpoint
CREATE INDEX "tezjet_otp_challenges_expiry_idx" ON "tezjet_otp_challenges" ("expires_at");
