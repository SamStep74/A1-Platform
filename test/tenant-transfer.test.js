"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { LocalTenantStorage } = require("../src/storage");
const { exportTenant, importTenant, checkTenant, moveTenant } = require("../src/tenant-transfer");

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
  let tenant = fakeTenant(options.status || "active");
  const operations = [];
  const importOperations = options.importOperations || operations;
  const updateCalls = [];
  const counts = options.counts || DEFAULT_COUNTS;
  return {
    operations,
    updateCalls,
    getTenantBySlug: async () => tenant,
    setTenantStatus: async (_slug, status) => { tenant = { ...tenant, status }; return tenant; },
    updateTenantDeployment: async (_slug, deploymentTarget, targetUrl = "") => {
      updateCalls.push({ deploymentTarget, targetUrl });
      tenant = {
        ...tenant,
        deploymentTarget,
        routes: tenant.routes.map((route) => route.active && targetUrl ? { ...route, targetUrl } : route)
      };
      return tenant;
    },
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
    listTenantOperations: async () => importOperations,
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

function completedProductImportOperations() {
  return [
    {
      id: "op-studio",
      operation: "product.import.studio",
      status: "completed",
      artifactPath: "/opt/a1/imports/product-sources/source-manifest.json",
      checksum: "studio-checksum",
      finishedAt: new Date("2026-06-01T00:00:00Z")
    },
    {
      id: "op-hayhashvapah",
      operation: "product.import.hayhashvapah",
      status: "completed",
      artifactPath: "/opt/a1/imports/product-sources/source-manifest.json",
      checksum: "hayhashvapah-checksum",
      finishedAt: new Date("2026-06-01T00:01:00Z")
    },
    {
      id: "op-crm",
      operation: "product.import.crm",
      status: "completed",
      artifactPath: "/opt/a1/imports/product-sources/source-manifest.json",
      checksum: "crm-checksum",
      finishedAt: new Date("2026-06-01T00:02:00Z")
    }
  ];
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

test("export can require completed product import operations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "a1-export-product-imports-"));
  const storage = new LocalTenantStorage({ root: path.join(root, "storage"), bucket: "a1-documents" });
  const platformDb = fakeDb({ importOperations: completedProductImportOperations() });

  const result = await exportTenant({
    platformDb,
    storage,
    slug: "demo-client",
    outputRoot: path.join(root, "exports"),
    runner: fakeRunner,
    requireProductImports: true
  });

  assert.equal(await fs.readFile(path.join(result.outputDir, "db.dump"), "utf8"), "fake dump");
  const registry = JSON.parse(await fs.readFile(path.join(result.outputDir, "registry.json"), "utf8"));
  assert.deepEqual(
    registry.operations.map((operation) => ({
      operation: operation.operation,
      status: operation.status,
      artifact_path: operation.artifact_path,
      checksum: operation.checksum
    })),
    [
      {
        operation: "product.import.studio",
        status: "completed",
        artifact_path: "/opt/a1/imports/product-sources/source-manifest.json",
        checksum: "studio-checksum"
      },
      {
        operation: "product.import.hayhashvapah",
        status: "completed",
        artifact_path: "/opt/a1/imports/product-sources/source-manifest.json",
        checksum: "hayhashvapah-checksum"
      },
      {
        operation: "product.import.crm",
        status: "completed",
        artifact_path: "/opt/a1/imports/product-sources/source-manifest.json",
        checksum: "crm-checksum"
      }
    ]
  );
  assert.equal(platformDb.operations.find((item) => item.operation === "tenant.export").status, "completed");
});

test("export aborts when required product import operations are missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "a1-export-product-imports-missing-"));
  const storage = new LocalTenantStorage({ root: path.join(root, "storage"), bucket: "a1-documents" });
  const platformDb = fakeDb({ importOperations: [] });

  await assert.rejects(
    () => exportTenant({
      platformDb,
      storage,
      slug: "demo-client",
      outputRoot: path.join(root, "exports"),
      runner: fakeRunner,
      requireProductImports: true
    }),
    (error) => {
      assert.match(error.message, /Tenant export preflight failed: operation:product\.import\.studio/);
      assert.equal(error.code, "TENANT_PREFLIGHT_FAILED");
      assert.equal(error.statusCode, 409);
      assert.equal(error.failedChecks.some((check) => check.name === "operation:product.import.studio"), true);
      return true;
    }
  );

  assert.equal(platformDb.operations.find((item) => item.operation === "tenant.export").status, "failed");
  assert.equal((await platformDb.getTenantBySlug("demo-client")).status, "active");
  await assert.rejects(
    () => fs.stat(path.join(root, "exports", "demo-client", "metadata.json")),
    /ENOENT/
  );
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

test("import replays product import audit operations from bundle registry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "a1-import-product-audit-"));
  const sourceStorage = new LocalTenantStorage({ root: path.join(root, "source-storage"), bucket: "a1-documents" });
  const exportResult = await exportTenant({
    platformDb: fakeDb({ importOperations: completedProductImportOperations() }),
    storage: sourceStorage,
    slug: "demo-client",
    outputRoot: path.join(root, "exports"),
    runner: fakeRunner,
    requireProductImports: true
  });

  const targetStorage = new LocalTenantStorage({ root: path.join(root, "target-storage"), bucket: "a1-documents" });
  const targetDb = fakeDb();
  await importTenant({
    platformDb: targetDb,
    storage: targetStorage,
    slug: "demo-client",
    importDir: exportResult.outputDir,
    runner: fakeRunner,
    requireProductImports: true
  });

  const replayedOperations = targetDb.operations.filter((operation) => operation.operation.startsWith("product.import."));
  assert.deepEqual(
    replayedOperations.map((operation) => ({
      operation: operation.operation,
      status: operation.status,
      artifactPath: operation.artifactPath,
      checksum: operation.checksum
    })),
    [
      {
        operation: "product.import.studio",
        status: "completed",
        artifactPath: "/opt/a1/imports/product-sources/source-manifest.json",
        checksum: "studio-checksum"
      },
      {
        operation: "product.import.hayhashvapah",
        status: "completed",
        artifactPath: "/opt/a1/imports/product-sources/source-manifest.json",
        checksum: "hayhashvapah-checksum"
      },
      {
        operation: "product.import.crm",
        status: "completed",
        artifactPath: "/opt/a1/imports/product-sources/source-manifest.json",
        checksum: "crm-checksum"
      }
    ]
  );
  const health = await checkTenant({
    platformDb: targetDb,
    storage: targetStorage,
    slug: "demo-client",
    requireProductImports: true
  });
  assert.equal(health.ok, true);
});

test("import aborts when required product import audit operations are absent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "a1-import-product-audit-missing-"));
  const sourceStorage = new LocalTenantStorage({ root: path.join(root, "source-storage"), bucket: "a1-documents" });
  const exportResult = await exportTenant({
    platformDb: fakeDb(),
    storage: sourceStorage,
    slug: "demo-client",
    outputRoot: path.join(root, "exports"),
    runner: fakeRunner
  });

  const targetStorage = new LocalTenantStorage({ root: path.join(root, "target-storage"), bucket: "a1-documents" });
  const targetDb = fakeDb();
  await assert.rejects(
    () => importTenant({
      platformDb: targetDb,
      storage: targetStorage,
      slug: "demo-client",
      importDir: exportResult.outputDir,
      runner: fakeRunner,
      requireProductImports: true
    }),
    (error) => {
      assert.match(error.message, /Tenant import preflight failed: operation:product\.import\.studio/);
      assert.equal(error.code, "TENANT_PREFLIGHT_FAILED");
      assert.equal(error.statusCode, 409);
      assert.equal(error.failedChecks.some((check) => check.name === "operation:product.import.studio"), true);
      return true;
    }
  );

  assert.equal(targetDb.operations.find((item) => item.operation === "tenant.import").status, "failed");
  assert.equal(targetDb.operations.some((item) => item.operation.startsWith("product.import.")), false);
  assert.equal((await targetDb.getTenantBySlug("demo-client")).status, "maintenance");
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

test("tenant check can require completed product import operations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "a1-check-product-imports-"));
  const storage = new LocalTenantStorage({ root: path.join(root, "storage"), bucket: "a1-documents" });
  const platformDb = fakeDb({ importOperations: completedProductImportOperations() });

  const result = await checkTenant({
    platformDb,
    storage,
    slug: "demo-client",
    requireProductImports: true
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.checks
      .filter((check) => check.name.startsWith("operation:product.import."))
      .map((check) => ({ name: check.name, ok: check.ok, status: check.status })),
    [
      { name: "operation:product.import.studio", ok: true, status: "completed" },
      { name: "operation:product.import.hayhashvapah", ok: true, status: "completed" },
      { name: "operation:product.import.crm", ok: true, status: "completed" }
    ]
  );
});

test("tenant check reports missing required product import operations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "a1-check-product-import-missing-"));
  const storage = new LocalTenantStorage({ root: path.join(root, "storage"), bucket: "a1-documents" });
  const platformDb = fakeDb({
    importOperations: [
      {
        id: "op-studio",
        operation: "product.import.studio",
        status: "completed",
        finishedAt: new Date("2026-06-01T00:00:00Z")
      },
      {
        id: "op-hayhashvapah",
        operation: "product.import.hayhashvapah",
        status: "failed",
        finishedAt: new Date("2026-06-01T00:01:00Z")
      }
    ]
  });

  const result = await checkTenant({
    platformDb,
    storage,
    slug: "demo-client",
    requireProductImports: true
  });
  const productChecks = Object.fromEntries(
    result.checks
      .filter((check) => check.name.startsWith("operation:product.import."))
      .map((check) => [check.name, check])
  );

  assert.equal(result.ok, false);
  assert.equal(productChecks["operation:product.import.studio"].ok, true);
  assert.equal(productChecks["operation:product.import.hayhashvapah"].ok, false);
  assert.equal(productChecks["operation:product.import.hayhashvapah"].status, "failed");
  assert.equal(productChecks["operation:product.import.crm"].ok, false);
  assert.equal(productChecks["operation:product.import.crm"].message, "completed product import operation missing");
});

test("move aborts before route switch when target check fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "a1-move-target-fail-"));
  const storage = new LocalTenantStorage({ root: path.join(root, "storage"), bucket: "a1-documents" });
  const platformDb = fakeDb();

  await assert.rejects(
    () => moveTenant({
      platformDb,
      storage,
      slug: "demo-client",
      target: "vps-01",
      targetUrl: "http://10.10.5.40:4200",
      outputRoot: path.join(root, "exports"),
      runner: fakeRunner,
      targetCheck: async () => ({ ok: false, message: "target import check failed" })
    }),
    /target health check failed/
  );

  assert.deepEqual(platformDb.updateCalls, []);
  assert.equal((await platformDb.getTenantBySlug("demo-client")).status, "active");
});

