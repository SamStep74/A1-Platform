"use strict";

const { parseMaybeJson, readSqliteRows } = require("./sqlite");

function normalizeRows(rowsByTable) {
  return {
    accounts: rowsByTable.accounts || [],
    sessions: rowsByTable.sessions || [],
    auditLog: rowsByTable.audit_log || [],
    meta: rowsByTable.meta || []
  };
}

async function importHayhashvapahRows(options) {
  const pool = options.pool;
  const rows = normalizeRows(options.rowsByTable || readSqliteRows(options.sqlitePath, ["accounts", "sessions", "audit_log", "meta"]));

  for (const row of rows.accounts) {
    await pool.query(
      `INSERT INTO hayhashvapah.accounts (email, doc, updated_at)
       VALUES ($1, $2::jsonb, COALESCE($3::timestamptz, now()))
       ON CONFLICT (email) DO UPDATE SET doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at`,
      [row.email, JSON.stringify(parseMaybeJson(row.doc, {})), row.updated_at || null]
    );
  }

  for (const row of rows.sessions) {
    await pool.query(
      `INSERT INTO hayhashvapah.sessions (token, email, created_at, expires_at)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4::timestamptz)
       ON CONFLICT (token) DO UPDATE SET email = EXCLUDED.email, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at`,
      [row.token, row.email, row.created_at || null, row.expires_at]
    );
  }

  for (const row of rows.auditLog) {
    await pool.query(
      `INSERT INTO hayhashvapah.audit_log (id, entry, created_at)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2::jsonb, COALESCE($3::timestamptz, now()))
       ON CONFLICT (id) DO UPDATE SET entry = EXCLUDED.entry, created_at = EXCLUDED.created_at`,
      [row.id || null, JSON.stringify(parseMaybeJson(row.entry, {})), row.created_at || null]
    );
  }

  for (const row of rows.meta) {
    await pool.query(
      `INSERT INTO hayhashvapah.meta (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [row.key, String(row.value)]
    );
  }

  return {
    product: "hayhashvapah",
    accounts: rows.accounts.length,
    sessions: rows.sessions.length,
    auditLog: rows.auditLog.length,
    meta: rows.meta.length
  };
}

module.exports = { importHayhashvapahRows };
