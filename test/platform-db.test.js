"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PlatformDb } = require("../src/platform-db");

test("lists tenant operations with camelCase fields and bounded limit", async () => {
  let capturedSql = "";
  let capturedParams = [];
  const startedAt = new Date("2026-06-01T09:00:00.000Z");
  const finishedAt = new Date("2026-06-01T09:01:00.000Z");
  const db = Object.create(PlatformDb.prototype);
  db.getTenantBySlug = async (slug) => ({ id: "tenant-1", slug });
  db.registryPool = {
    query: async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return {
        rows: [{
          id: "operation-1",
          tenant_id: "tenant-1",
          operation: "product.import.crm",
          status: "completed",
          source_target: "local",
          destination_target: null,
          artifact_path: "/opt/a1/imports/product-sources/source-manifest.json",
          checksum: "sha256:abc",
          started_at: startedAt,
          finished_at: finishedAt
        }]
      };
    }
  };

  const operations = await db.listTenantOperations("demo-client", { limit: 500 });

  assert.match(capturedSql, /FROM tenant_operations/);
  assert.match(capturedSql, /ORDER BY started_at DESC, id DESC/);
  assert.deepEqual(capturedParams, ["tenant-1", 200]);
  assert.deepEqual(operations, [{
    id: "operation-1",
    tenantId: "tenant-1",
    operation: "product.import.crm",
    status: "completed",
    sourceTarget: "local",
    destinationTarget: null,
    artifactPath: "/opt/a1/imports/product-sources/source-manifest.json",
    checksum: "sha256:abc",
    startedAt,
    finishedAt
  }]);
});

test("tenant operation listing rejects unknown tenants", async () => {
  const db = Object.create(PlatformDb.prototype);
  db.getTenantBySlug = async () => null;

  await assert.rejects(
    () => db.listTenantOperations("missing-client"),
    /Tenant not found: missing-client/
  );
});

test("setTenantModule preserves enabled state and schema version", async () => {
  let capturedSql = "";
  let capturedParams = [];
  const tenant = { id: "tenant-1", slug: "demo-client" };
  const db = Object.create(PlatformDb.prototype);
  db.getTenantBySlug = async () => tenant;
  db.registryPool = {
    query: async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] };
    }
  };

  const result = await db.setTenantModule("demo-client", {
    module_code: "hayhashvapah",
    enabled: false,
    schema_version: "2026.06.hh"
  });

  assert.match(capturedSql, /INSERT INTO tenant_modules/);
  assert.match(capturedSql, /enabled = EXCLUDED\.enabled/);
  assert.match(capturedSql, /schema_version = EXCLUDED\.schema_version/);
  assert.deepEqual(capturedParams, ["tenant-1", "hayhashvapah", false, "2026.06.hh"]);
  assert.equal(result.slug, "demo-client");
});

test("deactivateTenantRoutesExcept marks stale route hosts inactive", async () => {
  let capturedSql = "";
  let capturedParams = [];
  const tenant = { id: "tenant-1", slug: "demo-client" };
  const db = Object.create(PlatformDb.prototype);
  db.getTenantBySlug = async () => tenant;
  db.registryPool = {
    query: async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] };
    }
  };

  const result = await db.deactivateTenantRoutesExcept("demo-client", [
    "Demo-Client.a1suite.am:443",
    "crm.demo-client.a1suite.am"
  ]);

  assert.match(capturedSql, /UPDATE tenant_routes SET active = false/);
  assert.match(capturedSql, /NOT \(host = ANY\(\$2::text\[\]\)\)/);
  assert.deepEqual(capturedParams, ["tenant-1", ["demo-client.a1suite.am", "crm.demo-client.a1suite.am"]]);
  assert.equal(result.slug, "demo-client");
});

