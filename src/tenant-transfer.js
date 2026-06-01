"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { writeChecksums, verifyChecksums, sha256File } = require("./checksums");
const { pgDump, pgRestore } = require("./pg-tools");
const { normalizeSlug } = require("./naming");

function registryExport(tenant) {
  return {
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      company_name: tenant.companyName,
      primary_domain: tenant.primaryDomain,
      database_name: tenant.databaseName,
      storage_prefix: tenant.storagePrefix,
      status: tenant.status,
      deployment_target: tenant.deploymentTarget,
      app_version: tenant.appVersion,
      region: tenant.region
    },
    modules: tenant.modules.map((module) => ({
      module_code: module.code,
      enabled: module.enabled,
      schema_version: module.schemaVersion
    })),
    routes: tenant.routes.map((route) => ({
      host: route.host,
      product_code: route.productCode,
      target_url: route.targetUrl,
      active: route.active
    }))
  };
}

function exportMetadata(tenant, counts = {}) {
  return {
    format_version: "1",
    tenant: tenant.slug,
    company_name: tenant.companyName,
    domain: tenant.primaryDomain,
    database: tenant.databaseName,
    storage_prefix: tenant.storagePrefix,
    app_version: tenant.appVersion,
    modules: tenant.modules.filter((module) => module.enabled).map((module) => module.code),
    exported_at: new Date().toISOString(),
    source_environment: tenant.deploymentTarget,
    counts
  };
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function compareCounts(expected = {}, actual = {}) {
  const mismatches = [];
  for (const [key, expectedValue] of Object.entries(expected || {})) {
    const actualValue = actual?.[key];
    if (Number(expectedValue) !== Number(actualValue)) {
      mismatches.push({ key, expected: expectedValue, actual: actualValue });
    }
  }
  return mismatches;
}

async function exportTenant(options) {
  const platformDb = options.platformDb;
  const storage = options.storage;
  const slug = normalizeSlug(options.slug);
  const tenant = await platformDb.getTenantBySlug(slug);
  if (!tenant) throw new Error(`Tenant not found: ${slug}`);

  const outputRoot = path.resolve(options.outputRoot || "exports");
  const outputDir = path.resolve(options.outputDir || path.join(outputRoot, slug));
  const previousStatus = tenant.status;
  const operation = await platformDb.recordOperation(slug, "tenant.export", "started", { artifactPath: outputDir });

  try {
    await platformDb.setTenantStatus(slug, options.moveMode ? "migrating" : "maintenance");
    await fs.rm(outputDir, { recursive: true, force: true });
    await fs.mkdir(path.join(outputDir, "files"), { recursive: true });

    const activeTenant = await platformDb.getTenantBySlug(slug);
    const storageFileCount = await storage.syncPrefixToDir(slug, path.join(outputDir, "files"));
    const databaseRows = typeof platformDb.tenantDataCounts === "function"
      ? await platformDb.tenantDataCounts(activeTenant)
      : {};
    await writeJson(path.join(outputDir, "metadata.json"), exportMetadata(activeTenant, {
      storage_files: storageFileCount,
      database_rows: databaseRows || {}
    }));
    await writeJson(path.join(outputDir, "registry.json"), registryExport(activeTenant));
    await pgDump(activeTenant.databaseUrl, path.join(outputDir, "db.dump"), options.runner);
    await writeChecksums(outputDir);
    const checksum = await sha256File(path.join(outputDir, "checksums.txt"));
    await platformDb.finishOperation(operation.id, "completed", { artifactPath: outputDir, checksum });

    if (!options.keepMaintenance) {
      await platformDb.setTenantStatus(slug, previousStatus);
    }

    return { outputDir, checksum, tenant: activeTenant };
  } catch (error) {
    await platformDb.finishOperation(operation.id, "failed", { artifactPath: outputDir });
    if (!options.keepMaintenance) {
      await platformDb.setTenantStatus(slug, previousStatus);
    }
    throw error;
  }
}

async function importTenant(options) {
  const platformDb = options.platformDb;
  const storage = options.storage;
  const importDir = path.resolve(options.importDir);
  const checks = await verifyChecksums(importDir);
  const failed = checks.filter((check) => !check.ok);
  if (failed.length) {
    throw new Error(`Checksum verification failed for ${failed.map((check) => check.file).join(", ")}`);
  }

  const metadata = JSON.parse(await fs.readFile(path.join(importDir, "metadata.json"), "utf8"));
  const registry = JSON.parse(await fs.readFile(path.join(importDir, "registry.json"), "utf8"));
  const slug = normalizeSlug(options.slug || metadata.tenant || registry.tenant?.slug);
  const tenant = await platformDb.upsertTenantFromRegistry(registry);
  const operation = await platformDb.recordOperation(slug, "tenant.import", "started", { artifactPath: importDir });

  try {
    await platformDb.setTenantStatus(slug, "maintenance");
    await pgRestore(tenant.databaseUrl, path.join(importDir, "db.dump"), options.runner);
    await platformDb.runTenantMigrations(tenant.databaseName, tenant.modules.map((module) => module.code));
    const restoredFiles = await storage.syncDirToPrefix(slug, path.join(importDir, "files"));
    const actualRows = typeof platformDb.tenantDataCounts === "function"
      ? await platformDb.tenantDataCounts(tenant)
      : {};
    const health = await platformDb.tenantHealth(slug);
    const rowMismatches = compareCounts(metadata.counts?.database_rows, actualRows || {});
    health.checks.push({
      name: "counts:database_rows",
      ok: rowMismatches.length === 0,
      message: rowMismatches.length === 0 ? "database row counts match export metadata" : "database row count mismatch",
      mismatches: rowMismatches
    });

    if (Number.isInteger(metadata.counts?.storage_files)) {
      health.checks.push({
        name: "counts:storage_files",
        ok: metadata.counts.storage_files === restoredFiles,
        message: metadata.counts.storage_files === restoredFiles ? "storage file count matches export metadata" : "storage file count mismatch",
        expected: metadata.counts.storage_files,
        actual: restoredFiles
      });
    }
    health.ok = health.checks.every((check) => check.ok);
    await platformDb.finishOperation(operation.id, health.ok ? "completed" : "failed", { artifactPath: importDir });
    if (!health.ok) {
      throw new Error(`Imported tenant failed health check: ${health.checks.filter((check) => !check.ok).map((check) => check.name).join(", ")}`);
    }
    if (options.activate) await platformDb.setTenantStatus(slug, "active");
    return { tenant: await platformDb.getTenantBySlug(slug), restoredFiles, checks: health.checks };
  } catch (error) {
    await platformDb.finishOperation(operation.id, "failed", { artifactPath: importDir });
    throw error;
  }
}

async function checkTenant(options) {
  const health = await options.platformDb.tenantHealth(options.slug);
  if (health.tenant && options.storage) {
    try {
      const count = await options.storage.countTenantObjects(health.tenant.slug);
      health.checks.push({ name: "storage", ok: true, message: `${count} tenant objects found`, count });
    } catch (error) {
      health.checks.push({ name: "storage", ok: false, message: error.message });
    }
  }
  health.ok = health.checks.every((check) => check.ok);
  return health;
}

async function moveTenant(options) {
  const slug = normalizeSlug(options.slug);
  if (!options.target) throw new Error("moveTenant requires target deployment");
  const exportResult = await exportTenant({
    platformDb: options.platformDb,
    storage: options.storage,
    slug,
    outputRoot: options.outputRoot,
    outputDir: options.outputDir,
    keepMaintenance: true,
    moveMode: true,
    runner: options.runner
  });

  const targetUrl = options.targetUrl || "";
  const health = await checkTenant({ platformDb: options.platformDb, storage: options.storage, slug });
  if (!health.ok) {
    await options.platformDb.setTenantStatus(slug, "active");
    throw new Error("Move aborted before route switch because source health check failed");
  }

  const tenant = await options.platformDb.updateTenantDeployment(slug, options.target, targetUrl);
  await options.platformDb.recordOperation(slug, "tenant.move", "route-pending", {
    sourceTarget: exportResult.tenant.deploymentTarget,
    destinationTarget: options.target,
    artifactPath: exportResult.outputDir,
    checksum: exportResult.checksum
  });
  return { tenant, exportDir: exportResult.outputDir, checksum: exportResult.checksum };
}

module.exports = {
  registryExport,
  exportMetadata,
  compareCounts,
  exportTenant,
  importTenant,
  checkTenant,
  moveTenant
};
