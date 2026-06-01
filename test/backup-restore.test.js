"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { backupFull, restoreFull } = require("../src/backup-restore");
const { LocalTenantStorage } = require("../src/storage");

function fixedNow() {
  return new Date("2026-06-01T12:00:00.000Z");
}

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
  studio_legacy_rows: 1,
  hayhashvapah_accounts: 1,
  crm_records: 1
});

function fakeDb(options = {}) {
  let tenant = fakeTenant();
  const operations = [];
  const counts = options.counts || DEFAULT_COUNTS;
  return {
    operations,
    listTenants: async () => [tenant],
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
    tenantHealth: async () => ({
      ok: true,
      tenant,
      checks: [{ name: "database", ok: true, message: "ok" }]
    })
  };
}

const config = Object.freeze({
  registryUrl: "postgresql://example/a1_registry",
  appVersion: "2026.06.01",
  appEnv: "test",
  storage: { bucket: "a1-documents" },
  backups: { encryptionKey: "" }
});

async function fakeRunner(command, args) {
  if (command === "pg_dump") {
    const file = args[args.indexOf("--file") + 1];
    await fs.writeFile(file, "fake dump", "utf8");
  }
  if (command === "pg_restore") {
    const file = args.at(-1);
    await fs.readFile(file, "utf8");
  }
  return { stdout: "", stderr: "" };
}

test("full backup and restore writes a restore report with tenant checks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "a1-full-restore-report-"));
  const sourceStorage = new LocalTenantStorage({ root: path.join(root, "source-storage"), bucket: "a1-documents" });
  await sourceStorage.putObject("demo-client", "crm", "documents/quote.txt", "quote");

  const backup = await backupFull({
    platformDb: fakeDb(),
    storage: sourceStorage,
    config,
    runner: fakeRunner,
    now: fixedNow
  }, { out: path.join(root, "backups", "full") });

  const targetStorage = new LocalTenantStorage({ root: path.join(root, "target-storage"), bucket: "a1-documents" });
  const restore = await restoreFull({
    platformDb: fakeDb(),
    storage: targetStorage,
    config,
    runner: fakeRunner,
    now: fixedNow
  }, { backupDir: backup.backupDir, activate: true });

  assert.equal(restore.ok, true);
  assert.deepEqual(restore.restored, ["demo-client"]);
  const report = JSON.parse(await fs.readFile(path.join(backup.backupDir, "restore-report.json"), "utf8"));
  assert.equal(report.ok, true);
  assert.equal(report.registry.ok, true);
  assert.equal(report.backup_metadata.tenant_count, 1);
  assert.equal(report.tenants[0].slug, "demo-client");
  assert.equal(report.tenants[0].restored_files, 1);
  assert.equal(report.tenants[0].activated, true);
  assert.equal(report.tenants[0].checks.some((check) => check.name === "storage" && check.ok), true);
});

test("failed full restore writes a failure report before throwing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "a1-full-restore-fail-report-"));
  const storage = new LocalTenantStorage({ root: path.join(root, "storage"), bucket: "a1-documents" });
  const backup = await backupFull({
    platformDb: fakeDb({ counts: { ...DEFAULT_COUNTS, crm_records: 2 } }),
    storage,
    config,
    runner: fakeRunner,
    now: fixedNow
  }, { out: path.join(root, "backups", "full") });

  const reportOut = path.join(root, "restore-reports", "failed.json");
  await assert.rejects(
    () => restoreFull({
      platformDb: fakeDb({ counts: { ...DEFAULT_COUNTS, crm_records: 1 } }),
      storage,
      config,
      runner: fakeRunner,
      now: fixedNow
    }, { backupDir: backup.backupDir, reportOut }),
    /counts:database_rows/
  );

  const report = JSON.parse(await fs.readFile(reportOut, "utf8"));
  assert.equal(report.ok, false);
  assert.equal(report.registry.ok, true);
  assert.equal(report.tenants[0].slug, "demo-client");
  assert.equal(report.tenants[0].ok, false);
  assert.match(report.tenants[0].error.message, /counts:database_rows/);
});
