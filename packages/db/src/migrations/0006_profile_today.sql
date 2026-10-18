-- 0006_profile_today.sql — an entry of type "today" is filled with the date of the day when a form is filled.
-- The CHECK list of types is rebuilt again; an empty "today" date entry of the built-in set becomes one.
CREATE TABLE profile_fields_new (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text','date','number','phone','email','address','choice','multiline','signature','today')),
  value TEXT,
  sensitive INTEGER NOT NULL DEFAULT 0,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  options_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(profile_id, key)
);
INSERT INTO profile_fields_new (id, profile_id, key, label, type, value, sensitive, aliases_json, sort_order, options_json)
  SELECT id, profile_id, key,
         CASE WHEN key = 'today' AND type = 'date' AND COALESCE(value, '') = '' THEN 'Today''s date' ELSE label END,
         CASE WHEN key = 'today' AND type = 'date' AND COALESCE(value, '') = '' THEN 'today' ELSE type END,
         value, sensitive, aliases_json, sort_order, options_json FROM profile_fields;
DROP TABLE profile_fields;
ALTER TABLE profile_fields_new RENAME TO profile_fields;
