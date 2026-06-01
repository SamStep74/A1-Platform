CREATE SCHEMA IF NOT EXISTS studio;

CREATE TABLE IF NOT EXISTS studio.sqlite_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  app_version TEXT NOT NULL,
  row_counts JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS studio.legacy_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id UUID NOT NULL REFERENCES studio.sqlite_import_batches(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  source_pk TEXT NOT NULL,
  doc JSONB NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(import_batch_id, table_name, source_pk)
);

CREATE TABLE IF NOT EXISTS studio.documents (
  id TEXT PRIMARY KEY,
  organization_id UUID REFERENCES core.organizations(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  sealed_checksum TEXT,
  storage_key TEXT,
  doc JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_studio_legacy_rows_table ON studio.legacy_rows(table_name);
CREATE INDEX IF NOT EXISTS idx_studio_documents_org_status ON studio.documents(organization_id, status);
