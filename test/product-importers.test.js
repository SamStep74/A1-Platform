"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { importCrmJson, importHayhashvapahRows, importStudioSqlite, readSqliteRows } = require("../src/product-importers");
const { importProductBundle, importProductData } = require("../src/product-import");

function fakePool() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("RETURNING id")) return { rows: [{ id: "batch-1" }] };
      return { rows: [], rowCount: 1 };
    }
  };
}

function fakePlatformDb(pool = fakePool()) {
  const operations = [];
  return {
    operations,
    pool,
    async getTenantBySlug(slug) {
      return {
        slug,
        databaseName: "a1_tenant_demo_client",
        deploymentTarget: "local"
      };
    },
    tenantPool(databaseName) {
      assert.equal(databaseName, "a1_tenant_demo_client");
      return pool;
    },
    async recordOperation(_slug, operation, status, details = {}) {
      const row = { id: `op-${operations.length + 1}`, operation, status, ...details };
      operations.push(row);
      return row;
    },
    async finishOperation(id, status, details = {}) {
      const row = operations.find((item) => item.id === id);
      Object.assign(row, { status, ...details });
      return row;
    }
  };
}

test("imports CRM tenant blueprint and records JSON into crm JSONB landing tables", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "a1-crm-import-"));
  const blueprintPath = path.join(dir, "tenant.json");
  const recordsPath = path.join(dir, "records.json");
  await fsp.writeFile(blueprintPath, JSON.stringify({ deployment: { slug: "demo-client" }, modules: ["sales"] }));
  await fsp.writeFile(recordsPath, JSON.stringify({ customers: [{ id: "c1", name: "Ararat" }] }));

  const pool = fakePool();
  const result = await importCrmJson({ pool, slug: "Demo Client", blueprintPath, recordsPath });

  assert.equal(result.slug, "demo-client");
  assert.equal(pool.calls.length, 2);
  assert.match(pool.calls[0].sql, /crm\.tenant_blueprints/);
  assert.match(pool.calls[1].sql, /crm\.records/);
  assert.equal(pool.calls[0].params[0], "demo-client");
});

test("imports HayHashvapah account/session/audit/meta rows into hayhashvapah schema", async () => {
  const pool = fakePool();
  const result = await importHayhashvapahRows({
    pool,
    rowsByTable: {
      accounts: [{ email: "owner@example.com", doc: JSON.stringify({ companyName: "Demo" }), updated_at: "2026-06-01T00:00:00Z" }],
      sessions: [{ token: "session-token", email: "owner@example.com", created_at: "2026-06-01T00:00:00Z", expires_at: "2026-06-02T00:00:00Z" }],
      audit_log: [{ id: "11111111-1111-4111-8111-111111111111", entry: JSON.stringify({ action: "import" }), created_at: "2026-06-01T00:00:00Z" }],
      meta: [{ key: "json_migrated", value: "2026-06-01T00:00:00Z" }]
    }
  });

  assert.deepEqual(
    { accounts: result.accounts, sessions: result.sessions, auditLog: result.auditLog, meta: result.meta },
    { accounts: 1, sessions: 1, auditLog: 1, meta: 1 }
  );
  assert.equal(pool.calls.length, 4);
  assert.match(pool.calls[0].sql, /hayhashvapah\.accounts/);
  assert.match(pool.calls[3].sql, /hayhashvapah\.meta/);
});

test("reads SQLite tables and imports Studio rows into legacy landing table", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "a1-studio-import-"));
  const sqlitePath = path.join(dir, "armosphera-one.db");
  const db = new DatabaseSync(sqlitePath);
  db.exec(`
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO organizations (id, name) VALUES ('org-1', 'Demo Org');
    CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    INSERT INTO documents (id, title) VALUES ('doc-1', 'Contract');
  `);
  db.close();

  const rows = readSqliteRows(sqlitePath);
  assert.equal(rows.organizations[0].name, "Demo Org");
  assert.equal(rows.documents[0].title, "Contract");

  const pool = fakePool();
  const result = await importStudioSqlite({ pool, sqlitePath, appVersion: "2026.06.01" });
  assert.equal(result.tables, 2);
  assert.equal(result.rows, 2);
  assert.match(pool.calls[0].sql, /studio\.sqlite_import_batches/);
  assert.match(pool.calls[1].sql, /studio\.legacy_rows/);
});

test("product import runner records tenant operation with source manifest checksum", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "a1-product-import-audit-"));
  const blueprintPath = path.join(dir, "tenant.json");
  const recordsPath = path.join(dir, "records.json");
  const sourceManifest = path.join(dir, "source-manifest.json");
  await fsp.writeFile(blueprintPath, JSON.stringify({ deployment: { slug: "demo-client" } }));
  await fsp.writeFile(recordsPath, JSON.stringify({ customers: [{ id: "c1" }] }));
  await fsp.writeFile(sourceManifest, JSON.stringify({ format_version: "1" }));

  const platformDb = fakePlatformDb();
  const result = await importProductData({
    platformDb,
    product: "crm",
    slug: "Demo Client",
    blueprintPath,
    recordsPath,
    sourceManifest
  });

  assert.equal(result.product, "crm");
  assert.equal(result.slug, "demo-client");
  assert.equal(result.artifactPath, sourceManifest);
  assert.match(result.checksum, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    platformDb.operations.map((operation) => ({
      operation: operation.operation,
      status: operation.status,
      artifactPath: operation.artifactPath,
      checksum: operation.checksum
    })),
    [{
      operation: "product.import.crm",
      status: "completed",
      artifactPath: sourceManifest,
      checksum: result.checksum
    }]
  );
});

