ALTER TABLE "tezjet_driver_queue" ADD COLUMN IF NOT EXISTS "pending_offer_order_id" text;
--> statement-breakpoint
ALTER TABLE "tezjet_orders" ADD COLUMN IF NOT EXISTS "offer_expires_at" bigint;
--> statement-breakpoint
-- Older searching offers reserved no seats and had no durable deadline.
-- Reopen those offers before enforcing one pending offer per driver. The
-- dispatcher will select and reserve them after the API starts again.
UPDATE "tezjet_orders"
SET "offered_driver_id" = NULL,
    "payload" = "payload" - 'offeredDriverId' - 'offerExpiresAt'
WHERE "status" = 'searching' AND "offer_expires_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tezjet_orders_offer_expiry_idx"
ON "tezjet_orders" USING btree ("status", "offer_expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tezjet_orders_pending_driver_uq"
ON "tezjet_orders" USING btree ("offered_driver_id")
WHERE "status" = 'searching' AND "offered_driver_id" IS NOT NULL;
