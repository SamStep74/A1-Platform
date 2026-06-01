"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { normalizeSlug } = require("./naming");
const { importCrmJson, importHayhashvapahRows, importStudioSqlite } = require("./product-importers");

const PRODUCT_IMPORT_ORDER = Object.freeze(["studio", "hayhashvapah", "crm"]);
const DEFAULT_PRODUCT_SOURCE_ROOT = "/opt/a1/imports/product-sources";

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

async function readSourceManifest(sourceManifest) {
  if (!sourceManifest) return {};
  return JSON.parse(await fs.readFile(path.resolve(sourceManifest), "utf8"));
}

function bundleSourceRoot(options = {}) {
  if (options.sourceRoot) return path.resolve(options.sourceRoot);
  if (options.sourceManifest) return path.dirname(path.resolve(options.sourceManifest));
  return DEFAULT_PRODUCT_SOURCE_ROOT;
}

function productBundleImportOptions(product, slug, manifest = {}, options = {}) {
  const sourceRoot = bundleSourceRoot(options);
  const sources = manifest.sources || {};
  const sourceManifest = options.sourceManifest
    ? path.resolve(options.sourceManifest)
    : path.join(sourceRoot, "source-manifest.json");

  if (product === "studio") {
    return {
      product,
      slug,
      sqlitePath: sources.studio?.remote_sqlite || path.join(sourceRoot, "studio", "armosphera-one.db"),
      appVersion: options.appVersion,
      sourceManifest
    };
  }

  if (product === "hayhashvapah") {
    return {
      product,
      slug,
      sqlitePath: sources.hayhashvapah?.remote_sqlite || path.join(sourceRoot, "hayhashvapah", "hayhashvapah.sqlite"),
      sourceManifest
    };
  }

  if (product === "crm") {
    return {
      product,
      slug,
      blueprintPath: sources.crm?.remote_tenant_json || path.join(sourceRoot, "crm", "tenants", `${slug}.json`),
      recordsPath: sources.crm?.remote_records_json || path.join(sourceRoot, "crm", "records", `${slug}.json`),
      sourceManifest
    };
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

async function importProductBundle(options) {
  const slug = normalizeSlug(options.slug);
  const sourceRoot = bundleSourceRoot(options);
  const sourceManifest = options.sourceManifest
    ? path.resolve(options.sourceManifest)
    : path.join(sourceRoot, "source-manifest.json");
  const manifest = await readSourceManifest(sourceManifest);
  const manifestSlug = normalizeSlug(manifest.tenant_slug || slug);
  if (manifest.tenant_slug && manifestSlug !== slug) {
    throw new Error(`Source manifest tenant slug ${manifestSlug} does not match ${slug}`);
  }

  const products = PRODUCT_IMPORT_ORDER;
  const results = [];
  for (const product of products) {
    results.push(await importProductData({
      ...productBundleImportOptions(product, slug, manifest, {
        ...options,
        sourceRoot,
        sourceManifest
      }),
      platformDb: options.platformDb
    }));
  }

  return {
    slug,
    sourceRoot,
    sourceManifest,
    products,
    results
  };
}

module.exports = {
  importProductData,
  importProductBundle,
  productBundleImportOptions,
  productImportPaths,
  sha256Files
};
