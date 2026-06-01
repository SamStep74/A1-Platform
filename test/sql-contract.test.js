"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("registry migration implements the public tenant contract", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "registry", "001_registry.sql"), "utf8");
  for (const table of ["tenants", "tenant_modules", "tenant_routes", "tenant_operations"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  for (const status of ["active", "maintenance", "suspended", "migrating", "archived"]) {
    assert.match(sql, new RegExp(status));
  }
  for (const moduleCode of ["studio", "hayhashvapah", "crm"]) {
    assert.match(sql, new RegExp(moduleCode));
  }
});
