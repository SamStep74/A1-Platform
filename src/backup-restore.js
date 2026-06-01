"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { pgDump, pgRestore } = require("./pg-tools");
const { exportTenant, importTenant, checkTenant } = require("./tenant-transfer");

function backupStamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-");
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function reportTenantError(slug, error) {
  return {
    slug,
    ok: false,
    error: {
      message: error && error.message ? error.message : String(error)
    }
  };
}

async function backupFull({ platformDb, storage, config, runner, now = () => new Date() }, options = {}) {
  const root = path.resolve(options.out || path.join("backups", "full"), backupStamp(now()));
  await fsp.mkdir(path.join(root, "tenants"), { recursive: true });
  await pgDump(config.registryUrl, path.join(root, "registry.dump"), runner);
  const tenants = await platformDb.listTenants();
  const tenantExports = [];

  for (const tenant of tenants) {
    const result = await exportTenant({
      platformDb,
      storage,
      slug: tenant.slug,
      outputDir: path.join(root, "tenants", tenant.slug),
      runner
    });
    tenantExports.push({
      slug: tenant.slug,
      exportDir: result.outputDir,
      checksum: result.checksum
    });
  }

  await writeJson(path.join(root, "metadata.json"), {
    backup_type: "full",
    created_at: now().toISOString(),
    app_version: config.appVersion,
    environment: config.appEnv,
    tenant_count: tenants.length,
    tenants: tenantExports.map((tenant) => ({ slug: tenant.slug, checksum: tenant.checksum })),
    storage_bucket: config.storage.bucket,
    encrypted: Boolean(config.backups.encryptionKey)
  });

  return { ok: true, backupDir: root, tenantCount: tenants.length, tenants: tenantExports };
}

async function restoreFull({ platformDb, storage, config, runner, now = () => new Date() }, options = {}) {
  const backupDir = path.resolve(options.backupDir || "");
  if (!backupDir) throw new Error("restore full requires <backup-dir>");
  const reportPath = path.resolve(options.reportOut || path.join(backupDir, "restore-report.json"));
  const report = {
    ok: false,
    backup_dir: backupDir,
    app_version: config.appVersion,
    environment: config.appEnv,
    activate: Boolean(options.activate),
    started_at: now().toISOString(),
    finished_at: null,
    registry: { ok: false },
    tenants: []
  };

  async function finish(ok) {
    report.ok = ok;
    report.finished_at = now().toISOString();
    await writeJson(reportPath, report);
    return { ok, reportPath, report };
  }

  try {
    try {
      const metadata = JSON.parse(await fsp.readFile(path.join(backupDir, "metadata.json"), "utf8"));
      report.backup_metadata = {
        created_at: metadata.created_at,
        tenant_count: metadata.tenant_count,
        app_version: metadata.app_version,
        encrypted: Boolean(metadata.encrypted)
      };
    } catch (_error) {
      report.backup_metadata = null;
    }

    await pgRestore(config.registryUrl, path.join(backupDir, "registry.dump"), runner);
    report.registry = { ok: true, dump: path.join(backupDir, "registry.dump") };
    await writeJson(reportPath, report);

    const tenantRoot = path.join(backupDir, "tenants");
    const entries = (await fsp.readdir(tenantRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const slug of entries) {
      try {
        const result = await importTenant({
          platformDb,
          storage,
          slug,
          importDir: path.join(tenantRoot, slug),
          activate: Boolean(options.activate),
          runner
        });
        const health = await checkTenant({ platformDb, storage, slug });
        const tenantReport = {
          slug: result.tenant.slug,
          ok: health.ok,
          restored_files: result.restoredFiles,
          activated: Boolean(options.activate),
          checks: health.checks
        };
        report.tenants.push(tenantReport);
        await writeJson(reportPath, report);
        if (!health.ok) {
          const error = new Error(`Tenant check failed after restore: ${slug}`);
          error.reportTenantRecorded = true;
          throw error;
        }
      } catch (error) {
        if (!error.reportTenantRecorded) {
          report.tenants.push(reportTenantError(slug, error));
        }
        const result = await finish(false);
        error.reportPath = reportPath;
        error.report = result.report;
        throw error;
      }
    }

    const result = await finish(report.registry.ok && report.tenants.every((tenant) => tenant.ok));
    return {
      ...result,
      restored: report.tenants.filter((tenant) => tenant.ok).map((tenant) => tenant.slug)
    };
  } catch (error) {
    if (!error.reportPath) {
      const result = await finish(false);
      error.reportPath = reportPath;
      error.report = result.report;
    }
    throw error;
  }
}

module.exports = {
  backupFull,
  restoreFull,
  backupStamp
};
