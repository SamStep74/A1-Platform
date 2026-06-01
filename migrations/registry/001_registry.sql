CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  company_name TEXT NOT NULL,
  primary_domain TEXT NOT NULL UNIQUE,
  database_name TEXT NOT NULL UNIQUE,
  storage_prefix TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active','maintenance','suspended','migrating','archived')),
  deployment_target TEXT NOT NULL,
  app_version TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'am',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_modules (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL CHECK (module_code IN ('studio','hayhashvapah','crm')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  schema_version TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (tenant_id, module_code)
);

CREATE TABLE IF NOT EXISTS tenant_routes (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  host TEXT NOT NULL UNIQUE,
  product_code TEXT NOT NULL CHECK (product_code IN ('studio','hayhashvapah','crm','unified')),
  target_url TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, host)
);

CREATE TABLE IF NOT EXISTS tenant_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  source_target TEXT,
  destination_target TEXT,
  artifact_path TEXT,
  checksum TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
CREATE INDEX IF NOT EXISTS idx_tenant_operations_tenant_started ON tenant_operations(tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_routes_active ON tenant_routes(host) WHERE active = true;
