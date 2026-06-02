"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("registry migration implements the public tenant contract", () => {
  const registryDir = path.join(__dirname, "..", "migrations", "registry");
  const sql = fs.readdirSync(registryDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => fs.readFileSync(path.join(registryDir, file), "utf8"))
    .join("\n");
  for (const table of ["tenants", "tenant_modules", "tenant_routes", "tenant_operations"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  for (const status of ["active", "maintenance", "suspended", "migrating", "archived"]) {
    assert.match(sql, new RegExp(status));
  }
  for (const moduleCode of ["studio", "hayhashvapah", "crm"]) {
    assert.match(sql, new RegExp(moduleCode));
  }
  assert.match(sql, /studio_org_id TEXT NOT NULL DEFAULT ''/);
});
