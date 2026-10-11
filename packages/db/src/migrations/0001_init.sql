-- 0001_init.sql — application data only (SPEC §9). PDF content never goes into the database.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE recent_files (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  path TEXT,
  fingerprint TEXT NOT NULL,
  page_count INTEGER,
  last_page INTEGER DEFAULT 0,
  last_zoom REAL,
  thumbnail BLOB,
  last_opened_at TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_recent_opened ON recent_files(last_opened_at DESC);

CREATE TABLE signatures (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('signature','initials')),
  source TEXT NOT NULL CHECK (source IN ('drawn','typed','image')),
  svg TEXT,
  png BLOB NOT NULL,
  width REAL NOT NULL, height REAL NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE stamps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('builtin','text','image','date','selection')),
  payload_json TEXT NOT NULL,
  png BLOB,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE profile_fields (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text','date','number','phone','email','address','choice','multiline')),
  value TEXT,
  sensitive INTEGER NOT NULL DEFAULT 0,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(profile_id, key)
);

CREATE TABLE form_mappings (
  id TEXT PRIMARY KEY,
  doc_fingerprint TEXT NOT NULL,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  mapping_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('ai','heuristic','manual')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(doc_fingerprint, profile_id)
);

CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  model TEXT NOT NULL,
  mode TEXT NOT NULL,
  included_image INTEGER NOT NULL,
  input_tokens INTEGER, output_tokens INTEGER,
  status TEXT NOT NULL
);

CREATE TABLE history_spill (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
