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

test("createTenant stores Studio org mapping only when explicitly supplied", async () => {
  const queries = [];
  const db = Object.create(PlatformDb.prototype);
  db.config = { appVersion: "2026.06.01", appDomain: "a1suite.am" };
  db.migrateRegistry = async () => [];
  db.ensureTenantDatabase = async () => true;
  db.runTenantMigrations = async () => [];
  db.getTenantBySlug = async () => ({ slug: "demo-client" });
  db.registryPool = {
    connect: async () => ({
      query: async (sql, params = []) => {
        queries.push({ sql, params });
        return { rows: [{ id: "tenant-1" }] };
      },
      release: () => {}
    })
  };

  await db.createTenant({
    slug: "demo-client",
    companyName: "Demo Client LLC",
    primaryDomain: "demo-client.a1suite.am",
    modules: ["studio"],
    studioOrgId: "org-armosphera-demo"
  });

  const insert = queries.find((query) => /INSERT INTO tenants/.test(query.sql));
  assert.match(insert.sql, /studio_org_id/);
  assert.match(insert.sql, /CASE WHEN \$10::boolean THEN EXCLUDED\.studio_org_id ELSE tenants\.studio_org_id END/);
  assert.equal(insert.params[8], "org-armosphera-demo");
  assert.equal(insert.params[9], true);

  queries.length = 0;
  await db.createTenant({
    slug: "demo-client",
    companyName: "Demo Client LLC",
    primaryDomain: "demo-client.a1suite.am",
    modules: ["studio"]
  });

  const rerunInsert = queries.find((query) => /INSERT INTO tenants/.test(query.sql));
  assert.equal(rerunInsert.params[8], "");
  assert.equal(rerunInsert.params[9], false);
});

test("createTenant normalizes route target URL to origin before persistence", async () => {
  const queries = [];
  const db = Object.create(PlatformDb.prototype);
  db.config = { appVersion: "2026.06.01", appDomain: "a1suite.am" };
  db.migrateRegistry = async () => [];
  db.ensureTenantDatabase = async () => true;
  db.runTenantMigrations = async () => [];
  db.getTenantBySlug = async () => ({ slug: "demo-client" });
  db.registryPool = {
    connect: async () => ({
      query: async (sql, params = []) => {
        queries.push({ sql, params });
        if (/INSERT INTO tenants/.test(sql)) return { rows: [{ id: "tenant-1" }] };
        if (/INSERT INTO tenant_routes/.test(sql)) return { rows: [] };
        if (/INSERT INTO tenant_modules/.test(sql)) return { rowCount: 1, rows: [] };
        return {};
      },
      release: () => {}
    })
  };

  await db.createTenant({
    slug: "demo-client",
    companyName: "Demo Client LLC",
    primaryDomain: "demo-client.a1suite.am",
    modules: ["studio"],
    targetUrl: "https://api.internal:4200/path"
  });

  const routeInsert = queries.find((query) => /INSERT INTO tenant_routes/.test(query.sql));
  assert.equal(routeInsert.params[2], "https://api.internal:4200");
});

test("createTenant rejects invalid route target URL values", async () => {
  const db = Object.create(PlatformDb.prototype);
  db.config = { appVersion: "2026.06.01", appDomain: "a1suite.am" };
  db.migrateRegistry = async () => [];
  db.ensureTenantDatabase = async () => true;
  db.runTenantMigrations = async () => [];

  await assert.rejects(
    () => db.createTenant({
      slug: "demo-client",
      companyName: "Demo Client LLC",
      primaryDomain: "demo-client.a1suite.am",
      modules: ["studio"],
      targetUrl: "file:///tmp/api"
    }),
    /Unsupported route target protocol: file:\/\/\/tmp\/api/
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
    enabled: "false",
    schema_version: "2026.06.hh"
  });

  assert.match(capturedSql, /INSERT INTO tenant_modules/);
  assert.match(capturedSql, /enabled = EXCLUDED\.enabled/);
  assert.match(capturedSql, /schema_version = EXCLUDED\.schema_version/);
  assert.deepEqual(capturedParams, ["tenant-1", "hayhashvapah", false, "2026.06.hh"]);
  assert.equal(result.slug, "demo-client");

  await assert.rejects(
    () => db.setTenantModule("demo-client", {
      module_code: "crm",
      enabled: "maybe",
      schema_version: "2026.06.crm"
    }),
    /enabled must be a boolean/
  );
});

