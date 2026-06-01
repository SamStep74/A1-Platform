CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id UUID,
  product_code TEXT NOT NULL CHECK (product_code IN ('platform','studio','hayhashvapah','crm')),
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_events_time ON audit.events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_type ON audit.events(product_code, event_type, occurred_at DESC);
