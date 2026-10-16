-- 0002_field_templates.sql — reusable sets of profile field definitions (FR-FRM-20) and choice options.
CREATE TABLE field_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  built_in INTEGER NOT NULL DEFAULT 0,
  fields_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE profile_fields ADD COLUMN options_json TEXT NOT NULL DEFAULT '[]';
