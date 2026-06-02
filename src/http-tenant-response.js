"use strict";

function headerValue(headers, name) {
  const lowerName = name.toLowerCase();
  return headers?.[lowerName] || headers?.[name] || "";
}

function platformToken(env = process.env) {
  return env.A1_PLATFORM_TOKEN || env.ADMIN_TOKEN || env.A1_ADMIN_TOKEN || "";
}

function hasSensitiveTenantAccess(headers, env = process.env) {
  const expected = platformToken(env);
  if (!expected) return false;
  const received = headerValue(headers, "x-a1-platform-token") || headerValue(headers, "x-a1-admin-token");
  return received === expected;
}

function tenantContextResponse(tenant, options = {}) {
  const response = { ...tenant };
  if (!options.includeSensitive) {
    delete response.databaseUrl;
    delete response.orgId;
    delete response.studioOrgId;
  }
  return response;
}

module.exports = {
  hasSensitiveTenantAccess,
  tenantContextResponse
};
