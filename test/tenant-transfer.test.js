"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { LocalTenantStorage } = require("../src/storage");
const { exportTenant, importTenant } = require("../src/tenant-transfer");

function fakeTenant(status = "active") {
  return {
    id: "tenant-1",
    slug: "demo-client",
    companyName: "Demo Client LLC",
    primaryDomain: "demo-client.a1suite.am",
    databaseName: "a1_tenant_demo_client",
    databaseUrl: "postgresql://example/a1_tenant_demo_client",
    storagePrefix: "tenants/demo-client/",
    status,
    deploymentTarget: "local",
    appVersion: "2026.06.01",
    region: "am",
    modules: [
      { code: "studio", enabled: true, schemaVersion: "1" },
      { code: "hayhashvapah", enabled: true, schemaVersion: "1" },
      { code: "crm", enabled: true, schemaVersion: "1" }
    ],
    routes: [{ host: "demo-client.a1suite.am", productCode: "unified", targetUrl: "http://api:4200", active: true }]
  };
}

const DEFAULT_COUNTS = Object.freeze({
  studio_legacy_rows: 223,
  hayhashvapah_accounts: 8,
  hayhashvapah_sessions: 16,
  crm_records: 0
});

function fakeDb(options = {}) {
  let tenant = fakeTenant();
  const operations = [];
  const counts = options.counts || DEFAULT_COUNTS;
  return {
    operations,
    getTenantBySlug: async () => tenant,
    setTenantStatus: async (_slug, status) => { tenant = { ...tenant, status }; return tenant; },
    recordOperation: async (_slug, operation, status, details) => {
      const row = { id: `op-${operations.length + 1}`, operation, status, ...details };
      operations.push(row);
      return row;
    },
    finishOperation: async (id, status, details) => {
      const row = operations.find((item) => item.id === id);
      Object.assign(row, { status, ...details });
      return row;
    },
    tenantDataCounts: async () => counts,
    upsertTenantFromRegistry: async () => tenant,
    runTenantMigrations: async () => [],
    tenantHealth: async () => ({ ok: true, tenant, checks: [{ name: "database", ok: true, message: "ok" }] })
  };
}

async function fakeRunner(command, args) {
  if (command === "pg_dump") {
    const file = args[args.indexOf("--file") + 1];
    await fs.writeFile(file, "fake dump", "utf8");
  }
  return { stdout: "", stderr: "" };
}

test("exports a portable tenant bundle with metadata, registry, dump, files, and checksums", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "a1-transfer-"));
  const storage = new LocalTenantStorage({ root: path.join(root, "storage"), bucket: "a1-documents" });
  await storage.putObject("demo-client", "crm", "documents/quote.txt", "quote");

  const platformDb = fakeDb();
  const result = await exportTenant({
    platformDb,
    storage,
    slug: "demo-client",
    outputRoot: path.join(root, "exports"),
    runner: fakeRunner
  });

  assert.equal(await fs.readFile(path.join(result.outputDir, "db.dump"), "utf8"), "fake dump");
  const metadata = JSON.parse(await fs.readFile(path.join(result.outputDir, "metadata.json"), "utf8"));
  assert.equal(metadata.tenant, "demo-client");
  assert.equal(metadata.counts.storage_files, 1);
  assert.equal(metadata.counts.database_rows.studio_legacy_rows, 223);
  assert.equal(metadata.counts.database_rows.hayhashvapah_accounts, 8);
  assert.equal(metadata.counts.database_rows.crm_records, 0);
  assert.equal(JSON.parse(await fs.readFile(path.join(result.outputDir, "registry.json"), "utf8")).tenant.database_name, "a1_tenant_demo_client");
  assert.match(await fs.readFile(path.join(result.outputDir, "checksums.txt"), "utf8"), /db\.dump/);
  assert.equal(platformDb.operations.at(-1).status, "completed");
});

test("imports a verified tenant bundle and restores files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "a1-import-transfer-"));
  const sourceStorage = new LocalTenantStorage({ root: path.join(root, "source-storage"), bucket: "a1-documents" });
  await sourceStorage.putObject("demo-client", "crm", "documents/quote.txt", "quote");

  const exportResult = await exportTenant({
    platformDb: fakeDb(),
    storage: sourceStorage,
    slug: "demo-client",
    outputRoot: path.join(root, "exports"),
    runner: fakeRunner
  });

  const targetStorage = new LocalTenantStorage({ root: path.join(root, "target-storage"), bucket: "a1-documents" });
  const result = await importTenant({
    platformDb: fakeDb(),
    storage: targetStorage,
    slug: "demo-client",
    importDir: exportResult.outputDir,
    activate: true,
    runner: fakeRunner
  });

  assert.equal(result.tenant.slug, "demo-client");
  assert.equal(result.restoredFiles, 1);
  assert.equal(result.checks.find((check) => check.name === "counts:database_rows").ok, true);
  assert.equal(result.checks.find((check) => check.name === "counts:storage_files").ok, true);
  assert.equal(String(await targetStorage.getObject("demo-client", "crm", "documents/quote.txt")), "quote");
});

test("import fails when restored row counts do not match export metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "a1-import-count-mismatch-"));
  const storage = new LocalTenantStorage({ root: path.join(root, "storage"), bucket: "a1-documents" });
  const exportResult = await exportTenant({
    platformDb: fakeDb({ counts: { ...DEFAULT_COUNTS, crm_records: 1 } }),
    storage,
    slug: "demo-client",
    outputRoot: path.join(root, "exports"),
    runner: fakeRunner
  });

  await assert.rejects(
    () => importTenant({
      platformDb: fakeDb({ counts: { ...DEFAULT_COUNTS, crm_records: 0 } }),
      storage,
      slug: "demo-client",
      importDir: exportResult.outputDir,
      activate: true,
      runner: fakeRunner
    }),
    /counts:database_rows/
  );
});
