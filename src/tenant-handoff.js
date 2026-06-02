"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { sha256File, verifyChecksums, writeChecksums } = require("./checksums");
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

function relativePath(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function manifestFileRecords(root, files) {
  return files.map((file) => ({
    ...file,
    path: relativePath(root, file.path)
  }));
}

function isPortableManifestPath(value) {
  if (!value || typeof value !== "string") return false;
  const normalized = value.replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(value)) return false;
  return normalized.split("/").every((part) => part && part !== "." && part !== "..");
}

function decodeEnvValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.startsWith("\"")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function parseEnvValues(content) {
  const values = new Map();
  for (const line of String(content || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    values.set(trimmed.slice(0, index), decodeEnvValue(trimmed.slice(index + 1)));
  }
  return values;
}

function decodeUrlPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function databaseUrlPassword(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const parsed = new URL(text);
    if (!/^postgres(?:ql)?:$/i.test(parsed.protocol)) return "";
    return decodeUrlPart(parsed.password || "");
  } catch {
    const match = text.match(/postgres(?:ql)?:\/\/[^:\s@]+:([^@\s]+)@/i);
    return match ? decodeUrlPart(match[1]) : "";
  }
}

function hasUnredactedDatabasePassword(value) {
  const password = databaseUrlPassword(value);
  return Boolean(password && password !== "REDACTED");
}

function platformTokenRedacted(value) {
  const token = String(value || "").trim();
  return !token || token === "REDACTED";
}

async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
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
  const checksumPath = path.join(root, "checksums.txt");

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
  files.push({ kind: "handoff-manifest", path: manifestPath });
  files.push({ kind: "checksums", path: checksumPath });

  const manifest = {
    tenantSlug: tenant.slug,
    generatedAt: new Date().toISOString(),
    redacted: Boolean(options.redact),
    routeHosts: routes.map((route) => route.host),
    productEnvDir: relativePath(root, productEnv.outDir),
    files: manifestFileRecords(root, files)
  };
  await writeJson(manifestPath, manifest);

  await writeChecksums(root);
  const checksum = await sha256File(checksumPath);
  const returnFiles = files.map((file) => file.kind === "checksums" ? { ...file, checksum } : file);

  return {
    outDir: root,
    tenant: tenantRecord(tenant, { redact: Boolean(options.redact) }),
    routes,
    files: returnFiles,
    manifestPath,
    checksumPath,
    checksum
  };
}

async function redactedHandoffChecks(root, manifest, tenant) {
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  const checks = [{
    name: "redaction:tenant-database-url",
    ok: !hasUnredactedDatabasePassword(tenant?.databaseUrl),
    message: hasUnredactedDatabasePassword(tenant?.databaseUrl)
      ? "tenant database URL contains an unredacted password"
      : "tenant database URL password is redacted"
  }];

  for (const file of files.filter((item) => item.kind === "product-env")) {
    if (!isPortableManifestPath(file.path)) continue;
    try {
      const env = parseEnvValues(await fsp.readFile(path.join(root, file.path), "utf8"));
      const leakedDatabaseKeys = [...env.entries()]
        .filter(([key, value]) => /DATABASE_URL$/.test(key) && hasUnredactedDatabasePassword(value))
        .map(([key]) => key);
      const leakedTokenKeys = platformTokenRedacted(env.get("A1_PLATFORM_TOKEN")) ? [] : ["A1_PLATFORM_TOKEN"];
      const leakedKeys = [...leakedDatabaseKeys, ...leakedTokenKeys];
      checks.push({
        name: `redaction:product-env:${file.path}`,
        ok: leakedKeys.length === 0,
        message: leakedKeys.length === 0
          ? `${file.path} contains redacted tenant secrets`
          : `${file.path} contains unredacted values for ${leakedKeys.join(", ")}`
      });
    } catch (error) {
      checks.push({
        name: `redaction:product-env:${file.path}`,
        ok: false,
        message: error.message
      });
    }
  }

  return checks;
}

async function verifyTenantHandoff(handoffDir) {
  const root = path.resolve(handoffDir || "");
  const checks = [];
  let manifest = null;
  let tenant = null;
  let checksumFiles = [];

  for (const file of ["tenant.json", "routes.json", "Caddyfile", "handoff-manifest.json", "checksums.txt"]) {
    checks.push({
      name: `file:${file}`,
      ok: await exists(path.join(root, file)),
      message: file
    });
  }

  try {
    manifest = JSON.parse(await fsp.readFile(path.join(root, "handoff-manifest.json"), "utf8"));
    checks.push({ name: "manifest:json", ok: true, message: "handoff manifest parsed" });
  } catch (error) {
    checks.push({ name: "manifest:json", ok: false, message: error.message });
  }

  try {
    tenant = JSON.parse(await fsp.readFile(path.join(root, "tenant.json"), "utf8"));
    checks.push({ name: "tenant:json", ok: true, message: "tenant record parsed" });
  } catch (error) {
    checks.push({ name: "tenant:json", ok: false, message: error.message });
  }

  if (manifest) {
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    checks.push({
      name: "manifest:files",
      ok: files.length > 0 && files.every((file) => isPortableManifestPath(file.path)),
      message: "manifest contains portable relative file paths"
    });
    checks.push({
      name: "manifest:product-env",
      ok: files.some((file) => file.kind === "product-env"),
      message: "manifest references product env files"
    });
    for (const file of files.filter((item) => item.path)) {
      if (!isPortableManifestPath(file.path)) {
        checks.push({
          name: `manifest:file:${file.path}`,
          ok: false,
          message: "manifest file path is not portable"
        });
        continue;
      }
      checks.push({
        name: `manifest:file:${file.path}`,
        ok: await exists(path.join(root, file.path)),
        message: file.path
      });
    }
  }

  if (manifest?.redacted === true) {
    checks.push(...await redactedHandoffChecks(root, manifest, tenant));
  }

  try {
    checksumFiles = await verifyChecksums(root);
    const failed = checksumFiles.filter((check) => !check.ok);
    checks.push({
      name: "checksums",
      ok: failed.length === 0,
      message: failed.length === 0 ? "all checksum entries match" : `checksum mismatch: ${failed.map((check) => check.file).join(", ")}`,
      failed
    });
  } catch (error) {
    checks.push({ name: "checksums", ok: false, message: error.message, failed: [] });
  }

  return {
    ok: checks.every((check) => check.ok),
    handoffDir: root,
    tenantSlug: manifest?.tenantSlug || tenant?.slug || "",
    checks,
    checksumFiles
  };
}

module.exports = {
  handoffRouteRecords,
  tenantRecord,
  verifyTenantHandoff,
  writeTenantHandoff
};
