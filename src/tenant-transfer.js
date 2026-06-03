"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { writeChecksums, verifyChecksums, sha256File } = require("./checksums");
const { pgDump, pgRestore } = require("./pg-tools");
const { normalizeSlug } = require("./naming");

const PRODUCT_MODULES = Object.freeze(["studio", "hayhashvapah", "crm"]);
const PRODUCT_DATA_TABLES = Object.freeze({
  studio: Object.freeze(["studio_legacy_rows", "studio_documents", "studio_sqlite_import_batches"]),
  hayhashvapah: Object.freeze(["hayhashvapah_accounts", "hayhashvapah_sessions", "hayhashvapah_meta", "hayhashvapah_files", "hayhashvapah_audit_log"]),
  crm: Object.freeze(["crm_tenant_blueprints", "crm_records", "crm_files", "crm_audit_log"])
});

function tenantDataCountsFromHealthChecks(health = {}) {
  const counts = {};
  for (const check of health.checks || []) {
    if (!check?.name || !check.name.startsWith("data:") || !Number.isInteger(check.count)) continue;
    const tableName = check.name.slice("data:".length);
    counts[tableName] = check.count;
    if (!counts[tableName.replace(".", "_")]) {
      counts[tableName.replace(".", "_")] = check.count;
    }
  }
  return counts;
}

async function tenantHasProductPayload(health = {}, modules = [], platformDb = null, tenant) {
  let counts = tenantDataCountsFromHealthChecks(health);
  if (!Object.keys(counts).length && platformDb && typeof platformDb.tenantDataCounts === "function") {
    const source = await platformDb.tenantDataCounts(tenant || health.tenant);
    if (source && typeof source === "object") {
      counts = source;
    }
  }
  return modules.some((moduleCode) => {
    const tableKeys = PRODUCT_DATA_TABLES[moduleCode] || [];
    return tableKeys.some((tableName) => Number(counts[tableName]) > 0);
  });
}

function normalizeVmPath(inputPath) {
  if (typeof inputPath !== "string" || !inputPath) return inputPath;
  const aliases = [
    ["/opt/a1/exports", "/app/exports"],
    ["/opt/a1/imports", "/app/imports"],
    ["/opt/a1/backups", "/app/backups"]
  ];
  for (const [source, target] of aliases) {
    if (inputPath === source) return target;
    if (inputPath.startsWith(`${source}/`)) return `${target}${inputPath.slice(source.length)}`;
  }
  return inputPath;
}

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

async function resolveImportDir(rawImportDir, slug = "") {
  const normalizedDir = path.resolve(normalizeVmPath(rawImportDir));
  const candidateDirs = [normalizedDir];
  const normalizedSlug = normalizeSlug(slug);

  const fallbackCandidates = normalizedSlug
    ? [path.join(normalizedDir, normalizedSlug)]
    : [];

  let childDirs = [];
  try {
    const entries = await fs.readdir(normalizedDir, { withFileTypes: true });
    childDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(normalizedDir, entry.name));
  } catch {
    childDirs = [];
  }

  const fullCandidates = uniqueStrings([
    ...candidateDirs,
    ...fallbackCandidates,
    ...childDirs
  ]);

  for (const candidateDir of fullCandidates) {
    const metadataPath = path.join(candidateDir, "metadata.json");
    const registryPath = path.join(candidateDir, "registry.json");
    if (await fileExists(metadataPath) && await fileExists(registryPath)) {
      return candidateDir;
    }
  }

  throw new Error(`Import directory does not contain tenant export files: ${normalizedDir}`);
}

function registryExport(tenant, operations = []) {
  return {
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      company_name: tenant.companyName,
      primary_domain: tenant.primaryDomain,
      studio_org_id: tenant.studioOrgId || tenant.orgId || "",
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
    })),
    operations
  };
}

