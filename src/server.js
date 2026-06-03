"use strict";

const http = require("node:http");
const { getConfig } = require("./config");
const { PlatformDb } = require("./platform-db");
const { createStorage } = require("./storage");
const { resolveTenantContext, TenantAccessError } = require("./tenant-context");
const { exportTenant, importTenant, checkTenant, moveTenant } = require("./tenant-transfer");
const { normalizeModules, normalizeSlug } = require("./naming");
const { hasSensitiveTenantAccess, tenantContextResponse } = require("./http-tenant-response");
const { tenantRequestHost } = require("./request-host");

const config = getConfig();
const platformDb = new PlatformDb(config);
const storage = createStorage(config.storage);

function bodyBoolean(body, camelName, snakeName) {
  const source = body && typeof body === "object" ? body : {};
  const hasCamelValue = Object.prototype.hasOwnProperty.call(source, camelName);
  const hasSnakeValue = Object.prototype.hasOwnProperty.call(source, snakeName);
  if (!hasCamelValue && !hasSnakeValue) return false;
  return strictBodyBoolean(hasCamelValue ? source[camelName] : source[snakeName], camelName);
}

function strictBodyBoolean(value, fieldName) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  throw httpError(400, "BAD_BOOLEAN", `${fieldName} must be a boolean`);
}

function parseRequestUrl(rawUrl, host = "localhost") {
  try {
    return new URL(rawUrl, `http://${host}`);
  } catch (error) {
    const requestError = new Error("Invalid request URL");
    requestError.statusCode = 400;
    requestError.code = "INVALID_PATH";
    requestError.expose = true;
    requestError.cause = error;
    throw requestError;
  }
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function errorResponse(error, status) {
  const payload = {
    error: {
      code: error.code || "SERVER_ERROR",
      message: status >= 500 && !error.expose ? "Unexpected server error" : error.message
    }
  };
  if (status < 500 && Array.isArray(error.failedChecks)) {
    payload.error.failedChecks = error.failedChecks;
  }
  return payload;
}

function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code, expose: true });
}

function httpStatusFromError(error) {
  const hintedStatus = Number(error && (error.statusCode || error.status));
  return hintedStatus >= 400 && hintedStatus < 600 ? hintedStatus : 500;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(Object.assign(new Error("Invalid JSON body"), { statusCode: 400, code: "BAD_JSON" }));
      }
    });
  });
}

async function readJsonObject(req) {
  const body = await readJson(req);
  if (!isPlainObject(body)) throw httpError(400, "BAD_JSON_BODY", "JSON body must be an object");
  return body;
}

function normalizeTenantSlugInput(value) {
  try {
    return normalizeSlug(value);
  } catch (error) {
    throw httpError(400, "INVALID_TENANT_SLUG", error.message);
  }
}

function normalizeTenantModulesInput(value) {
  try {
    return normalizeModules(value);
  } catch (error) {
    throw httpError(400, "INVALID_TENANT_MODULES", error.message);
  }
}

function validateRouteTargetInput(value) {
  if (!value) return "";
  try {
    const parsed = new URL(String(value));
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`Unsupported route target protocol: ${value}`);
    }
    if (parsed.search || parsed.hash) {
      throw new Error(`Route target must be an origin without query/hash: ${value}`);
    }
    return String(value);
  } catch (error) {
    throw httpError(400, "INVALID_ROUTE_TARGET", error.message);
  }
}

function adminToken(env = process.env) {
  return env.ADMIN_TOKEN || env.A1_ADMIN_TOKEN || "";
}

function productionAdminAuthRequired(appConfig = {}, env = process.env) {
  return String(appConfig.appEnv || env.APP_ENV || "").toLowerCase() === "production";
}

function requireAdmin(req, appConfig = {}, env = process.env) {
  const expected = adminToken(env);
  if (!expected) {
    if (productionAdminAuthRequired(appConfig, env)) {
      throw Object.assign(new Error("Admin token is not configured"), {
        statusCode: 503,
        code: "ADMIN_AUTH_UNCONFIGURED",
        expose: true
      });
    }
    return;
  }
  const received = req.headers["x-a1-admin-token"] || "";
  if (received !== expected) {
    throw Object.assign(new Error("Admin token required"), { statusCode: 401, code: "ADMIN_AUTH_REQUIRED" });
  }
}

