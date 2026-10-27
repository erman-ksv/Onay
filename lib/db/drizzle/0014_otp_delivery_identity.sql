-- One nullable identity per challenge permits CAS cleanup after a definitive
-- provider rejection without deleting a newer challenge (even with the same code).
ALTER TABLE tezjet_otp_challenges ADD COLUMN IF NOT EXISTS delivery_id text;
