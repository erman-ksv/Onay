ALTER TABLE tezjet_admin_audit_events ALTER COLUMN from_status DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE tezjet_admin_audit_events ALTER COLUMN to_status DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE tezjet_admin_audit_events ADD COLUMN route_id text;
--> statement-breakpoint
ALTER TABLE tezjet_admin_audit_events ADD COLUMN changed_fields jsonb;
--> statement-breakpoint
ALTER TABLE tezjet_admin_audit_events ADD COLUMN previous_version text;
--> statement-breakpoint
ALTER TABLE tezjet_admin_audit_events ADD COLUMN next_version text;
--> statement-breakpoint
CREATE INDEX tezjet_admin_audit_route_created_idx ON tezjet_admin_audit_events (route_id, created_at, id);
