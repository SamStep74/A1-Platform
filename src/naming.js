"use strict";

const MODULES = Object.freeze(["studio", "hayhashvapah", "crm"]);
const PRODUCT_CODES = Object.freeze(["studio", "hayhashvapah", "crm", "unified"]);
const STATUS_VALUES = Object.freeze(["active", "maintenance", "suspended", "migrating", "archived"]);

function normalizeSlug(value) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  if (!slug) throw new Error("Tenant slug is required");
  if (slug.length > 48) throw new Error("Tenant slug must be 48 characters or fewer");
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(slug)) {
    throw new Error(`Invalid tenant slug: ${value}`);
  }
  return slug;
}

function tenantDatabaseName(slug) {
  return `a1_tenant_${normalizeSlug(slug).replace(/-/g, "_")}`;
}

function validateTenantDatabaseName(name) {
  const databaseName = String(name || "");
  if (!/^a1_tenant_[a-z0-9_]{1,58}$/.test(databaseName)) {
    throw new Error(`Unsafe tenant database name: ${name}`);
  }
  return databaseName;
}

function storagePrefix(slug) {
  return `tenants/${normalizeSlug(slug)}/`;
}

function normalizeModules(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  const modules = raw.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  const unique = [...new Set(modules.length ? modules : MODULES)];
  for (const moduleCode of unique) {
    if (!MODULES.includes(moduleCode)) {
      throw new Error(`Unknown module: ${moduleCode}`);
    }
  }
  return unique;
}

function normalizeProductCode(value = "unified") {
  const productCode = String(value || "unified").trim().toLowerCase();
  if (!PRODUCT_CODES.includes(productCode)) {
    throw new Error(`Unknown product code: ${value}`);
  }
  return productCode;
}

function normalizeStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (!STATUS_VALUES.includes(status)) throw new Error(`Unknown tenant status: ${value}`);
  return status;
}

function stripHostPort(host) {
  return String(host || "").trim().toLowerCase().replace(/:\d+$/, "");
}

function defaultTenantDomain(slug, appDomain) {
  return `${normalizeSlug(slug)}.${String(appDomain || "a1suite.am").replace(/^\*\./, "")}`;
}

module.exports = {
  MODULES,
  PRODUCT_CODES,
  STATUS_VALUES,
  normalizeSlug,
  tenantDatabaseName,
  validateTenantDatabaseName,
  storagePrefix,
  normalizeModules,
  normalizeProductCode,
  normalizeStatus,
  stripHostPort,
  defaultTenantDomain
};
