#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { getConfig } = require("../src/config");
const { PlatformDb } = require("../src/platform-db");
const { createStorage } = require("../src/storage");
const { exportTenant, importTenant, checkTenant, moveTenant } = require("../src/tenant-transfer");
const { pgDump, pgRestore } = require("../src/pg-tools");
const { normalizeSlug } = require("../src/naming");
const { importCrmJson, importHayhashvapahRows, importStudioSqlite } = require("../src/product-importers");

function loadEnv(filePath = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function option(args, name, fallback = "") {
  const long = `--${name}`;
  const index = args.indexOf(long);
  if (index >= 0) return args[index + 1] || fallback;
  const prefixed = args.find((arg) => arg.startsWith(`${long}=`));
  return prefixed ? prefixed.slice(long.length + 1) : fallback;
}

function boolOption(args, name) {
  return args.includes(`--${name}`);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  process.stdout.write(`A1 Platform CLI

Usage:
  a1 migrate
  a1 health
  a1 tenant create <slug> --modules studio,hayhashvapah,crm [--company-name name] [--domain host] [--target local]
  a1 tenant maintenance <slug> on|off
  a1 tenant export <slug> [--out exports]
  a1 tenant import <slug> <export-dir> [--activate]
  a1 tenant check <slug>
  a1 tenant move <slug> --target <deployment-target> [--target-url http://host:port] [--out exports]
  a1 backup full [--out backups/full]
  a1 restore full <backup-dir> [--activate]
  a1 product import crm <slug> --blueprint <file> --records <file>
  a1 product import hayhashvapah <slug> --sqlite <hayhashvapah.sqlite>
  a1 product import studio <slug> --sqlite <armosphera-one.db> [--app-version 2026.06.01]
`);
}

async function withPlatform(fn) {
  loadEnv(path.resolve(process.cwd(), ".env"));
  loadEnv(path.resolve(process.cwd(), ".env.local"));
  const config = getConfig();
  const platformDb = new PlatformDb(config);
  const storage = createStorage(config.storage);
  try {
    return await fn({ config, platformDb, storage });
  } finally {
    await platformDb.close();
  }
}

async function backupFull({ platformDb, storage, config }, args) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const root = path.resolve(option(args, "out", path.join("backups", "full")), stamp);
  await fsp.mkdir(path.join(root, "tenants"), { recursive: true });
  await pgDump(config.registryUrl, path.join(root, "registry.dump"));
  const tenants = await platformDb.listTenants();
  for (const tenant of tenants) {
    await exportTenant({
      platformDb,
      storage,
      slug: tenant.slug,
      outputDir: path.join(root, "tenants", tenant.slug)
    });
  }
  await fsp.writeFile(path.join(root, "metadata.json"), `${JSON.stringify({
    backup_type: "full",
    created_at: new Date().toISOString(),
    app_version: config.appVersion,
    environment: config.appEnv,
    tenant_count: tenants.length,
    storage_bucket: config.storage.bucket,
    encrypted: Boolean(config.backups.encryptionKey)
  }, null, 2)}\n`);
  return { ok: true, backupDir: root, tenantCount: tenants.length };
}

async function restoreFull({ platformDb, storage, config }, args) {
  const backupDir = path.resolve(args[2] || "");
  if (!backupDir) throw new Error("restore full requires <backup-dir>");
  await pgRestore(config.registryUrl, path.join(backupDir, "registry.dump"));
  const tenantRoot = path.join(backupDir, "tenants");
  const entries = await fsp.readdir(tenantRoot, { withFileTypes: true });
  const restored = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const result = await importTenant({
      platformDb,
      storage,
      slug: entry.name,
      importDir: path.join(tenantRoot, entry.name),
      activate: boolOption(args, "activate")
    });
    restored.push(result.tenant.slug);
  }
  return { ok: true, restored };
}