test("tenantHealth checks only enabled product module schemas and tables", async () => {
  let requestedSchemas = [];
  const tenant = {
    id: "tenant-1",
    slug: "demo-client",
    databaseName: "a1_tenant_demo_client",
    modules: [
      { code: "studio", enabled: true },
      { code: "hayhashvapah", enabled: false },
      { code: "crm", enabled: true }
    ]
  };
  const db = Object.create(PlatformDb.prototype);
  db.getTenantBySlug = async () => tenant;
  db.tenantPool = () => ({
    query: async (sql, params = []) => {
      if (/information_schema\.schemata/.test(sql)) {
        requestedSchemas = params[0];
        return { rows: requestedSchemas.map((schema_name) => ({ schema_name })) };
      }
      return { rows: [{ "?column?": 1 }] };
    }
  });
  db.tenantDataCounts = async () => ({
    core_organizations: 1,
    core_users: 2,
    studio_sqlite_import_batches: 1,
    studio_legacy_rows: 10,
    studio_documents: 0,
    crm_tenant_blueprints: 1,
    crm_records: 3,
    crm_files: 0,
    crm_audit_log: 0,
    audit_events: 4
  });

  const health = await db.tenantHealth("demo-client");
  const checkNames = health.checks.map((check) => check.name);

  assert.equal(health.ok, true);
  assert.deepEqual(requestedSchemas, ["core", "studio", "crm", "audit"]);
  assert.equal(checkNames.includes("schema:hayhashvapah"), false);
  assert.equal(checkNames.includes("data:hayhashvapah.accounts"), false);
  assert.equal(checkNames.includes("data:studio.legacy_rows"), true);
  assert.equal(checkNames.includes("data:crm.records"), true);
});

test("tenantDataCounts skips disabled product module tables", async () => {
  const relations = [];
  const tenant = {
    databaseName: "a1_tenant_demo_client",
    modules: [
      { code: "studio", enabled: true },
      { code: "hayhashvapah", enabled: false },
      { code: "crm", enabled: true }
    ]
  };
  const db = Object.create(PlatformDb.prototype);
  db.getTenantBySlug = async () => tenant;
  db.tenantPool = () => ({
    query: async (sql, params = []) => {
      if (/to_regclass/.test(sql)) {
        relations.push(params[0]);
        return { rows: [{ relation: params[0] }] };
      }
      return { rows: [{ count: "0" }] };
    }
  });

  const counts = await db.tenantDataCounts(tenant);

  assert.equal(Object.hasOwn(counts, "hayhashvapah_accounts"), false);
  assert.equal(relations.includes("hayhashvapah.accounts"), false);
  assert.equal(relations.includes("studio.legacy_rows"), true);
  assert.equal(relations.includes("crm.records"), true);
  assert.equal(relations.includes("audit.events"), true);
});

