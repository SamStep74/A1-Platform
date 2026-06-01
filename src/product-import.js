"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { normalizeSlug } = require("./naming");
const { importCrmJson, importHayhashvapahRows, importStudioSqlite } = require("./product-importers");

function requiredPath(value, message) {
  const filePath = String(value || "").trim();
  if (!filePath) throw new Error(message);
  return filePath;
}

function productImportPaths(product, options = {}) {
  if (product === "crm") {
    return [
      requiredPath(options.blueprintPath, "CRM import requires --blueprint"),
      requiredPath(options.recordsPath, "CRM import requires --records")
    ];
  }
  if (product === "hayhashvapah") {
    return [requiredPath(options.sqlitePath, "HayHashvapah import requires --sqlite")];
  }
  if (product === "studio") {
    return [requiredPath(options.sqlitePath, "Studio import requires --sqlite")];
  }
  throw new Error(`Unknown product import: ${product}`);
}

async function sha256Files(filePaths) {
  const hash = crypto.createHash("sha256");
  for (const filePath of filePaths.filter(Boolean)) {
    const resolved = path.resolve(filePath);
    hash.update(resolved);
    hash.update("\0");
    hash.update(await fs.readFile(resolved));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function importProductData(options) {
  const platformDb = options.platformDb;
  const product = String(options.product || "").trim().toLowerCase();
  const slug = normalizeSlug(options.slug);
  const tenant = await platformDb.getTenantBySlug(slug);
  if (!tenant) throw new Error(`Tenant not found: ${slug}`);

  const sourcePaths = productImportPaths(product, options);
  const sourceManifest = String(options.sourceManifest || "").trim();
  const checksum = await sha256Files([...sourcePaths, sourceManifest]);
  const artifactPath = sourceManifest || sourcePaths[0];
  const operation = await platformDb.recordOperation(slug, `product.import.${product}`, "started", {
    artifactPath,
    checksum
  });

  try {
    const pool = platformDb.tenantPool(tenant.databaseName);
    let result;
    if (product === "crm") {
      result = await importCrmJson({
        pool,
        slug,
        blueprintPath: options.blueprintPath,
        recordsPath: options.recordsPath
      });
    } else if (product === "hayhashvapah") {
      result = await importHayhashvapahRows({ pool, sqlitePath: options.sqlitePath });
    } else if (product === "studio") {
      result = await importStudioSqlite({
        pool,
        sqlitePath: options.sqlitePath,
        appVersion: options.appVersion
      });
    }

    await platformDb.finishOperation(operation.id, "completed", { artifactPath, checksum });
    return { product, slug, result, artifactPath, checksum, operationId: operation.id };
  } catch (error) {
    await platformDb.finishOperation(operation.id, "failed", { artifactPath, checksum });
    throw error;
  }
}

module.exports = {
  importProductData,
  productImportPaths,
  sha256Files
};
