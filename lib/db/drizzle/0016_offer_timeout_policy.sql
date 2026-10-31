CREATE TABLE tezjet_offer_policy (
  id text PRIMARY KEY CHECK (id = 'offer-timeout'),
  seconds integer,
  revision text,
  updated_at text,
  CONSTRAINT tezjet_offer_policy_value_check CHECK (
    (seconds IS NULL AND revision IS NULL AND updated_at IS NULL) OR
    (seconds BETWEEN 1 AND 3600 AND seconds IS NOT NULL AND revision IS NOT NULL AND length(revision) > 0 AND updated_at IS NOT NULL)
  )
);
--> statement-breakpoint
INSERT INTO tezjet_offer_policy (id) VALUES ('offer-timeout');
--> statement-breakpoint
ALTER TABLE tezjet_admin_audit_events ADD COLUMN setting_key text;
--> statement-breakpoint
ALTER TABLE tezjet_admin_audit_events ADD COLUMN previous_value integer;
--> statement-breakpoint
ALTER TABLE tezjet_admin_audit_events ADD COLUMN next_value integer;
--> statement-breakpoint
ALTER TABLE tezjet_admin_audit_events ADD CONSTRAINT tezjet_admin_audit_offer_timeout_check CHECK (
  action <> 'settings.offer_timeout_changed' OR
  (setting_key = 'offer-timeout' AND setting_key IS NOT NULL AND
   previous_value BETWEEN 1 AND 3600 AND previous_value IS NOT NULL AND
   next_value BETWEEN 1 AND 3600 AND next_value IS NOT NULL AND next_version IS NOT NULL)
);