test("move aborts before route switch when required product imports are missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "a1-move-product-imports-missing-"));
  const storage = new LocalTenantStorage({ root: path.join(root, "storage"), bucket: "a1-documents" });
  const platformDb = fakeDb({ importOperations: [] });

  await assert.rejects(
    () => moveTenant({
      platformDb,
      storage,
      slug: "demo-client",
      target: "vps-01",
      targetUrl: "http://10.10.5.40:4200",
      outputRoot: path.join(root, "exports"),
      runner: fakeRunner,
      requireProductImports: true,
      targetCheck: async () => {
        throw new Error("target check should not run");
      }
    }),
    (error) => {
      assert.match(error.message, /Tenant export preflight failed: operation:product\.import\.studio/);
      assert.equal(error.code, "TENANT_PREFLIGHT_FAILED");
      assert.equal(error.statusCode, 409);
      assert.equal(error.failedChecks.some((check) => check.name === "operation:product.import.studio"), true);
      return true;
    }
  );

  assert.deepEqual(platformDb.updateCalls, []);
  assert.equal((await platformDb.getTenantBySlug("demo-client")).status, "active");
  assert.equal(platformDb.operations.find((item) => item.operation === "tenant.export").status, "failed");
  assert.equal(platformDb.operations.some((item) => item.operation === "tenant.move"), false);
});