test("setTenantRoute parses false active strings without activating the route", async () => {
  let capturedSql = "";
  let capturedParams = [];
  const tenant = { id: "tenant-1", slug: "demo-client", primaryDomain: "demo-client.a1suite.am", routes: [] };
  const db = Object.create(PlatformDb.prototype);
  db.getTenantBySlug = async () => tenant;
  db.registryPool = {
    query: async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] };
    }
  };

  const result = await db.setTenantRoute("demo-client", {
    host: "demo-client.a1suite.am",
    target_url: "http://api:4200",
    active: "false"
  });

  assert.match(capturedSql, /INSERT INTO tenant_routes/);
  assert.deepEqual(capturedParams, ["tenant-1", "demo-client.a1suite.am", "unified", "http://api:4200", false]);
  assert.equal(result.slug, "demo-client");

  await assert.rejects(
    () => db.setTenantRoute("demo-client", {
      host: "demo-client.a1suite.am",
      target_url: "http://api:4200",
      active: { enabled: true }
    }),
    /active must be a boolean/
  );
});

test("updateTenantDeployment normalizes route target URL before updating active routes", async () => {
  const queries = [];
  const db = Object.create(PlatformDb.prototype);
  db.getTenantBySlug = async () => ({ id: "tenant-1", slug: "demo-client" });
  db.registryPool = {
    connect: async () => ({
      query: async (sql, params = []) => {
        queries.push({ sql, params });
        if (/UPDATE tenants/.test(sql)) {
          return { rows: [{ id: "tenant-1", slug: "demo-client" }] };
        }
        if (/UPDATE tenant_routes/.test(sql)) return { rowCount: 1 };
        return {};
      },
      release: () => {}
    })
  };
  db.inflateTenant = async (row) => ({ slug: row.slug, id: row.id });

  const result = await db.updateTenantDeployment("demo-client", "vps-01", "https://api.internal:4200/path");

  const routeUpdate = queries.find((query) => /UPDATE tenant_routes SET target_url/.test(query.sql));
  assert.deepEqual(routeUpdate.params, ["tenant-1", "https://api.internal:4200"]);
  assert.deepEqual(result, { slug: "demo-client", id: "tenant-1" });
});

test("updateTenantDeployment rejects malformed route target URL", async () => {
  const db = Object.create(PlatformDb.prototype);
  db.getTenantBySlug = async () => ({ id: "tenant-1", slug: "demo-client" });
  db.registryPool = {
    connect: async () => ({
      query: async () => ({}),
      release: () => {}
    })
  };

  await assert.rejects(
    () => db.updateTenantDeployment("demo-client", "vps-01", "http://127.0.0.1:4200/path?x=1"),
    /Route target must be an origin without query\/hash: http:\/\/127\.0\.0\.1:4200\/path\?x=1/
  );
});

test("setTenantStudioOrgId updates the registry mapping", async () => {
  let capturedSql = "";
  let capturedParams = [];
  const db = Object.create(PlatformDb.prototype);
  db.getTenantBySlug = async () => ({ slug: "demo-client" });
  db.inflateTenant = async (row) => ({ slug: row.slug, studioOrgId: row.studio_org_id });
  db.registryPool = {
    query: async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return {
        rowCount: 1,
        rows: [{ slug: "demo-client", studio_org_id: params[1] }]
      };
    }
  };

  const result = await db.setTenantStudioOrgId("demo-client", " org-armosphera-demo ");

  assert.match(capturedSql, /UPDATE tenants SET studio_org_id = \$2/);
  assert.deepEqual(capturedParams, ["demo-client", "org-armosphera-demo"]);
  assert.deepEqual(result, { slug: "demo-client", studioOrgId: "org-armosphera-demo" });

  await assert.rejects(
    () => db.setTenantStudioOrgId("demo-client", " "),
    /Studio org id is required/
  );
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
    studioOrgId: "org-armosphera-demo",
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
  assert.ok(health.checks.some((check) => check.name === "mapping:studio.org" && check.ok));
  assert.equal(checkNames.includes("data:studio.legacy_rows"), true);
  assert.equal(checkNames.includes("data:crm.records"), true);
});

