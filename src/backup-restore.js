"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { pgDump, pgRestore } = require("./pg-tools");
const { exportTenant, importTenant, checkTenant } = require("./tenant-transfer");
const { writeChecksums, verifyChecksums, sha256File } = require("./checksums");

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

async function verifyBackupChecksums(backupDir) {
  try {
    const checks = await verifyChecksums(backupDir);
    const failed = checks.filter((check) => !check.ok);
    return {
      ok: failed.length === 0,
      checked: checks.length,
      failed: failed.map((check) => ({
        file: check.file,
        expected: check.expected,
        actual: check.actual
      }))
    };
  } catch (error) {
    return {
      ok: false,
      checked: 0,
      failed: [],
      error: error && error.message ? error.message : String(error)
    };
  }
}

function checksumFailureMessage(result) {
  if (result.error) return `Backup checksum verification failed: ${result.error}`;
  const files = result.failed.map((check) => check.file).join(", ");
  return `Backup checksum verification failed${files ? ` for ${files}` : ""}`;
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

  const checksumPath = await writeChecksums(root);
  const checksum = await sha256File(checksumPath);

  return { ok: true, backupDir: root, tenantCount: tenants.length, tenants: tenantExports, checksum };
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
    backup_checksums: { ok: false, checked: 0 },
    tenants: []
  };

  async function finish(ok) {
    report.ok = ok;
    report.finished_at = now().toISOString();
    await writeJson(reportPath, report);
    return { ok, reportPath, report };
  }

  try {
    const backupChecksums = await verifyBackupChecksums(backupDir);
    report.backup_checksums = backupChecksums;
    if (!backupChecksums.ok) {
      const result = await finish(false);
      const error = new Error(checksumFailureMessage(backupChecksums));
      error.reportPath = reportPath;
      error.report = result.report;
      throw error;
    }

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