async function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  const [command, subcommand, third] = args;
  await withPlatform(async ({ config, platformDb, storage }) => {
    if (command === "migrate") {
      await platformDb.migrateRegistry();
      printJson({ ok: true, migrated: "registry" });
      return;
    }

    if (command === "health") {
      printJson(await platformDb.health());
      return;
    }

    if (command === "tenant" && subcommand === "create") {
      const slug = normalizeSlug(third);
      const tenant = await platformDb.createTenant({
        slug,
        modules: option(args, "modules", "studio,hayhashvapah,crm"),
        companyName: option(args, "company-name", slug),
        primaryDomain: option(args, "domain", ""),
        deploymentTarget: option(args, "target", "local"),
        targetUrl: option(args, "target-url", "http://api:4200")
      });
      printJson({ ok: true, tenant });
      return;
    }

    if (command === "tenant" && subcommand === "maintenance") {
      const slug = normalizeSlug(third);
      const mode = args[3];
      if (!["on", "off"].includes(mode)) throw new Error("maintenance requires on|off");
      const tenant = await platformDb.setTenantStatus(slug, mode === "on" ? "maintenance" : "active");
      printJson({ ok: true, tenant });
      return;
    }

    if (command === "tenant" && subcommand === "export") {
      const result = await exportTenant({ platformDb, storage, slug: third, outputRoot: option(args, "out", "exports") });
      printJson({ ok: true, exportDir: result.outputDir, checksum: result.checksum });
      return;
    }

    if (command === "tenant" && subcommand === "import") {
      const result = await importTenant({
        platformDb,
        storage,
        slug: third,
        importDir: args[3],
        activate: boolOption(args, "activate")
      });
      printJson({ ok: true, tenant: result.tenant, restoredFiles: result.restoredFiles });
      return;
    }

    if (command === "tenant" && subcommand === "check") {
      const result = await checkTenant({ platformDb, storage, slug: third });
      printJson(result);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    if (command === "tenant" && subcommand === "move") {
      const result = await moveTenant({
        platformDb,
        storage,
        slug: third,
        target: option(args, "target"),
        targetUrl: option(args, "target-url", ""),
        outputRoot: option(args, "out", "exports")
      });
      printJson({ ok: true, ...result });
      return;
    }

    if (command === "backup" && subcommand === "full") {
      printJson(await backupFull({ platformDb, storage, config }, args));
      return;
    }

    if (command === "restore" && subcommand === "full") {
      printJson(await restoreFull({ platformDb, storage, config }, args));
      return;
    }

    if (command === "product" && subcommand === "import") {
      const product = third;
      const slug = normalizeSlug(args[3]);
      const tenant = await platformDb.getTenantBySlug(slug);
      if (!tenant) throw new Error(`Tenant not found: ${slug}`);
      const pool = platformDb.tenantPool(tenant.databaseName);

      if (product === "crm") {
        const blueprintPath = option(args, "blueprint");
        const recordsPath = option(args, "records");
        if (!blueprintPath || !recordsPath) throw new Error("CRM import requires --blueprint and --records");
        printJson({
          ok: true,
          result: await importCrmJson({ pool, slug, blueprintPath, recordsPath })
        });
        return;
      }

      if (product === "hayhashvapah") {
        const sqlitePath = option(args, "sqlite");
        if (!sqlitePath) throw new Error("HayHashvapah import requires --sqlite");
        printJson({
          ok: true,
          result: await importHayhashvapahRows({ pool, sqlitePath })
        });
        return;
      }

      if (product === "studio") {
        const sqlitePath = option(args, "sqlite");
        if (!sqlitePath) throw new Error("Studio import requires --sqlite");
        printJson({
          ok: true,
          result: await importStudioSqlite({ pool, sqlitePath, appVersion: option(args, "app-version", config.appVersion) })
        });
        return;
      }

      throw new Error(`Unknown product import: ${product}`);
    }

    usage();
    process.exitCode = 1;
  });
}

main(process.argv).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