function exportMetadata(tenant, counts = {}) {
  return {
    format_version: "1",
    tenant: tenant.slug,
    company_name: tenant.companyName,
    domain: tenant.primaryDomain,
    studio_org_id: tenant.studioOrgId || tenant.orgId || "",
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

function enabledProductModules(tenant = {}) {
  const enabled = new Set((tenant.modules || [])
    .filter((module) => module && module.enabled !== false)
    .map((module) => module.code || module.module_code || module.moduleCode || module)
    .filter(Boolean));
  return PRODUCT_MODULES.filter((code) => enabled.has(code));
}

function operationTime(operation = {}) {
  const value = operation.finishedAt || operation.finished_at || operation.startedAt || operation.started_at;
  if (!value) return "unknown time";
  return value instanceof Date ? value.toISOString() : String(value);
}

function operationValue(operation, camelName, snakeName) {
  return operation?.[camelName] ?? operation?.[snakeName] ?? null;
}

function operationTimestamp(operation, camelName, snakeName) {
  const value = operationValue(operation, camelName, snakeName);
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function operationExport(operation) {
  return {
    operation: operation.operation,
    status: operation.status,
    source_target: operationValue(operation, "sourceTarget", "source_target"),
    destination_target: operationValue(operation, "destinationTarget", "destination_target"),
    artifact_path: operationValue(operation, "artifactPath", "artifact_path"),
    checksum: operation.checksum || null,
    started_at: operationTimestamp(operation, "startedAt", "started_at"),
    finished_at: operationTimestamp(operation, "finishedAt", "finished_at")
  };
}

async function productImportOperationExports(platformDb, slug, tenant) {
  if (typeof platformDb.listTenantOperations !== "function") return [];
  const operations = await platformDb.listTenantOperations(slug, { limit: 200 });
  return enabledProductModules(tenant)
    .map((moduleCode) => operations.find((operation) => (
      operation.operation === `product.import.${moduleCode}` && operation.status === "completed"
    )))
    .filter(Boolean)
    .map(operationExport);
}

async function addProductImportChecks(health, platformDb, slug) {
  if (typeof platformDb.listTenantOperations !== "function") {
    health.checks.push({
      name: "operation:product.imports",
      ok: false,
      message: "tenant operation lookup unavailable"
    });
    return;
  }

  let operations;
  try {
    operations = await platformDb.listTenantOperations(slug, { limit: 200 });
  } catch (error) {
    health.checks.push({
      name: "operation:product.imports",
      ok: false,
      message: error.message
    });
    return;
  }

  const enabledModules = enabledProductModules(health.tenant);
  const hasPayload = await tenantHasProductPayload(health, enabledModules, platformDb, slug);
  for (const moduleCode of enabledModules) {
    const operationName = `product.import.${moduleCode}`;
    const latest = operations.find((operation) => operation.operation === operationName);
    if (!hasPayload) {
      health.checks.push({
        name: `operation:${operationName}`,
        ok: true,
        message: "skipped product import requirement for empty tenant payload",
        operationId: null,
        artifactPath: null,
        checksum: null,
        status: null
      });
      continue;
    }

    const ok = latest?.status === "completed";
    health.checks.push({
      name: `operation:${operationName}`,
      ok,
      message: ok
        ? `latest product import completed at ${operationTime(latest)}`
        : latest
          ? `latest product import status is ${latest.status}`
          : "completed product import operation missing",
      operationId: latest?.id || null,
      artifactPath: latest?.artifactPath || latest?.artifact_path || null,
      checksum: latest?.checksum || null,
      status: latest?.status || null
    });
  }
}

function registryOperations(registry) {
  return (registry.operations || registry.tenant_operations || [])
    .filter((operation) => (
      typeof operation.operation === "string"
        && operation.operation.startsWith("product.import.")
        && operation.status === "completed"
    ));
}

async function replayRegistryOperations(platformDb, slug, registry) {
  for (const operation of registryOperations(registry)) {
    await platformDb.recordOperation(slug, operation.operation, operation.status, {
      sourceTarget: operation.source_target || operation.sourceTarget || null,
      destinationTarget: operation.destination_target || operation.destinationTarget || null,
      artifactPath: operation.artifact_path || operation.artifactPath || null,
      checksum: operation.checksum || null
    });
  }
}

function failedCheckNames(health) {
  return health.checks.filter((check) => !check.ok).map((check) => check.name).join(", ");
}

function failedChecks(health) {
  return health.checks.filter((check) => !check.ok);
}

function productImportChecks(health) {
  return health.checks.filter((check) => check.name.startsWith("operation:product.import"));
}

function missingProductImportChecks(health) {
  return productImportChecks(health)
    .filter((check) => !check.ok)
    .map((check) => check.name);
}

function makePreflightMessage(label, health, options = {}) {
  const failures = failedCheckNames(health) || "unknown";
  if (!options.requireProductImports) return `${label} preflight failed: ${failures}`;

  const missingImports = missingProductImportChecks(health);
  if (!missingImports.length) return `${label} preflight failed: ${failures}`;

  return `${label} preflight failed: ${failures}; missing required product import checks: ${missingImports.join(", ")}`;
}

function makePreflightHint(missingImports) {
  if (!missingImports.length) return null;
  return `Run product import for ${missingImports.join(", ")} (studio/hayhashvapah/crm) and retry with --require-product-imports.`;
}

async function assertTenantPreflight(options, label) {
  const health = await checkTenant(options);
  if (!health.ok) {
    const missingImports = missingProductImportChecks(health);
    const error = new Error(makePreflightMessage(label, health, options));
    error.code = "TENANT_PREFLIGHT_FAILED";
    error.statusCode = 409;
    error.failedChecks = failedChecks(health);
    error.missingProductImports = missingImports;
    error.hint = makePreflightHint(missingImports);
    error.health = health;
    throw error;
  }
  return health;
}

async function exportTenant(options) {
  const platformDb = options.platformDb;
  const storage = options.storage;
  const slug = normalizeSlug(options.slug);
  const tenant = await platformDb.getTenantBySlug(slug);
  if (!tenant) throw new Error(`Tenant not found: ${slug}`);

  const outputRoot = path.resolve(normalizeVmPath(options.outputRoot || "exports"));
  const outputDir = path.resolve(options.outputDir || path.join(outputRoot, slug));
  const previousStatus = tenant.status;
  const operation = await platformDb.recordOperation(slug, "tenant.export", "started", { artifactPath: outputDir });

  try {
    if (options.requireProductImports) {
      await assertTenantPreflight({
        platformDb,
        storage,
        slug,
        requireProductImports: true
      }, "Tenant export");
    }

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
    const productImportOperations = await productImportOperationExports(platformDb, slug, activeTenant);
    await writeJson(path.join(outputDir, "registry.json"), registryExport(activeTenant, productImportOperations));
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
  const importDir = await resolveImportDir(options.importDir, options.slug);
  const checks = await verifyChecksums(importDir);
  const failed = checks.filter((check) => !check.ok);
  if (failed.length) {
    throw new Error(`Checksum verification failed for ${failed.map((check) => check.file).join(", ")}`);
  }

  const metadata = JSON.parse(await fs.readFile(path.join(importDir, "metadata.json"), "utf8"));
  const registry = JSON.parse(await fs.readFile(path.join(importDir, "registry.json"), "utf8"));
  const sourceSlug = normalizeSlug(metadata.tenant || registry.tenant?.slug);
  const slug = options.slug ? normalizeSlug(options.slug) : sourceSlug;
  if (slug !== sourceSlug) {
    throw new Error(`Import slug mismatch: command slug ${slug} does not match export bundle tenant ${sourceSlug}`);
  }
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
    if (!health.ok) {
      throw new Error(`Imported tenant failed health check: ${health.checks.filter((check) => !check.ok).map((check) => check.name).join(", ")}`);
    }
    await replayRegistryOperations(platformDb, slug, registry);
    if (options.requireProductImports) {
      const productImportHealth = await assertTenantPreflight({
        platformDb,
        storage,
        slug,
        requireProductImports: true
      }, "Tenant import");
      health.checks.push(...productImportChecks(productImportHealth));
      health.ok = health.checks.every((check) => check.ok);
    }
    await platformDb.finishOperation(operation.id, "completed", { artifactPath: importDir });
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
  if (health.tenant && options.requireProductImports) {
    await addProductImportChecks(health, options.platformDb, options.slug);
  }
  health.ok = health.checks.every((check) => check.ok);
  return health;
}

async function httpHealthCheck(url, fetchImpl = globalThis.fetch) {
  if (!url) return { ok: true, skipped: true };
  if (typeof fetchImpl !== "function") {
    throw new Error("HTTP health check requires fetch");
  }
  const response = await fetchImpl(url);
  let payload = {};
  try {
    payload = await response.json();
  } catch (_error) {
    payload = {};
  }
  return {
    ok: response.ok && payload.ok !== false,
    status: response.status,
    payload
  };
}

async function runMoveCheck(name, check, context) {
  if (!check) return { ok: true, skipped: true };
  const result = await check(context);
  if (result === false || result?.ok === false) {
    const detail = result?.message || result?.status || "not ok";
    throw new Error(`Move ${name} failed: ${detail}`);
  }
  return result || { ok: true };
}

function normalizeMoveTargetUrl(targetUrl) {
  if (!targetUrl) return "";
  const parsed = new URL(String(targetUrl));
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported route target protocol: ${targetUrl}`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`Route target must be an origin without query/hash: ${targetUrl}`);
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function normalizeMoveHealthCheckUrl(value, fieldName) {
  if (!value) return "";
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be an absolute HTTP(S) URL`);
  }
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${fieldName} must be an absolute HTTP(S) URL`);
  }
  return parsed.toString();
}

async function moveTenant(options) {
  const slug = normalizeSlug(options.slug);
  if (!options.target) throw new Error("moveTenant requires target deployment");
  const targetUrl = normalizeMoveTargetUrl(options.targetUrl);
  const targetCheckUrl = normalizeMoveHealthCheckUrl(options.targetCheckUrl, "targetCheckUrl");
  const postSwitchCheckUrl = normalizeMoveHealthCheckUrl(options.postSwitchCheckUrl, "postSwitchCheckUrl");
  const beforeMove = await options.platformDb.getTenantBySlug(slug);
  if (!beforeMove) throw new Error(`Tenant not found: ${slug}`);
  const previousStatus = beforeMove.status;
  const previousRoute = beforeMove.routes.find((route) => route.active) || beforeMove.routes[0] || {};
  const exportResult = await exportTenant({
    platformDb: options.platformDb,
    storage: options.storage,
    slug,
    outputRoot: options.outputRoot,
    outputDir: options.outputDir,
    keepMaintenance: true,
    moveMode: true,
    requireProductImports: options.requireProductImports,
    runner: options.runner
  });

  const moveContext = {
    slug,
    target: options.target,
    targetUrl,
    exportDir: exportResult.outputDir,
    checksum: exportResult.checksum
  };
  const targetCheck = options.targetCheck || (targetCheckUrl
    ? () => httpHealthCheck(targetCheckUrl, options.fetchImpl)
    : null);
  const postSwitchCheck = options.postSwitchCheck || (postSwitchCheckUrl
    ? () => httpHealthCheck(postSwitchCheckUrl, options.fetchImpl)
    : null);

  const health = await checkTenant({
    platformDb: options.platformDb,
    storage: options.storage,
    slug,
    requireProductImports: options.requireProductImports
  });
  if (!health.ok) {
    await options.platformDb.setTenantStatus(slug, previousStatus);
    throw new Error("Move aborted before route switch because source health check failed");
  }

  try {
    await runMoveCheck("target health check", targetCheck, moveContext);
  } catch (error) {
    await options.platformDb.setTenantStatus(slug, previousStatus);
    throw error;
  }

  const operation = await options.platformDb.recordOperation(slug, "tenant.move", "route-switching", {
    sourceTarget: exportResult.tenant.deploymentTarget,
    destinationTarget: options.target,
    artifactPath: exportResult.outputDir,
    checksum: exportResult.checksum
  });

  try {
    const switchedTenant = await options.platformDb.updateTenantDeployment(slug, options.target, targetUrl);
    await runMoveCheck("post-switch validation", postSwitchCheck, { ...moveContext, tenant: switchedTenant });
    const tenant = await options.platformDb.setTenantStatus(slug, previousStatus);
    await options.platformDb.finishOperation(operation.id, "route-switched", {
      artifactPath: exportResult.outputDir,
      checksum: exportResult.checksum
    });
    return { tenant, exportDir: exportResult.outputDir, checksum: exportResult.checksum };
  } catch (error) {
    await options.platformDb.updateTenantDeployment(slug, beforeMove.deploymentTarget, previousRoute.targetUrl || "");
    await options.platformDb.setTenantStatus(slug, previousStatus);
    await options.platformDb.finishOperation(operation.id, "rolled-back", {
      artifactPath: exportResult.outputDir,
      checksum: exportResult.checksum
    });
    throw error;
  }
}

module.exports = {
  registryExport,
  exportMetadata,
  compareCounts,
  enabledProductModules,
  exportTenant,
  importTenant,
  checkTenant,
  httpHealthCheck,
  moveTenant
};
