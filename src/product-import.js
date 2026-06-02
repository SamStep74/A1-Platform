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
  return productImportPathRecords(product, options).map((record) => record.path);
}

function productImportPathRecords(product, options = {}) {
  if (product === "crm") {
    return [
      { product, kind: "blueprint", path: requiredPath(options.blueprintPath, "CRM import requires --blueprint") },
      { product, kind: "records", path: requiredPath(options.recordsPath, "CRM import requires --records") }
    ];
  }
  if (product === "hayhashvapah") {
    return [{ product, kind: "sqlite", path: requiredPath(options.sqlitePath, "HayHashvapah import requires --sqlite") }];
  }
  if (product === "studio") {
    return [{ product, kind: "sqlite", path: requiredPath(options.sqlitePath, "Studio import requires --sqlite") }];
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

function fileRecordLabel(record, index) {
  return `${record.product || "file"}:${record.kind || "source"}:${index}`;
}

async function productBundleFileChecks(fileRecords) {
  const checks = [];
  for (const [index, file] of fileRecords.entries()) {
    try {
      const resolved = path.resolve(file.path);
      const stat = await fs.stat(resolved);
      const content = stat.isFile() ? await fs.readFile(resolved) : null;
      checks.push({
        ...file,
        path: resolved,
        ok: stat.isFile(),
        size: stat.isFile() ? stat.size : 0,
        checksum: content ? crypto.createHash("sha256").update(content).digest("hex") : null,
        checksumLabel: fileRecordLabel(file, index),
        message: stat.isFile() ? "file is readable" : "not a file"
      });
    } catch {
      checks.push({
        ...file,
        path: path.resolve(file.path),
        ok: false,
        size: 0,
        checksum: null,
        checksumLabel: fileRecordLabel(file, index),
        message: "file missing"
      });
    }
  }
  return checks;
}

async function assertReadableFiles(fileRecords) {
  const checks = await productBundleFileChecks(fileRecords);
  const missing = checks.filter((check) => !check.ok);
  if (missing.length) {
    const error = new Error(`Product import bundle preflight failed; missing files: ${missing.map((check) => check.path).join(", ")}`);
    error.fileChecks = checks;
    throw error;
  }
  return checks;
}

async function sha256Files(fileRecords) {
  const hash = crypto.createHash("sha256");
  const records = fileRecords
    .filter(Boolean)
    .map((record, index) => (typeof record === "string"
      ? { path: record, product: "file", kind: "source", index }
      : { ...record, index }));

  for (const record of records) {
    const resolved = path.resolve(record.path);
    hash.update(fileRecordLabel(record, record.index));
    hash.update("\0");
    hash.update(await fs.readFile(resolved));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function resolveProductBundle(options) {
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
  const productOptions = products.map((product) => productBundleImportOptions(product, slug, manifest, {
    ...options,
    sourceRoot,
    sourceManifest
  }));
  const fileRecords = [
    { product: "bundle", kind: "source-manifest", path: sourceManifest },
    ...productOptions.flatMap((item) => productImportPathRecords(item.product, item))
  ];

  return {
    slug,
    sourceRoot,
    sourceManifest,
    manifest,
    products,
    productOptions,
    fileRecords,
    sourceFiles: fileRecords.filter((item) => item.product !== "bundle").map((item) => item.path)
  };
}

async function validateProductBundle(options) {
  const bundle = await resolveProductBundle(options);
  try {
    const fileChecks = await assertReadableFiles(bundle.fileRecords);
    return { ...bundle, fileChecks };
  } catch (error) {
    error.bundle = bundle;
    throw error;
  }
}

async function checkProductBundle(options) {
  try {
    const bundle = await validateProductBundle(options);
    return {
      ok: true,
      slug: bundle.slug,
      sourceRoot: bundle.sourceRoot,
      sourceManifest: bundle.sourceManifest,
      products: bundle.products,
      files: bundle.fileChecks
    };
  } catch (error) {
    const sourceRoot = bundleSourceRoot(options);
    const sourceManifest = options.sourceManifest
      ? path.resolve(options.sourceManifest)
      : path.join(sourceRoot, "source-manifest.json");
    return {
      ok: false,
      slug: options.slug ? normalizeSlug(options.slug) : "",
      sourceRoot,
      sourceManifest,
      products: error.bundle?.products || [],
      files: error.fileChecks || [],
      error: error.message
    };
  }
}

async function importProductData(options) {
  const platformDb = options.platformDb;
  const product = String(options.product || "").trim().toLowerCase();
  const slug = normalizeSlug(options.slug);
  const tenant = await platformDb.getTenantBySlug(slug);
  if (!tenant) throw new Error(`Tenant not found: ${slug}`);

  const sourceRecords = productImportPathRecords(product, options);
  const sourcePaths = sourceRecords.map((record) => record.path);
  const sourceManifest = String(options.sourceManifest || "").trim();
  const checksum = await sha256Files(sourceRecords);
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
      if (result.studioOrgId && typeof platformDb.setTenantStudioOrgId === "function") {
        await platformDb.setTenantStudioOrgId(slug, result.studioOrgId);
      }
    }

    await platformDb.finishOperation(operation.id, "completed", { artifactPath, checksum });
    return { product, slug, result, artifactPath, checksum, operationId: operation.id };
  } catch (error) {
    await platformDb.finishOperation(operation.id, "failed", { artifactPath, checksum });
    throw error;
  }
}

async function importProductBundle(options) {
  const bundle = await validateProductBundle(options);

  const results = [];
  for (const productOptions of bundle.productOptions) {
    results.push(await importProductData({
      ...productOptions,
      platformDb: options.platformDb
    }));
  }

  return {
    slug: bundle.slug,
    sourceRoot: bundle.sourceRoot,
    sourceManifest: bundle.sourceManifest,
    products: bundle.products,
    results
  };
}

module.exports = {
  checkProductBundle,
  importProductData,
  importProductBundle,
  productBundleImportOptions,
  productBundleFileChecks,
  productImportPathRecords,
  productImportPaths,
  sha256Files,
  validateProductBundle
};
