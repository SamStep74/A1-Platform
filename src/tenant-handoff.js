"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { sha256File, writeChecksums } = require("./checksums");
const { generateCaddyfile } = require("./gateway");
const { redactUrl, writeProductEnvFiles } = require("./product-env");
const { normalizeSlug } = require("./naming");

function handoffRouteRecords(tenant) {
  return (tenant.routes || []).map((route) => ({
    tenantId: tenant.id,
    slug: tenant.slug,
    companyName: tenant.companyName,
    deploymentTarget: tenant.deploymentTarget,
    host: route.host,
    productCode: route.productCode,
    targetUrl: route.targetUrl,
    active: route.active
  }));
}

function tenantRecord(tenant, options = {}) {
  return {
    id: tenant.id,
    slug: tenant.slug,
    companyName: tenant.companyName,
    primaryDomain: tenant.primaryDomain,
    databaseName: tenant.databaseName,
    databaseUrl: options.redact ? redactUrl(tenant.databaseUrl) : tenant.databaseUrl,
    storagePrefix: tenant.storagePrefix,
    status: tenant.status,
    deploymentTarget: tenant.deploymentTarget,
    appVersion: tenant.appVersion,
    region: tenant.region,
    modules: tenant.modules || [],
    routes: tenant.routes || []
  };
}

async function writeJson(target, value) {
  await fsp.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function writeTenantHandoff(options = {}) {
  const platformDb = options.platformDb;
  if (!platformDb || typeof platformDb.getTenantBySlug !== "function") {
    throw new Error("Tenant handoff requires platformDb");
  }

  const tenant = await platformDb.getTenantBySlug(options.slug);
  if (!tenant) throw new Error(`Tenant not found: ${normalizeSlug(options.slug)}`);

  const root = path.resolve(options.outRoot || path.join("exports", "handoff"), tenant.slug);
  await fsp.mkdir(root, { recursive: true });

  const productEnv = await writeProductEnvFiles(tenant, options.productCode || "all", path.join(root, "product-env"), {
    platformApiUrl: options.platformApiUrl || "http://127.0.0.1:8088",
    platformToken: options.platformToken || "",
    timeoutMs: options.timeoutMs || "1500",
    strict: options.strict !== false,
    redact: Boolean(options.redact)
  });

  const routes = handoffRouteRecords(tenant);
  const files = [];
  const tenantPath = path.join(root, "tenant.json");
  const routesPath = path.join(root, "routes.json");
  const caddyfilePath = path.join(root, "Caddyfile");
  const manifestPath = path.join(root, "handoff-manifest.json");

  await writeJson(tenantPath, tenantRecord(tenant, { redact: Boolean(options.redact) }));
  files.push({ kind: "tenant", path: tenantPath });

  await writeJson(routesPath, routes);
  files.push({ kind: "routes", path: routesPath });

  await fsp.writeFile(caddyfilePath, generateCaddyfile(routes, { email: options.email || "" }), { encoding: "utf8", mode: 0o600 });
  files.push({ kind: "caddyfile", path: caddyfilePath });

  for (const file of productEnv.files) {
    files.push({ kind: "product-env", productCode: file.productCode, path: file.path });
  }
  files.push({ kind: "product-env-manifest", path: productEnv.manifestPath });

  const manifest = {
    tenantSlug: tenant.slug,
    generatedAt: new Date().toISOString(),
    redacted: Boolean(options.redact),
    routeHosts: routes.map((route) => route.host),
    productEnvDir: productEnv.outDir,
    files
  };
  await writeJson(manifestPath, manifest);
  files.push({ kind: "handoff-manifest", path: manifestPath });

  const checksumPath = await writeChecksums(root);
  const checksum = await sha256File(checksumPath);
  files.push({ kind: "checksums", path: checksumPath, checksum });

  return {
    outDir: root,
    tenant: tenantRecord(tenant, { redact: Boolean(options.redact) }),
    routes,
    files,
    manifestPath,
    checksumPath,
    checksum
  };
}

module.exports = {
  handoffRouteRecords,
  tenantRecord,
  writeTenantHandoff
};
