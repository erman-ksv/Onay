CREATE TABLE "tezjet_route_order_requests" (
  "passenger_id" text NOT NULL,
  "request_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "order_id" text NOT NULL,
  "created_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tezjet_route_order_requests_passenger_key_uq" ON "tezjet_route_order_requests" USING btree ("passenger_id", "request_key");
