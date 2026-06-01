"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

async function readSqlFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

async function applySqlFile(pool, filePath) {
  const sql = await fs.readFile(filePath, "utf8");
  if (!sql.trim()) return { filePath, skipped: true };
  await pool.query(sql);
  return { filePath, skipped: false };
}

async function applySqlDirectory(pool, dir) {
  const files = await readSqlFiles(dir);
  const applied = [];
  for (const filePath of files) {
    applied.push(await applySqlFile(pool, filePath));
  }
  return applied;
}

module.exports = { readSqlFiles, applySqlFile, applySqlDirectory };