function createRoute(deps = { config, platformDb, storage }) {
  const {
    config: appConfig,
    platformDb: appPlatformDb,
    storage: appStorage,
    exportTenantFn = exportTenant,
    importTenantFn = importTenant,
    checkTenantFn = checkTenant,
    moveTenantFn = moveTenant
  } = deps;

  return async function route(req, res) {
    const url = parseRequestUrl(req.url, req.headers.host);

    if (req.method === "GET" && url.pathname === "/api/platform/health") {
      const health = await appPlatformDb.health();
      sendJson(res, 200, { ...health, app: "A1 Platform", version: appConfig.appVersion });
      return;
    }

    const tenantCurrentPath = url.pathname === "/api/tenants/current" || url.pathname === "/api/platform/tenants/current";
    if (req.method === "GET" && tenantCurrentPath) {
      const productCode = url.searchParams.get("product") || "unified";
      const tenant = await resolveTenantContext({ registry: appPlatformDb, host: tenantRequestHost(req.headers), productCode });
      sendJson(res, 200, {
        tenant: tenantContextResponse(tenant, {
          includeSensitive: hasSensitiveTenantAccess(req.headers)
        })
      });
      return;
    }

    if (url.pathname.startsWith("/api/admin/")) requireAdmin(req, appConfig);

    if (req.method === "POST" && url.pathname === "/api/admin/tenants") {
      const body = await readJsonObject(req);
      const tenant = await appPlatformDb.createTenant({
        slug: normalizeTenantSlugInput(body.slug),
        companyName: body.companyName || body.company_name,
        primaryDomain: body.primaryDomain || body.primary_domain,
        studioOrgId: body.studioOrgId || body.studio_org_id || body.orgId || body.org_id,
        modules: normalizeTenantModulesInput(body.modules),
        deploymentTarget: body.deploymentTarget || body.deployment_target,
        targetUrl: validateRouteTargetInput(body.targetUrl || body.target_url)
      });
      sendJson(res, 201, { ok: true, tenant });
      return;
    }

    const maintenance = url.pathname.match(/^\/api\/admin\/tenants\/([^/]+)\/maintenance$/);
    if (req.method === "POST" && maintenance) {
      const body = await readJsonObject(req);
      const modeEnabled = body.mode !== undefined ? strictBodyBoolean(body.mode, "mode") : undefined;
      const enabled = body.enabled !== undefined
        ? strictBodyBoolean(body.enabled, "enabled")
        : modeEnabled !== undefined
          ? modeEnabled
          : true;
      const tenant = await appPlatformDb.setTenantStatus(normalizeTenantSlugInput(maintenance[1]), enabled ? "maintenance" : "active");
      sendJson(res, 200, { ok: true, tenant });
      return;
    }

    const studioOrgIdMatch = url.pathname.match(/^\/api\/admin\/tenants\/([^/]+)\/studio-org-id$/);
    if (req.method === "POST" && studioOrgIdMatch) {
      const body = await readJsonObject(req);
      const studioOrgId = body.studioOrgId || body.studio_org_id || body.orgId || body.org_id;
      const tenant = await appPlatformDb.setTenantStudioOrgId(studioOrgIdMatch[1], studioOrgId);
      sendJson(res, 200, { ok: true, tenant });
      return;
    }

    const exportMatch = url.pathname.match(/^\/api\/admin\/tenants\/([^/]+)\/export$/);
    if (req.method === "POST" && exportMatch) {
      const body = await readJsonObject(req);
      const result = await exportTenantFn({
        platformDb: appPlatformDb,
        storage: appStorage,
        slug: exportMatch[1],
        outputRoot: body.outputRoot || "exports",
        keepMaintenance: bodyBoolean(body, "keepMaintenance", "keep_maintenance"),
        requireProductImports: bodyBoolean(body, "requireProductImports", "require_product_imports")
      });
      sendJson(res, 200, { ok: true, exportDir: result.outputDir, checksum: result.checksum });
      return;
    }

    const importMatch = url.pathname.match(/^\/api\/admin\/tenants\/([^/]+)\/import$/);
    if (req.method === "POST" && importMatch) {
      const body = await readJsonObject(req);
      const result = await importTenantFn({
        platformDb: appPlatformDb,
        storage: appStorage,
        slug: importMatch[1],
        importDir: body.importDir,
        activate: bodyBoolean(body, "activate", "activate"),
        requireProductImports: bodyBoolean(body, "requireProductImports", "require_product_imports")
      });
      sendJson(res, 200, { ok: true, tenant: result.tenant, restoredFiles: result.restoredFiles });
      return;
    }

    const checkMatch = url.pathname.match(/^\/api\/admin\/tenants\/([^/]+)\/check$/);
    if (req.method === "POST" && checkMatch) {
      const body = await readJsonObject(req);
      const result = await checkTenantFn({
        platformDb: appPlatformDb,
        storage: appStorage,
        slug: checkMatch[1],
        requireProductImports: bodyBoolean(body, "requireProductImports", "require_product_imports")
      });
      sendJson(res, result.ok ? 200 : 500, result);
      return;
    }

    const operationsMatch = url.pathname.match(/^\/api\/admin\/tenants\/([^/]+)\/operations$/);
    if (req.method === "GET" && operationsMatch) {
      const operations = await appPlatformDb.listTenantOperations(operationsMatch[1], {
        limit: url.searchParams.get("limit") || "50"
      });
      sendJson(res, 200, { ok: true, operations });
      return;
    }

    const moveMatch = url.pathname.match(/^\/api\/admin\/tenants\/([^/]+)\/move$/);
    if (req.method === "POST" && moveMatch) {
      const body = await readJsonObject(req);
      const result = await moveTenantFn({
        platformDb: appPlatformDb,
        storage: appStorage,
        slug: moveMatch[1],
        target: body.target,
        targetUrl: body.targetUrl || body.target_url || "",
        targetCheckUrl: body.targetCheckUrl || body.target_check_url || "",
        postSwitchCheckUrl: body.postSwitchCheckUrl || body.post_switch_check_url || "",
        outputRoot: body.outputRoot || "exports",
        requireProductImports: bodyBoolean(body, "requireProductImports", "require_product_imports")
      });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
  };
}

function createServer(deps = { config, platformDb, storage }) {
  const route = createRoute(deps);
  return http.createServer((req, res) => {
    route(req, res).catch((error) => {
      const status = httpStatusFromError(error instanceof TenantAccessError ? { statusCode: error.statusCode } : error);
      sendJson(res, status, errorResponse(error, status));
      if (status >= 500 && !error.expose) process.stderr.write(`${error.stack || error}\n`);
    });
  });
}

const server = createServer({ config, platformDb, storage });

if (require.main === module) {
  server.listen(config.apiPort, () => {
    process.stdout.write(`A1 Platform API listening on http://127.0.0.1:${config.apiPort}\n`);
  });
}

module.exports = {
  server,
  platformDb,
  storage,
  createRoute,
  createServer,
  bodyBoolean,
  errorResponse,
  adminToken,
  productionAdminAuthRequired,
  requireAdmin
};
