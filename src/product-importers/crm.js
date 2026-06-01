"use strict";

const fs = require("node:fs/promises");
const { normalizeSlug } = require("../naming");

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function importCrmJson(options) {
  const pool = options.pool;
  const slug = normalizeSlug(options.slug);
  const blueprint = options.blueprint || await readJson(options.blueprintPath);
  const records = options.records || await readJson(options.recordsPath);

  await pool.query(
    `INSERT INTO crm.tenant_blueprints (slug, doc, created_at, updated_at)
     VALUES ($1, $2::jsonb, now(), now())
     ON CONFLICT (slug) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`,
    [slug, JSON.stringify(blueprint)]
  );
  await pool.query(
    `INSERT INTO crm.records (slug, doc, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (slug) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`,
    [slug, JSON.stringify(records)]
  );

  return {
    product: "crm",
    slug,
    blueprintKeys: Object.keys(blueprint || {}).length,
    recordKeys: Object.keys(records || {}).length
  };
}

module.exports = { importCrmJson };
