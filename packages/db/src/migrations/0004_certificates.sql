-- 0004_certificates.sql — public data of signing identities and trusted certificates (digital signatures).
-- Private keys never enter the database: they stay in the OS keychain or in the user's original file.
CREATE TABLE certificates (
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('identity','trusted')),
  common_name TEXT NOT NULL,
  subject TEXT NOT NULL,
  issuer TEXT NOT NULL,
  serial TEXT NOT NULL,
  not_before TEXT NOT NULL,
  not_after TEXT NOT NULL,
  key_algorithm TEXT NOT NULL,
  key_usage_json TEXT NOT NULL DEFAULT '[]',
  self_signed INTEGER NOT NULL DEFAULT 0,
  is_ca INTEGER NOT NULL DEFAULT 0,
  der TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (fingerprint, kind)
);
