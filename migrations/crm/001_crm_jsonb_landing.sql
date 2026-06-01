CREATE SCHEMA IF NOT EXISTS crm;

CREATE TABLE IF NOT EXISTS crm.tenant_blueprints (
  slug TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm.records (
  slug TEXT PRIMARY KEY REFERENCES crm.tenant_blueprints(slug) ON DELETE CASCADE,
  doc JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm.files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL REFERENCES crm.tenant_blueprints(slug) ON DELETE CASCADE,
  area TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  checksum TEXT,
  doc JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm.audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL REFERENCES crm.tenant_blueprints(slug) ON DELETE CASCADE,
  actor TEXT NOT NULL DEFAULT 'system',
  event_type TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_files_slug_area ON crm.files(slug, area, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_audit_slug_created ON crm.audit_log(slug, created_at DESC);
