"use strict";

function openSqliteDatabase(dbPath) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    throw new Error("SQLite imports require Node.js with node:sqlite support");
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

function parseMaybeJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback === null ? value : fallback;
  }
}

function sqliteTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
}

function readSqliteRows(dbPath, tableNames = null) {
  const db = openSqliteDatabase(dbPath);
  try {
    const allowed = new Set(tableNames || sqliteTables(db));
    const rowsByTable = {};
    for (const table of sqliteTables(db)) {
      if (!allowed.has(table)) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`Unsafe SQLite table name: ${table}`);
      rowsByTable[table] = db.prepare(`SELECT rowid AS __rowid, * FROM "${table}"`).all();
    }
    return rowsByTable;
  } finally {
    db.close();
  }
}

module.exports = { openSqliteDatabase, parseMaybeJson, sqliteTables, readSqliteRows };