test("product import bundle imports Studio, HayHashvapah, and CRM from source manifest paths", async () => {
  const sourceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "a1-product-source-bundle-"));
  const studioDir = path.join(sourceRoot, "studio");
  const hayhashvapahDir = path.join(sourceRoot, "hayhashvapah");
  const crmTenantDir = path.join(sourceRoot, "crm", "tenants");
  const crmRecordsDir = path.join(sourceRoot, "crm", "records");
  await fsp.mkdir(studioDir, { recursive: true });
  await fsp.mkdir(hayhashvapahDir, { recursive: true });
  await fsp.mkdir(crmTenantDir, { recursive: true });
  await fsp.mkdir(crmRecordsDir, { recursive: true });

  const studioSqlite = path.join(studioDir, "armosphera-one.db");
  const studioDb = new DatabaseSync(studioSqlite);
  studioDb.exec(`
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO organizations (id, name) VALUES ('org-1', 'Demo Org');
  `);
  studioDb.close();

  const hayhashvapahSqlite = path.join(hayhashvapahDir, "hayhashvapah.sqlite");
  const hayhashvapahDb = new DatabaseSync(hayhashvapahSqlite);
  hayhashvapahDb.exec(`
    CREATE TABLE accounts (email TEXT PRIMARY KEY, doc TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO accounts (email, doc, updated_at)
    VALUES ('owner@example.com', '{"companyName":"Demo"}', '2026-06-01T00:00:00Z');
    CREATE TABLE sessions (token TEXT PRIMARY KEY, email TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE audit_log (id TEXT PRIMARY KEY, entry TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  hayhashvapahDb.close();

  const blueprintPath = path.join(crmTenantDir, "demo-client.json");
  const recordsPath = path.join(crmRecordsDir, "demo-client.json");
  await fsp.writeFile(blueprintPath, JSON.stringify({ deployment: { slug: "demo-client" } }));
  await fsp.writeFile(recordsPath, JSON.stringify({ customers: [{ id: "c1", name: "Ararat" }] }));

  const sourceManifest = path.join(sourceRoot, "source-manifest.json");
  await fsp.writeFile(sourceManifest, JSON.stringify({
    format_version: "1",
    tenant_slug: "demo-client",
    sources: {
      studio: { remote_sqlite: studioSqlite },
      hayhashvapah: { remote_sqlite: hayhashvapahSqlite },
      crm: { remote_tenant_json: blueprintPath, remote_records_json: recordsPath }
    }
  }, null, 2));

  const platformDb = fakePlatformDb();
  const result = await importProductBundle({
    platformDb,
    slug: "demo-client",
    sourceRoot,
    sourceManifest,
    appVersion: "2026.06.01"
  });

  assert.deepEqual(result.products, ["studio", "hayhashvapah", "crm"]);
  assert.deepEqual(result.results.map((item) => item.product), ["studio", "hayhashvapah", "crm"]);
  assert.equal(result.results[0].result.rows, 1);
  assert.equal(result.results[1].result.accounts, 1);
  assert.equal(result.results[2].result.slug, "demo-client");
  assert.deepEqual(
    platformDb.operations.map((operation) => ({ operation: operation.operation, status: operation.status, artifactPath: operation.artifactPath })),
    [
      { operation: "product.import.studio", status: "completed", artifactPath: sourceManifest },
      { operation: "product.import.hayhashvapah", status: "completed", artifactPath: sourceManifest },
      { operation: "product.import.crm", status: "completed", artifactPath: sourceManifest }
    ]
  );
  assert.ok(platformDb.pool.calls.some((call) => /studio\.legacy_rows/.test(call.sql)));
  assert.ok(platformDb.pool.calls.some((call) => /hayhashvapah\.accounts/.test(call.sql)));
  assert.ok(platformDb.pool.calls.some((call) => /crm\.records/.test(call.sql)));
});

test("product import runner marks tenant operation failed when import throws", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "a1-product-import-failure-"));
  const blueprintPath = path.join(dir, "tenant.json");
  const recordsPath = path.join(dir, "records.json");
  await fsp.writeFile(blueprintPath, JSON.stringify({ deployment: { slug: "demo-client" } }));
  await fsp.writeFile(recordsPath, JSON.stringify({ customers: [] }));

  const failingPool = {
    async query() {
      throw new Error("insert failed");
    }
  };
  const platformDb = fakePlatformDb(failingPool);

  await assert.rejects(
    () => importProductData({
      platformDb,
      product: "crm",
      slug: "demo-client",
      blueprintPath,
      recordsPath
    }),
    /insert failed/
  );

  assert.equal(platformDb.operations.length, 1);
  assert.equal(platformDb.operations[0].operation, "product.import.crm");
  assert.equal(platformDb.operations[0].status, "failed");
  assert.equal(platformDb.operations[0].artifactPath, blueprintPath);
  assert.match(platformDb.operations[0].checksum, /^[a-f0-9]{64}$/);
});