test("move rolls route back when post-switch validation fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "a1-move-rollback-"));
  const storage = new LocalTenantStorage({ root: path.join(root, "storage"), bucket: "a1-documents" });
  const platformDb = fakeDb();

  await assert.rejects(
    () => moveTenant({
      platformDb,
      storage,
      slug: "demo-client",
      target: "vps-01",
      targetUrl: "http://10.10.5.40:4200",
      outputRoot: path.join(root, "exports"),
      runner: fakeRunner,
      targetCheck: async () => ({ ok: true }),
      postSwitchCheck: async () => ({ ok: false, message: "public route still unhealthy" })
    }),
    /post-switch validation failed/
  );

  assert.deepEqual(platformDb.updateCalls, [
    { deploymentTarget: "vps-01", targetUrl: "http://10.10.5.40:4200" },
    { deploymentTarget: "local", targetUrl: "http://api:4200" }
  ]);
  const tenant = await platformDb.getTenantBySlug("demo-client");
  assert.equal(tenant.status, "active");
  assert.equal(tenant.deploymentTarget, "local");
  assert.equal(tenant.routes[0].targetUrl, "http://api:4200");
  assert.equal(platformDb.operations.find((item) => item.operation === "tenant.move").status, "rolled-back");
});

test("move switches route after target and post-switch checks pass", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "a1-move-success-"));
  const storage = new LocalTenantStorage({ root: path.join(root, "storage"), bucket: "a1-documents" });
  const platformDb = fakeDb();

  const result = await moveTenant({
    platformDb,
    storage,
    slug: "demo-client",
    target: "vps-01",
    targetUrl: "http://10.10.5.40:4200",
    outputRoot: path.join(root, "exports"),
    runner: fakeRunner,
    targetCheck: async () => ({ ok: true }),
    postSwitchCheck: async () => ({ ok: true })
  });

  assert.equal(result.tenant.deploymentTarget, "vps-01");
  assert.equal(result.tenant.status, "active");
  assert.equal(result.tenant.routes[0].targetUrl, "http://10.10.5.40:4200");
  assert.equal(platformDb.operations.find((item) => item.operation === "tenant.move").status, "route-switched");
});

test("move restores the tenant status that existed before migration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "a1-move-maintenance-success-"));
  const storage = new LocalTenantStorage({ root: path.join(root, "storage"), bucket: "a1-documents" });
  const platformDb = fakeDb({ status: "maintenance" });

  const result = await moveTenant({
    platformDb,
    storage,
    slug: "demo-client",
    target: "vps-01",
    targetUrl: "http://10.10.5.40:4200",
    outputRoot: path.join(root, "exports"),
    runner: fakeRunner,
    targetCheck: async () => ({ ok: true }),
    postSwitchCheck: async () => ({ ok: true })
  });

  assert.equal(result.tenant.deploymentTarget, "vps-01");
  assert.equal(result.tenant.status, "maintenance");
  assert.equal(result.tenant.routes[0].targetUrl, "http://10.10.5.40:4200");
  assert.equal(platformDb.operations.find((item) => item.operation === "tenant.move").status, "route-switched");
});
