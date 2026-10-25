CREATE TABLE tezjet_admin_audit_events (
  id text PRIMARY KEY,
  actor_id text NOT NULL,
  action text NOT NULL,
  order_id text NOT NULL,
  from_status text NOT NULL,
  to_status text NOT NULL,
  created_at text NOT NULL
);
--> statement-breakpoint
CREATE INDEX tezjet_admin_audit_created_idx ON tezjet_admin_audit_events (created_at, id);
--> statement-breakpoint
CREATE INDEX tezjet_admin_audit_order_created_idx ON tezjet_admin_audit_events (order_id, created_at, id);
--> statement-breakpoint
CREATE UNIQUE INDEX tezjet_admin_audit_action_order_uq ON tezjet_admin_audit_events (action, order_id);
--> statement-breakpoint
CREATE FUNCTION reject_admin_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ADMIN_AUDIT_APPEND_ONLY' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER admin_audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON tezjet_admin_audit_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_admin_audit_mutation();
