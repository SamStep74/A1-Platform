"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { readSqliteRows } = require("./sqlite");

function valueAsJson(row) {
  const clone = { ...row };
  delete clone.__rowid;
  return clone;
}

function sourcePrimaryKey(row) {
  if (row.id !== undefined && row.id !== null) return String(row.id);
  if (row.token !== undefined && row.token !== null) return String(row.token);
  if (row.email !== undefined && row.email !== null) return String(row.email);
  if (row.__rowid !== undefined && row.__rowid !== null) return String(row.__rowid);
  return crypto.createHash("sha256").update(JSON.stringify(row)).digest("hex");
}

async function importStudioSqlite(options) {
  const pool = options.pool;
  const sourcePath = options.sourcePath || options.sqlitePath || "inline";
  const rowsByTable = options.rowsByTable || readSqliteRows(sourcePath);
  const sourceSha256 = options.sourceSha256 || (fs.existsSync(sourcePath)
    ? crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex")
    : crypto.createHash("sha256").update(JSON.stringify(rowsByTable)).digest("hex"));
  const rowCounts = Object.fromEntries(Object.entries(rowsByTable).map(([table, rows]) => [table, rows.length]));

  const batch = await pool.query(
    `INSERT INTO studio.sqlite_import_batches (source_path, source_sha256, app_version, row_counts)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id`,
    [sourcePath, sourceSha256, options.appVersion || "unknown", JSON.stringify(rowCounts)]
  );
  const importBatchId = batch.rows?.[0]?.id || "inline-batch";

  let importedRows = 0;
  for (const [tableName, rows] of Object.entries(rowsByTable)) {
    for (const row of rows) {
      await pool.query(
        `INSERT INTO studio.legacy_rows (import_batch_id, table_name, source_pk, doc)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (import_batch_id, table_name, source_pk) DO UPDATE SET doc = EXCLUDED.doc`,
        [importBatchId, tableName, sourcePrimaryKey(row), JSON.stringify(valueAsJson(row))]
      );
      importedRows += 1;
    }
  }

  return {
    product: "studio",
    importBatchId,
    tables: Object.keys(rowsByTable).length,
    rows: importedRows,
    rowCounts
  };
}

module.exports = { importStudioSqlite };
