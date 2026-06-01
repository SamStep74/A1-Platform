"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { normalizeProductCode } = require("./naming");

const PRODUCT_CODES = Object.freeze(["studio", "hayhashvapah", "crm"]);

function envValue(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:@{}?=&%+,\-]*$/.test(text)) return text;
  return JSON.stringify(text);
}

function redactUrl(value) {
  if (!value) return "";
  try {
    const parsed = new URL(String(value));
    if (parsed.password) parsed.password = "REDACTED";
    return parsed.toString();
  } catch {
    return "REDACTED";
  }
}

function tenantModuleEnabled(tenant, productCode) {
  return Boolean((tenant.modules || []).find((item) => item.code === productCode && item.enabled !== false));
}

function line(key, value) {
  return `${key}=${envValue(value)}`;
}

function productCodesFor(productCode) {
  const product = String(productCode || "").trim().toLowerCase();
  if (product === "all") return PRODUCT_CODES;
  return [normalizeProductCode(product)];
}

function commonPlatformEnv(options = {}) {
  return [
    line("A1_PLATFORM_TENANT_RESOLUTION", "1"),
    line("A1_PLATFORM_API_URL", options.platformApiUrl || "http://127.0.0.1:8088"),
    line("A1_PLATFORM_TOKEN", options.redact && options.platformToken ? "REDACTED" : (options.platformToken || "")),
    line("A1_PLATFORM_TENANT_TIMEOUT_MS", options.timeoutMs || 1500),
    line("A1_PLATFORM_TENANT_STRICT", options.strict === false ? "" : "1")
  ];
}

function studioEnv(_tenant, options = {}) {
  return [
    ...commonPlatformEnv(options),
    line("ARMOSPHERA_ONE_DATA_DIR", options.studioDataDir || "/opt/a1/product-data/studio"),
    line("ARMOSPHERA_ONE_DB", options.studioSqlite || "/opt/a1/product-data/studio/armosphera-one.db"),
    line("A1_STUDIO_DATA_DIR", options.studioDataDir || "/opt/a1/product-data/studio")
  ];
}

function hayhashvapahEnv(_tenant, options = {}) {
  return [
    ...commonPlatformEnv(options),
    line("A1_HAYHASHVAPAH_DATA_DIR", options.hayhashvapahDataDir || "/opt/a1/product-data/hayhashvapah"),
    line("A1_HAYHASHVAPAH_SUITE_DATA_DIR", options.hayhashvapahSuiteDataDir || "/opt/a1/product-data/hayhashvapah-suite")
  ];
}

function crmEnv(tenant, options = {}) {
  const databaseUrl = options.redact ? redactUrl(tenant.databaseUrl) : tenant.databaseUrl;
  return [
    ...commonPlatformEnv(options),
    line("A1_CRM_STORAGE", "platform-postgres"),
    line("A1_CRM_DATABASE_URL", databaseUrl),
    line("A1_CRM_DATA_DIR", options.crmDataDir || "/opt/a1/product-data/crm")
  ];
}

function productEnvLines(tenant, productCode, options = {}) {
  const product = normalizeProductCode(productCode);
  if (product === "unified") throw new Error("Use product code studio, hayhashvapah, crm, or all");
  if (!tenantModuleEnabled(tenant, product)) {
    throw new Error(`${product} is not enabled for tenant ${tenant.slug}`);
  }
  if (product === "studio") return studioEnv(tenant, options);
  if (product === "hayhashvapah") return hayhashvapahEnv(tenant, options);
  return crmEnv(tenant, options);
}

function renderProductEnv(tenant, productCode, options = {}) {
  const sections = productEnvFileEntries(tenant, productCode, options)
    .map((entry) => entry.content.trimEnd());
  return `${sections.join("\n\n")}\n`;
}

function productEnvFileEntries(tenant, productCode, options = {}) {
  return productCodesFor(productCode).map((code) => ({
    productCode: code,
    filename: `${tenant.slug}.${code}.env`,
    content: [
      `# ${tenant.slug} ${code} service environment`,
      ...productEnvLines(tenant, code, options)
    ].join("\n") + "\n"
  }));
}

async function writeProductEnvFiles(tenant, productCode, outDir, options = {}) {
  if (!outDir) throw new Error("Product env output directory is required");
  const targetDir = path.resolve(outDir);
  await fsp.mkdir(targetDir, { recursive: true });
  const entries = productEnvFileEntries(tenant, productCode, options);
  const files = [];

  for (const entry of entries) {
    const target = path.join(targetDir, entry.filename);
    await fsp.writeFile(target, entry.content, { encoding: "utf8", mode: 0o600 });
    files.push({ productCode: entry.productCode, path: target });
  }

  const manifestPath = path.join(targetDir, `${tenant.slug}.manifest.json`);
  await fsp.writeFile(
    manifestPath,
    `${JSON.stringify({
      tenantSlug: tenant.slug,
      products: files.map((file) => file.productCode),
      files,
      redacted: Boolean(options.redact),
      generatedAt: new Date().toISOString()
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  return { outDir: targetDir, files, manifestPath };
}

module.exports = {
  renderProductEnv,
  productEnvFileEntries,
  productEnvLines,
  redactUrl,
  writeProductEnvFiles
};
