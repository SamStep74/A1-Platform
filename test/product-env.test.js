"use strict";

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { productEnvLines, redactUrl, renderProductEnv, writeProductEnvFiles } = require("../src/product-env");

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

test("renders HayHashvapah env for platform Postgres JSONB storage", () => {
  const output = renderProductEnv(tenant(), "hayhashvapah", {
    platformApiUrl: "http://platform:4200",
    platformToken: "platform-token"
  });

  assert.match(output, /# demo-client hayhashvapah service environment/);
  assert.match(output, /A1_PLATFORM_TENANT_RESOLUTION=1/);
  assert.match(output, /A1_PLATFORM_API_URL=http:\/\/platform:4200/);
  assert.match(output, /A1_PLATFORM_TOKEN=platform-token/);
  assert.match(output, /A1_HAYHASHVAPAH_STORAGE=platform-postgres/);
  assert.match(output, /A1_HAYHASHVAPAH_DATABASE_URL=postgresql:\/\/a1:secret@postgres:5432\/a1_tenant_demo_client/);
  assert.match(output, /A1_HAYHASHVAPAH_TENANT_SLUG=demo-client/);
  assert.match(output, /A1_HAYHASHVAPAH_DATA_DIR=\/opt\/a1\/product-data\/hayhashvapah/);
  assert.match(output, /A1_HAYHASHVAPAH_SUITE_DATA_DIR=\/opt\/a1\/product-data\/hayhashvapah-suite/);
});

test("redacts sensitive URLs and platform token when requested", () => {
  const output = renderProductEnv(tenant(), "all", {
    platformToken: "platform-token",
    redact: true
  });

  assert.match(output, /A1_PLATFORM_TOKEN=REDACTED/);
  assert.match(output, /A1_HAYHASHVAPAH_DATABASE_URL=postgresql:\/\/a1:REDACTED@postgres:5432\/a1_tenant_demo_client/);
  assert.match(output, /A1_CRM_DATABASE_URL=postgresql:\/\/a1:REDACTED@postgres:5432\/a1_tenant_demo_client/);
  assert.equal(redactUrl("not-a-url"), "REDACTED");
});

test("renders all product env sections and external data roots", () => {
  const output = renderProductEnv(tenant(), "all", { strict: false });

  assert.match(output, /# demo-client studio service environment/);
  assert.match(output, /ARMOSPHERA_ONE_DB=\/opt\/a1\/product-data\/studio\/armosphera-one.db/);
  assert.match(output, /A1_STUDIO_DATA_DIR=\/opt\/a1\/product-data\/studio/);
  assert.match(output, /A1_STUDIO_SQLITE=\/opt\/a1\/product-data\/studio\/armosphera-one.db/);
  assert.match(output, /# demo-client hayhashvapah service environment/);
  assert.match(output, /A1_HAYHASHVAPAH_STORAGE=platform-postgres/);
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

test("writes per-product env files and a manifest", async () => {
  const out = await fsp.mkdtemp(path.join(os.tmpdir(), "a1-product-env-"));
  const result = await writeProductEnvFiles(tenant(), "all", out, {
    platformToken: "platform-token",
    redact: true
  });

  assert.equal(result.files.length, 3);
  assert.deepEqual(result.files.map((file) => file.productCode), ["studio", "hayhashvapah", "crm"]);
  assert.equal(path.basename(result.manifestPath), "demo-client.manifest.json");

  const crm = await fsp.readFile(path.join(out, "demo-client.crm.env"), "utf8");
  assert.match(crm, /A1_CRM_STORAGE=platform-postgres/);
  assert.match(crm, /A1_CRM_DATABASE_URL=postgresql:\/\/a1:REDACTED@postgres:5432\/a1_tenant_demo_client/);

  const hayhashvapah = await fsp.readFile(path.join(out, "demo-client.hayhashvapah.env"), "utf8");
  assert.match(hayhashvapah, /A1_HAYHASHVAPAH_STORAGE=platform-postgres/);
  assert.match(hayhashvapah, /A1_HAYHASHVAPAH_DATABASE_URL=postgresql:\/\/a1:REDACTED@postgres:5432\/a1_tenant_demo_client/);
  assert.match(hayhashvapah, /A1_HAYHASHVAPAH_TENANT_SLUG=demo-client/);

  const manifest = JSON.parse(await fsp.readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.tenantSlug, "demo-client");
  assert.equal(manifest.redacted, true);
  assert.deepEqual(manifest.products, ["studio", "hayhashvapah", "crm"]);
  assert.deepEqual(manifest.files, [
    { productCode: "studio", path: "demo-client.studio.env" },
    { productCode: "hayhashvapah", path: "demo-client.hayhashvapah.env" },
    { productCode: "crm", path: "demo-client.crm.env" }
  ]);
  assert.equal(manifest.files.every((file) => !path.isAbsolute(file.path)), true);
});
