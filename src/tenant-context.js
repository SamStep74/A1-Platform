"use strict";

const { stripHostPort } = require("./naming");

class TenantAccessError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "TenantAccessError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

async function resolveTenantContext(input) {
  const registry = input.registry;
  if (!registry || typeof registry.getTenantByHost !== "function") {
    throw new Error("resolveTenantContext requires a registry with getTenantByHost(host)");
  }

  const routeHost = stripHostPort(input.host);
  const tenant = await registry.getTenantByHost(routeHost);
  if (!tenant) {
    throw new TenantAccessError(404, "TENANT_NOT_FOUND", `No tenant route for host ${routeHost}`);
  }

  const productCode = input.productCode || "unified";
  if (tenant.status === "maintenance" || tenant.status === "migrating") {
    throw new TenantAccessError(503, "TENANT_MAINTENANCE", "Tenant is temporarily in maintenance");
  }
  if (tenant.status === "suspended" || tenant.status === "archived") {
    throw new TenantAccessError(403, "TENANT_DISABLED", `Tenant is ${tenant.status}`);
  }

  if (productCode !== "unified") {
    const module = tenant.modules.find((item) => item.code === productCode);
    if (!module || !module.enabled) {
      throw new TenantAccessError(403, "MODULE_DISABLED", `${productCode} is not enabled for this tenant`);
    }
  }

  return {
    id: tenant.id,
    slug: tenant.slug,
    companyName: tenant.companyName,
    status: tenant.status,
    modules: tenant.modules,
    databaseUrl: tenant.databaseUrl,
    storagePrefix: tenant.storagePrefix,
    productCode,
    routeHost
  };
}

function tenantContextMiddleware({ registry, productCode }) {
  return async function attachTenantContext(req) {
    req.tenant = await resolveTenantContext({
      registry,
      productCode,
      host: req.headers?.host || req.host || ""
    });
    return req.tenant;
  };
}

module.exports = { TenantAccessError, resolveTenantContext, tenantContextMiddleware };
