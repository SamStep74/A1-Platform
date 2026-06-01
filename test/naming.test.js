"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeSlug,
  tenantDatabaseName,
  storagePrefix,
  normalizeModules,
  defaultTenantDomain
} = require("../src/naming");

test("normalizes tenant slugs into portable ASCII route slugs", () => {
  assert.equal(normalizeSlug(" Ararat Trade LLC "), "ararat-trade-llc");
  assert.equal(tenantDatabaseName("Ararat Trade LLC"), "a1_tenant_ararat_trade_llc");
  assert.equal(storagePrefix("Ararat Trade LLC"), "tenants/ararat-trade-llc/");
  assert.equal(defaultTenantDomain("Ararat Trade LLC", "a1suite.am"), "ararat-trade-llc.a1suite.am");
});

test("rejects empty slugs and unknown modules", () => {
  assert.throws(() => normalizeSlug("!!!"), /Tenant slug is required/);
  assert.throws(() => normalizeModules("studio,billing"), /Unknown module: billing/);
});

test("defaults to all current product modules", () => {
  assert.deepEqual(normalizeModules(""), ["studio", "hayhashvapah", "crm"]);
});
