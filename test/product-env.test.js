"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { productEnvLines, redactUrl, renderProductEnv } = require("../src/product-env");

function tenant(overrides = {}) {
  return {
    slug: "demo-client",
    databaseUrl: "postgresql://a1:secret@postgres:5432/a1_tenant_demo_client",
    modules: [
      { code: "studio", enabled: true },
      { code: "hayhashvapah", enabled: true },
      { code: "crm", enabled: true }
    ],
    ...overrides
  };
}

test("renders CRM env for platform Postgres JSONB storage", () => {
  const output = renderProductEnv(tenant(), "crm", {
    platformApiUrl: "http://platform:4200",
    platformToken: "platform-token"
  });

  assert.match(output, /# demo-client crm service environment/);
  assert.match(output, /A1_PLATFORM_TENANT_RESOLUTION=1/);
  assert.match(output, /A1_PLATFORM_API_URL=http:\/\/platform:4200/);
  assert.match(output, /A1_PLATFORM_TOKEN=platform-token/);
  assert.match(output, /A1_PLATFORM_TENANT_STRICT=1/);
  assert.match(output, /A1_CRM_STORAGE=platform-postgres/);
  assert.match(output, /A1_CRM_DATABASE_URL=postgresql:\/\/a1:secret@postgres:5432\/a1_tenant_demo_client/);
});

test("redacts sensitive URLs and platform token when requested", () => {
  const output = renderProductEnv(tenant(), "crm", {
    platformToken: "platform-token",
    redact: true
  });

  assert.match(output, /A1_PLATFORM_TOKEN=REDACTED/);
  assert.match(output, /A1_CRM_DATABASE_URL=postgresql:\/\/a1:REDACTED@postgres:5432\/a1_tenant_demo_client/);
  assert.equal(redactUrl("not-a-url"), "REDACTED");
});

test("renders all product env sections and external data roots", () => {
  const output = renderProductEnv(tenant(), "all", { strict: false });

  assert.match(output, /# demo-client studio service environment/);
  assert.match(output, /ARMOSPHERA_ONE_DB=\/opt\/a1\/product-data\/studio\/armosphera-one.db/);
  assert.match(output, /# demo-client hayhashvapah service environment/);
  assert.match(output, /A1_HAYHASHVAPAH_DATA_DIR=\/opt\/a1\/product-data\/hayhashvapah/);
  assert.match(output, /# demo-client crm service environment/);
  assert.match(output, /A1_PLATFORM_TENANT_STRICT=\n/);
});

test("refuses env for disabled tenant modules", () => {
  assert.throws(
    () => productEnvLines(tenant({ modules: [{ code: "crm", enabled: false }] }), "crm"),
    /crm is not enabled for tenant demo-client/
  );
});