test("tenantHealth fails when enabled Studio lacks an org mapping", async () => {
  const tenant = {
    id: "tenant-1",
    slug: "demo-client",
    databaseName: "a1_tenant_demo_client",
    studioOrgId: "",
    modules: [
      { code: "studio", enabled: true },
      { code: "crm", enabled: true }
    ]
  };
  const db = Object.create(PlatformDb.prototype);
  db.getTenantBySlug = async () => tenant;
  db.tenantPool = () => ({
    query: async (sql, params = []) => {
      if (/information_schema\.schemata/.test(sql)) {
        return { rows: params[0].map((schema_name) => ({ schema_name })) };
      }
      return { rows: [{ "?column?": 1 }] };
    }
  });
  db.tenantDataCounts = async () => ({
    core_organizations: 1,
    core_users: 1,
    studio_sqlite_import_batches: 1,
    studio_legacy_rows: 10,
    studio_documents: 0,
    crm_tenant_blueprints: 1,
    crm_records: 1,
    crm_files: 0,
    crm_audit_log: 0,
    audit_events: 1
  });

  const health = await db.tenantHealth("demo-client");

  assert.equal(health.ok, false);
  assert.ok(health.checks.some((check) => (
    check.name === "mapping:studio.org" &&
    !check.ok &&
    check.message === "Studio org mapping missing"
  )));
});

test("tenantHealth skips Studio org mapping when Studio is disabled", async () => {
  const tenant = {
    id: "tenant-1",
    slug: "demo-client",
    databaseName: "a1_tenant_demo_client",
    modules: [
      { code: "studio", enabled: false },
      { code: "crm", enabled: true }
    ]
  };
  const db = Object.create(PlatformDb.prototype);
  db.getTenantBySlug = async () => tenant;
  db.tenantPool = () => ({
    query: async (sql, params = []) => {
      if (/information_schema\.schemata/.test(sql)) {
        return { rows: params[0].map((schema_name) => ({ schema_name })) };
      }
      return { rows: [{ "?column?": 1 }] };
    }
  });
  db.tenantDataCounts = async () => ({
    core_organizations: 1,
    core_users: 1,
    crm_tenant_blueprints: 1,
    crm_records: 1,
    crm_files: 0,
    crm_audit_log: 0,
    audit_events: 1
  });

  const health = await db.tenantHealth("demo-client");

  assert.equal(health.ok, true);
  assert.equal(health.checks.some((check) => check.name === "mapping:studio.org"), false);
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
      studio_org_id: "org-armosphera-demo",
      database_name: "a1_tenant_demo_client",
      storage_prefix: "tenants/demo-client/",
      deployment_target: "vps-01",
      app_version: "2026.06.01",
      region: "am"
    },
    modules: [
      { module_code: "studio", enabled: true, schema_version: "2026.06.studio" },
      { module_code: "hayhashvapah", enabled: "false", schema_version: "2026.06.hh" },
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
        active: "false"
      }
    ]
  });

  assert.deepEqual(calls[0], {
    kind: "create",
    input: {
      slug: "demo-client",
      companyName: "Demo Client LLC",
      primaryDomain: "demo-client.a1suite.am",
      studioOrgId: "org-armosphera-demo",
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

test("registry import rejects malformed secondary route targets before tenant mutation", async () => {
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

  await assert.rejects(
    () => db.upsertTenantFromRegistry({
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
          target_url: "file:///tmp/secret-a1-platform-route-token",
          active: true
        }
      ]
    }),
    /Unsupported route target protocol: file:\/\/\/tmp\/secret-a1-platform-route-token/
  );
  assert.deepEqual(calls, []);
});

test("registry import drops blank secondary route hosts before route mutation", async () => {
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
    routes: calls.filter((call) => call.kind === "route").map((call) => call.input)
  });

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
    routes: [
      {
        host: "demo-client.a1suite.am",
        product_code: "unified",
        target_url: "http://api:4200",
        active: true
      },
      {
        host: "   ",
        product_code: "crm",
        target_url: "http://crm:4200",
        active: true
      }
    ]
  });

  assert.deepEqual(
    calls.filter((call) => call.kind === "route").map((call) => call.input.host),
    ["demo-client.a1suite.am"]
  );
  assert.deepEqual(calls.find((call) => call.kind === "route-reconcile").hosts, ["demo-client.a1suite.am"]);
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
