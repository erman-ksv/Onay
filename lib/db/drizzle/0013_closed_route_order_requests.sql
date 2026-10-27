-- A closed passenger/key remains fenced forever, including after process restart.
-- No existing receipt or order is changed. Do not prune these identities by TTL.
CREATE TABLE IF NOT EXISTS tezjet_closed_route_order_requests (
  passenger_id text NOT NULL,
  request_key text NOT NULL,
  closed_at text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS tezjet_closed_route_requests_passenger_key_uq
  ON tezjet_closed_route_order_requests (passenger_id, request_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS tezjet_closed_route_requests_passenger_time_idx
  ON tezjet_closed_route_order_requests (passenger_id, closed_at);
--> statement-breakpoint
-- Keep the exact existing application lock identity, without JSON separator spaces.
-- The schema is selected by the triggering table, never by an assumed public path.
CREATE OR REPLACE FUNCTION tezjet_guard_route_request_fence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE counterpart text; conflict_exists boolean;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    pg_catalog.format('["onay-route-order",%s,%s]', pg_catalog.to_json(NEW.passenger_id), pg_catalog.to_json(NEW.request_key)), 0));
  counterpart := CASE WHEN TG_TABLE_NAME = 'tezjet_route_order_requests'
    THEN 'tezjet_closed_route_order_requests' ELSE 'tezjet_route_order_requests' END;
  EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE passenger_id=$1 AND request_key=$2)', TG_TABLE_SCHEMA, counterpart)
    INTO conflict_exists USING NEW.passenger_id, NEW.request_key;
  IF conflict_exists THEN
    RAISE EXCEPTION 'Booking request identity is already resolved' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tezjet_route_request_fence_receipt ON tezjet_route_order_requests;
CREATE TRIGGER tezjet_route_request_fence_receipt BEFORE INSERT ON tezjet_route_order_requests
  FOR EACH ROW EXECUTE FUNCTION tezjet_guard_route_request_fence();
--> statement-breakpoint
DROP TRIGGER IF EXISTS tezjet_route_request_fence_closed ON tezjet_closed_route_order_requests;
CREATE TRIGGER tezjet_route_request_fence_closed BEFORE INSERT ON tezjet_closed_route_order_requests
  FOR EACH ROW EXECUTE FUNCTION tezjet_guard_route_request_fence();
