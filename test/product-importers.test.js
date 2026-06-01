"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { importCrmJson, importHayhashvapahRows, importStudioSqlite, readSqliteRows } = require("../src/product-importers");

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
