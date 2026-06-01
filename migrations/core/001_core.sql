CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS core;

CREATE TABLE IF NOT EXISTS core.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_slug TEXT NOT NULL,
  name TEXT NOT NULL,
  legal_name TEXT,
  tax_id TEXT,
  locale TEXT NOT NULL DEFAULT 'hy-AM',
  currency TEXT NOT NULL DEFAULT 'AMD',
  market TEXT NOT NULL DEFAULT 'Armenia',
  data_region TEXT NOT NULL DEFAULT 'Armenia hosted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.sessions (
  token TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  user_agent TEXT NOT NULL DEFAULT '',
  ip_address TEXT NOT NULL DEFAULT '',
  mfa_verified BOOLEAN NOT NULL DEFAULT false,
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id UUID REFERENCES core.users(id) ON DELETE SET NULL,
  revoked_reason TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS core.apps (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'a1',
  route TEXT NOT NULL,
  maturity TEXT NOT NULL DEFAULT 'production',
  priority INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS core.app_assignments (
  organization_id UUID NOT NULL REFERENCES core.organizations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  app_code TEXT NOT NULL REFERENCES core.apps(code) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (organization_id, role, app_code)
);

CREATE INDEX IF NOT EXISTS idx_core_sessions_user ON core.sessions(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_core_sessions_revoked ON core.sessions(revoked_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_core_users_org ON core.users(organization_id, email);

INSERT INTO core.apps (code, name, category, route, maturity, priority)
VALUES
  ('studio', 'A1 Studio', 'platform', '/studio', 'production', 10),
  ('hayhashvapah', 'A1 HayHashvapah', 'finance', '/finance', 'production', 20),
  ('crm', 'A1 CRM', 'sales', '/crm', 'production', 30)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  route = EXCLUDED.route,
  maturity = EXCLUDED.maturity,
  priority = EXCLUDED.priority;
