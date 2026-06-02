#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { getConfig } = require("../src/config");
const { PlatformDb } = require("../src/platform-db");
const { createStorage } = require("../src/storage");
const { exportTenant, importTenant, checkTenant, moveTenant } = require("../src/tenant-transfer");
const { normalizeSlug } = require("../src/naming");
const { checkProductBundle, importProductBundle, importProductData } = require("../src/product-import");
const { generateCaddyfile } = require("../src/gateway");
const { backupFull, restoreFull } = require("../src/backup-restore");
const { renderProductEnv, writeProductEnvFiles } = require("../src/product-env");
const { verifyTenantHandoff, writeTenantHandoff } = require("../src/tenant-handoff");

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
  a1 tenant create <slug> --modules studio,hayhashvapah,crm [--company-name name] [--domain host] [--studio-org-id org-id] [--target local]
  a1 tenant maintenance <slug> on|off
  a1 tenant export <slug> [--out exports] [--require-product-imports]
  a1 tenant import <slug> <export-dir> [--activate] [--require-product-imports]
  a1 tenant check <slug> [--require-product-imports]
  a1 tenant operations <slug> [--limit 50]
  a1 tenant handoff <slug> [--out exports/handoff] [--product all] [--redact] [--email admin@example.com]
  a1 tenant handoff-check <handoff-dir>
  a1 tenant move <slug> --target <deployment-target> [--target-url http://host:port] [--target-check-url http://host/health] [--post-switch-check-url https://tenant/health] [--out exports] [--require-product-imports]
  a1 backup full [--out backups/full] [--require-product-imports]
  a1 restore full <backup-dir> [--activate] [--report-out restore-report.json] [--require-product-imports]
  a1 route list [--all]
  a1 route set <slug> <host> --target-url http://host:port [--product unified|studio|hayhashvapah|crm] [--inactive]
  a1 gateway caddy [--out infra/gateway/Caddyfile.generated] [--email admin@example.com]
  a1 product env studio|hayhashvapah|crm|all <slug> [--out dir] [--platform-api-url http://127.0.0.1:8088] [--non-strict] [--redact]
  a1 product import-check <slug> [--source-root /opt/a1/imports/product-sources] [--source-manifest <file>]
  a1 product import all <slug> [--source-root /opt/a1/imports/product-sources] [--source-manifest <file>] [--app-version 2026.06.01]
  a1 product import crm <slug> --blueprint <file> --records <file> [--source-manifest <file>]
  a1 product import hayhashvapah <slug> --sqlite <hayhashvapah.sqlite> [--source-manifest <file>]
  a1 product import studio <slug> --sqlite <armosphera-one.db> [--app-version 2026.06.01] [--source-manifest <file>]
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
      const tenantInput = {
        slug,
        modules: option(args, "modules", "studio,hayhashvapah,crm"),
        companyName: option(args, "company-name", slug),
        primaryDomain: option(args, "domain", ""),
        deploymentTarget: option(args, "target", "local"),
        targetUrl: option(args, "target-url", "http://api:4200")
      };
      const studioOrgId = option(args, "studio-org-id", undefined);
      if (studioOrgId !== undefined) tenantInput.studioOrgId = studioOrgId;
      const tenant = await platformDb.createTenant(tenantInput);
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
      const result = await exportTenant({
        platformDb,
        storage,
        slug: third,
        outputRoot: option(args, "out", "exports"),
        requireProductImports: boolOption(args, "require-product-imports")
      });
      printJson({ ok: true, exportDir: result.outputDir, checksum: result.checksum });
      return;
    }

    if (command === "tenant" && subcommand === "import") {
      const result = await importTenant({
        platformDb,
        storage,
        slug: third,
        importDir: args[3],
        activate: boolOption(args, "activate"),
        requireProductImports: boolOption(args, "require-product-imports")
      });
      printJson({ ok: true, tenant: result.tenant, restoredFiles: result.restoredFiles });
      return;
    }

    if (command === "tenant" && subcommand === "check") {
      const result = await checkTenant({
        platformDb,
        storage,
        slug: third,
        requireProductImports: boolOption(args, "require-product-imports")
      });
      printJson(result);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    if (command === "tenant" && subcommand === "operations") {
      const operations = await platformDb.listTenantOperations(third, {
        limit: option(args, "limit", "50")
      });
      printJson({ ok: true, operations });
      return;
    }

    if (command === "tenant" && subcommand === "handoff") {
      printJson({
        ok: true,
        ...await writeTenantHandoff({
          platformDb,
          slug: third,
          outRoot: option(args, "out", path.join("exports", "handoff")),
          productCode: option(args, "product", "all"),
          platformApiUrl: option(args, "platform-api-url", "http://127.0.0.1:8088"),
          platformToken: option(args, "platform-token", process.env.A1_PLATFORM_TOKEN || ""),
          timeoutMs: option(args, "timeout-ms", "1500"),
          strict: !boolOption(args, "non-strict"),
          redact: boolOption(args, "redact"),
          email: option(args, "email", "")
        })
      });
      return;
    }

    if (command === "tenant" && subcommand === "handoff-check") {
      const result = await verifyTenantHandoff(third);
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
        targetCheckUrl: option(args, "target-check-url", ""),
        postSwitchCheckUrl: option(args, "post-switch-check-url", ""),
        outputRoot: option(args, "out", "exports"),
        requireProductImports: boolOption(args, "require-product-imports")
      });
      printJson({ ok: true, ...result });
      return;
    }

    if (command === "backup" && subcommand === "full") {
      printJson(await backupFull({ platformDb, storage, config }, {
        out: option(args, "out", path.join("backups", "full")),
        requireProductImports: boolOption(args, "require-product-imports")
      }));
      return;
    }

    if (command === "restore" && subcommand === "full") {
      printJson(await restoreFull({ platformDb, storage, config }, {
        backupDir: args[2],
        activate: boolOption(args, "activate"),
        reportOut: option(args, "report-out", ""),
        requireProductImports: boolOption(args, "require-product-imports")
      }));
      return;
    }

    if (command === "route" && subcommand === "list") {
      printJson({
        ok: true,
        routes: await platformDb.listRoutes({ activeOnly: !boolOption(args, "all") })
      });
      return;
    }

    if (command === "route" && subcommand === "set") {
      const targetUrl = option(args, "target-url");
      if (!targetUrl) throw new Error("route set requires --target-url");
      const tenant = await platformDb.setTenantRoute(third, {
        host: args[3],
        productCode: option(args, "product", "unified"),
        targetUrl,
        active: !boolOption(args, "inactive")
      });
      printJson({ ok: true, tenant });
      return;
    }

    if (command === "gateway" && subcommand === "caddy") {
      const routes = await platformDb.listRoutes({ activeOnly: true });
      const caddyfile = generateCaddyfile(routes, { email: option(args, "email") });
      const out = option(args, "out");
      if (out) {
        const target = path.resolve(out);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, caddyfile, "utf8");
        printJson({ ok: true, out: target, routes: routes.length });
        return;
      }
      process.stdout.write(caddyfile);
      return;
    }

    if (command === "product" && subcommand === "env") {
      const tenant = await platformDb.getTenantBySlug(args[3]);
      if (!tenant) throw new Error(`Tenant not found: ${normalizeSlug(args[3])}`);
      const envOptions = {
        platformApiUrl: option(args, "platform-api-url", "http://127.0.0.1:8088"),
        platformToken: option(args, "platform-token", process.env.A1_PLATFORM_TOKEN || ""),
        timeoutMs: option(args, "timeout-ms", "1500"),
        strict: !boolOption(args, "non-strict"),
        redact: boolOption(args, "redact")
      };
      const outDir = option(args, "out", "");
      if (outDir) {
        printJson({ ok: true, ...await writeProductEnvFiles(tenant, third, outDir, envOptions) });
        return;
      }
      process.stdout.write(renderProductEnv(tenant, third, envOptions));
      return;
    }

    if (command === "product" && subcommand === "import-check") {
      const result = await checkProductBundle({
        slug: third,
        sourceRoot: option(args, "source-root", ""),
        sourceManifest: option(args, "source-manifest", ""),
        appVersion: option(args, "app-version", config.appVersion)
      });
      printJson(result);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    if (command === "product" && subcommand === "import") {
      const product = third;
      const slug = normalizeSlug(args[3]);

      if (product === "all") {
        printJson({
          ok: true,
          result: await importProductBundle({
            platformDb,
            slug,
            sourceRoot: option(args, "source-root", ""),
            sourceManifest: option(args, "source-manifest", ""),
            appVersion: option(args, "app-version", config.appVersion)
          })
        });
        return;
      }

      if (product === "crm") {
        printJson({
          ok: true,
          result: await importProductData({
            platformDb,
            product,
            slug,
            blueprintPath: option(args, "blueprint"),
            recordsPath: option(args, "records"),
            sourceManifest: option(args, "source-manifest")
          })
        });
        return;
      }

      if (product === "hayhashvapah") {
        printJson({
          ok: true,
          result: await importProductData({
            platformDb,
            product,
            slug,
            sqlitePath: option(args, "sqlite"),
            sourceManifest: option(args, "source-manifest")
          })
        });
        return;
      }

      if (product === "studio") {
        printJson({
          ok: true,
          result: await importProductData({
            platformDb,
            product,
            slug,
            sqlitePath: option(args, "sqlite"),
            appVersion: option(args, "app-version", config.appVersion),
            sourceManifest: option(args, "source-manifest")
          })
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
  if (error.reportPath) process.stderr.write(`Restore report: ${error.reportPath}\n`);
  process.exitCode = 1;
});
