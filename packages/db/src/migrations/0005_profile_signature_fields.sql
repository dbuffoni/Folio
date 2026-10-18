-- 0005_profile_signature_fields.sql — a profile entry can be of type "signature": its value is the id of a saved signature.
-- SQLite cannot change a CHECK constraint, so the table is rebuilt with the new list of types.
CREATE TABLE profile_fields_new (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text','date','number','phone','email','address','choice','multiline','signature')),
  value TEXT,
  sensitive INTEGER NOT NULL DEFAULT 0,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  options_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(profile_id, key)
);
INSERT INTO profile_fields_new (id, profile_id, key, label, type, value, sensitive, aliases_json, sort_order, options_json)
  SELECT id, profile_id, key, label, type, value, sensitive, aliases_json, sort_order, options_json FROM profile_fields;
DROP TABLE profile_fields;
ALTER TABLE profile_fields_new RENAME TO profile_fields;
