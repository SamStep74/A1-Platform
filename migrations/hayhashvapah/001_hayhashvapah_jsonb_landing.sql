CREATE SCHEMA IF NOT EXISTS hayhashvapah;

CREATE TABLE IF NOT EXISTS hayhashvapah.accounts (
  email TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hayhashvapah.sessions (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL REFERENCES hayhashvapah.accounts(email) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS hayhashvapah.audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hayhashvapah.meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hayhashvapah.files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_email TEXT REFERENCES hayhashvapah.accounts(email) ON DELETE SET NULL,
  product_area TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  checksum TEXT,
  doc JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hayhashvapah_sessions_expires ON hayhashvapah.sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_hayhashvapah_audit_created ON hayhashvapah.audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hayhashvapah_files_area ON hayhashvapah.files(product_area, created_at DESC);