test("registry import restores tenant modules and every exported route", async () => {
  const calls = [];
  const db = Object.create(PlatformDb.prototype);
  db.config = { appVersion: "2026.06.01" };
  db.createTenant = async (input) => {
    calls.push({ kind: "create", input });
    return { slug: input.slug };
  };
  db.setTenantModule = async (slug, input) => {
    calls.push({ kind: "module", slug, input });
    return { slug };
  };
  db.setTenantRoute = async (slug, input) => {
    calls.push({ kind: "route", slug, input });
    return { slug };
  };
  db.deactivateTenantRoutesExcept = async (slug, hosts) => {
    calls.push({ kind: "route-reconcile", slug, hosts });
    return { slug };
  };
  db.getTenantBySlug = async (slug) => ({
    slug,
    modules: calls.filter((call) => call.kind === "module").map((call) => call.input),
    routes: calls.filter((call) => call.kind === "route").map((call) => call.input)
  });

  const tenant = await db.upsertTenantFromRegistry({
    tenant: {
      slug: "demo-client",
      company_name: "Demo Client LLC",
      primary_domain: "demo-client.a1suite.am",
      database_name: "a1_tenant_demo_client",
      storage_prefix: "tenants/demo-client/",
      deployment_target: "vps-01",
      app_version: "2026.06.01",
      region: "am"
    },
    modules: [
      { module_code: "studio", enabled: true, schema_version: "2026.06.studio" },
      { module_code: "hayhashvapah", enabled: false, schema_version: "2026.06.hh" },
      { module_code: "crm", enabled: true, schema_version: "2026.06.crm" }
    ],
    routes: [
      {
        host: "demo-client.a1suite.am",
        product_code: "unified",
        target_url: "http://api:4200",
        active: true
      },
      {
        host: "crm.demo-client.a1suite.am",
        product_code: "crm",
        target_url: "http://crm:4200",
        active: true
      },
      {
        host: "old-demo-client.a1suite.am",
        productCode: "studio",
        targetUrl: "http://old-studio:4200",
        active: false
      }
    ]
  });

  assert.deepEqual(calls[0], {
    kind: "create",
    input: {
      slug: "demo-client",
      companyName: "Demo Client LLC",
      primaryDomain: "demo-client.a1suite.am",
      databaseName: "a1_tenant_demo_client",
      storagePrefix: "tenants/demo-client/",
      modules: ["studio", "crm"],
      deploymentTarget: "vps-01",
      appVersion: "2026.06.01",
      region: "am",
      routeHost: "demo-client.a1suite.am",
      targetUrl: "http://api:4200"
    }
  });
  assert.deepEqual(
    calls.filter((call) => call.kind === "module").map((call) => call.input),
    [
      { code: "studio", enabled: true, schemaVersion: "2026.06.studio" },
      { code: "hayhashvapah", enabled: false, schemaVersion: "2026.06.hh" },
      { code: "crm", enabled: true, schemaVersion: "2026.06.crm" }
    ]
  );
  assert.deepEqual(
    calls.filter((call) => call.kind === "route").map((call) => call.input),
    [
      {
        host: "demo-client.a1suite.am",
        productCode: "unified",
        targetUrl: "http://api:4200",
        active: true
      },
      {
        host: "crm.demo-client.a1suite.am",
        productCode: "crm",
        targetUrl: "http://crm:4200",
        active: true
      },
      {
        host: "old-demo-client.a1suite.am",
        productCode: "studio",
        targetUrl: "http://old-studio:4200",
        active: false
      }
    ]
  );
  assert.deepEqual(calls.find((call) => call.kind === "route-reconcile"), {
    kind: "route-reconcile",
    slug: "demo-client",
    hosts: [
      "demo-client.a1suite.am",
      "crm.demo-client.a1suite.am",
      "old-demo-client.a1suite.am"
    ]
  });
  assert.equal(tenant.modules.length, 3);
  assert.equal(tenant.routes.length, 3);
});

test("registry import disables modules absent from the bundle registry", async () => {
  const calls = [];
  const db = Object.create(PlatformDb.prototype);
  db.config = { appVersion: "2026.06.01" };
  db.createTenant = async (input) => {
    calls.push({ kind: "create", input });
    return { slug: input.slug };
  };
  db.setTenantModule = async (slug, input) => {
    calls.push({ kind: "module", slug, input });
    return { slug };
  };
  db.setTenantRoute = async (slug, input) => {
    calls.push({ kind: "route", slug, input });
    return { slug };
  };
  db.deactivateTenantRoutesExcept = async (slug, hosts) => {
    calls.push({ kind: "route-reconcile", slug, hosts });
    return { slug };
  };
  db.getTenantBySlug = async (slug) => ({ slug });

  await db.upsertTenantFromRegistry({
    tenant: {
      slug: "demo-client",
      company_name: "Demo Client LLC",
      primary_domain: "demo-client.a1suite.am",
      database_name: "a1_tenant_demo_client",
      storage_prefix: "tenants/demo-client/",
      deployment_target: "vps-01",
      app_version: "2026.06.01",
      region: "am"
    },
    modules: [
      { module_code: "studio", enabled: true, schema_version: "2026.06.studio" },
      { module_code: "crm", enabled: true, schema_version: "2026.06.crm" }
    ]
  });

  assert.deepEqual(calls.find((call) => call.kind === "create").input.modules, ["studio", "crm"]);
  assert.deepEqual(
    calls.filter((call) => call.kind === "module").map((call) => call.input),
    [
      { code: "studio", enabled: true, schemaVersion: "2026.06.studio" },
      { code: "crm", enabled: true, schemaVersion: "2026.06.crm" },
      { code: "hayhashvapah", enabled: false, schemaVersion: "0" }
    ]
  );
});
