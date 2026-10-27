-- Expand route metadata without changing any route/order JSON or interpreting
-- historical KZT numbers as UZS. New code treats route payloads as authoritative.
ALTER TABLE tezjet_routes ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'KZT';
--> statement-breakpoint
ALTER TABLE tezjet_routes ADD COLUMN IF NOT EXISTS price_per_stop integer;
--> statement-breakpoint
ALTER TABLE tezjet_routes ALTER COLUMN price_per_stop_kzt DROP NOT NULL;
--> statement-breakpoint
UPDATE tezjet_routes SET price_per_stop = price_per_stop_kzt
WHERE currency = 'KZT' AND price_per_stop IS NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'tezjet_routes'::regclass
      AND conname = 'tezjet_routes_currency_pricing_check'
  ) THEN
    ALTER TABLE tezjet_routes ADD CONSTRAINT tezjet_routes_currency_pricing_check CHECK (
      (currency = 'KZT' AND price_per_stop_kzt IS NOT NULL AND price_per_stop_kzt >= 0
        AND (price_per_stop IS NULL OR price_per_stop >= 0))
      OR (currency = 'UZS' AND price_per_stop IS NOT NULL AND price_per_stop >= 0
        AND price_per_stop_kzt IS NULL)
    );
  END IF;
END $$;
