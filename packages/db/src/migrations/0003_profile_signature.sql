-- 0003_profile_signature.sql — a profile can name one saved signature to put into signature fields (Smart Fill).
ALTER TABLE profiles ADD COLUMN signature_id TEXT REFERENCES signatures(id) ON DELETE SET NULL;
