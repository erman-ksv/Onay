ALTER TABLE tezjet_admin_audit_events ALTER COLUMN order_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE tezjet_admin_audit_events ADD COLUMN driver_id text;
--> statement-breakpoint
ALTER TABLE tezjet_admin_audit_events ADD COLUMN vehicle_revision text;
--> statement-breakpoint
CREATE INDEX tezjet_admin_audit_driver_created_idx ON tezjet_admin_audit_events (driver_id, created_at, id);
