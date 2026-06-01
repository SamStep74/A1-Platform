"use strict";

const path = require("node:path");
const { Pool } = require("pg");
const { getConfig, replaceDatabaseName } = require("../config");
const { applySqlDirectory } = require("../sql");
const {
  normalizeSlug,
  tenantDatabaseName,
  validateTenantDatabaseName,
  storagePrefix,
  normalizeModules,
  normalizeProductCode,
  normalizeStatus,
  defaultTenantDomain,
  stripHostPort
} = require("../naming");

const ROOT = path.resolve(__dirname, "..", "..");
const TENANT_COUNT_TABLES = Object.freeze([
  { key: "core_organizations", schema: "core", table: "organizations" },
  { key: "core_users", schema: "core", table: "users" },
  { key: "studio_sqlite_import_batches", schema: "studio", table: "sqlite_import_batches" },
  { key: "studio_legacy_rows", schema: "studio", table: "legacy_rows" },
  { key: "studio_documents", schema: "studio", table: "documents" },
  { key: "hayhashvapah_accounts", schema: "hayhashvapah", table: "accounts" },
  { key: "hayhashvapah_sessions", schema: "hayhashvapah", table: "sessions" },
  { key: "hayhashvapah_audit_log", schema: "hayhashvapah", table: "audit_log" },
  { key: "hayhashvapah_meta", schema: "hayhashvapah", table: "meta" },
  { key: "hayhashvapah_files", schema: "hayhashvapah", table: "files" },
  { key: "crm_tenant_blueprints", schema: "crm", table: "tenant_blueprints" },
  { key: "crm_records", schema: "crm", table: "records" },
  { key: "crm_files", schema: "crm", table: "files" },
  { key: "crm_audit_log", schema: "crm", table: "audit_log" },
  { key: "audit_events", schema: "audit", table: "events" }
]);

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function relationSql(schema, table) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function moduleRows(rows) {
  return rows.map((row) => ({
    code: row.module_code,
    enabled: row.enabled,
    schemaVersion: row.schema_version
  }));
}

function routeRows(rows) {
  return rows.map((row) => ({
    host: row.host,
    productCode: row.product_code,
    targetUrl: row.target_url,
    active: row.active
  }));
}

function routeRecord(row) {
  return {
    tenantId: row.tenant_id,
    slug: row.slug,
    companyName: row.company_name,
    host: row.host,
    productCode: row.product_code,
    targetUrl: row.target_url,
    active: row.active,
    deploymentTarget: row.deployment_target
  };
}

function normalizeRouteTarget(targetUrl) {
  const parsed = new URL(String(targetUrl || ""));
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported route target protocol: ${targetUrl}`);
  }
  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    throw new Error(`Route target must be an origin without path/query/hash: ${targetUrl}`);
  }
  return parsed.origin;
}

class PlatformDb {
  constructor(config = getConfig()) {
    this.config = config;
    this.registryPool = new Pool({ connectionString: config.registryUrl });
    this.adminPool = new Pool({ connectionString: config.adminUrl });
    this.tenantPools = new Map();
  }

  async close() {
    await Promise.all([...this.tenantPools.values()].map((pool) => pool.end()));
    this.tenantPools.clear();
    await this.registryPool.end();
    await this.adminPool.end();
  }

  tenantDatabaseUrl(databaseName) {
    return replaceDatabaseName(this.config.registryUrl, validateTenantDatabaseName(databaseName));
  }

  tenantPool(databaseName) {
    const safeName = validateTenantDatabaseName(databaseName);
    if (!this.tenantPools.has(safeName)) {
      this.tenantPools.set(safeName, new Pool({ connectionString: this.tenantDatabaseUrl(safeName) }));
    }
    return this.tenantPools.get(safeName);
  }

  async migrateRegistry() {
    return applySqlDirectory(this.registryPool, path.join(ROOT, "migrations", "registry"));
  }

  async runTenantMigrations(databaseName, modules = ["studio", "hayhashvapah", "crm"]) {
    const pool = this.tenantPool(databaseName);
    const moduleCodes = normalizeModules(modules);
    const dirs = ["core", "audit", ...moduleCodes].map((name) => path.join(ROOT, "migrations", name));
    const applied = [];
    for (const dir of dirs) {
      applied.push(...await applySqlDirectory(pool, dir));
    }
    return applied;
  }

  async ensureTenantDatabase(databaseName) {
    const safeName = validateTenantDatabaseName(databaseName);
    const exists = await this.adminPool.query("SELECT 1 FROM pg_database WHERE datname = $1", [safeName]);
    if (exists.rowCount > 0) return false;
    await this.adminPool.query(`CREATE DATABASE ${quoteIdentifier(safeName)}`);
    return true;
  }

  async createTenant(input) {
    const slug = normalizeSlug(input.slug);
    const modules = normalizeModules(input.modules);
    const databaseName = input.databaseName || tenantDatabaseName(slug);
    const primaryDomain = stripHostPort(input.primaryDomain || defaultTenantDomain(slug, this.config.appDomain));
    const prefix = input.storagePrefix || storagePrefix(slug);
    const appVersion = input.appVersion || this.config.appVersion;
    const deploymentTarget = input.deploymentTarget || "local";
    const companyName = input.companyName || slug;
    const routeHost = stripHostPort(input.routeHost || primaryDomain);
    const targetUrl = input.targetUrl || "http://api:4200";

    await this.migrateRegistry();
    await this.ensureTenantDatabase(databaseName);
    await this.runTenantMigrations(databaseName, modules);

    const client = await this.registryPool.connect();
    try {
      await client.query("BEGIN");
      const tenantResult = await client.query(
        `INSERT INTO tenants
          (slug, company_name, primary_domain, database_name, storage_prefix, status, deployment_target, app_version, region)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8)
         ON CONFLICT (slug) DO UPDATE SET
          company_name = EXCLUDED.company_name,
          primary_domain = EXCLUDED.primary_domain,
          database_name = EXCLUDED.database_name,
          storage_prefix = EXCLUDED.storage_prefix,
          deployment_target = EXCLUDED.deployment_target,
          app_version = EXCLUDED.app_version,
          region = EXCLUDED.region,
          updated_at = now()
         RETURNING *`,
        [slug, companyName, primaryDomain, databaseName, prefix, deploymentTarget, appVersion, input.region || "am"]
      );
      const tenant = tenantResult.rows[0];

      for (const moduleCode of modules) {
        await client.query(
          `INSERT INTO tenant_modules (tenant_id, module_code, enabled, schema_version)
           VALUES ($1, $2, true, '1')
           ON CONFLICT (tenant_id, module_code) DO UPDATE SET enabled = true`,
          [tenant.id, moduleCode]
        );
      }

      await client.query(
        `INSERT INTO tenant_routes (tenant_id, host, product_code, target_url, active)
         VALUES ($1, $2, 'unified', $3, true)
         ON CONFLICT (tenant_id, host) DO UPDATE SET target_url = EXCLUDED.target_url, active = true`,
        [tenant.id, routeHost, targetUrl]
      );
      await client.query("COMMIT");
      return this.getTenantBySlug(slug);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertTenantFromRegistry(registry) {
    const tenant = registry.tenant || registry;
    return this.createTenant({
      slug: tenant.slug,
      companyName: tenant.company_name || tenant.companyName,
      primaryDomain: tenant.primary_domain || tenant.primaryDomain,
      databaseName: tenant.database_name || tenant.databaseName,
      storagePrefix: tenant.storage_prefix || tenant.storagePrefix,
      modules: (registry.modules || tenant.modules || []).map((module) => module.module_code || module.code || module),
      deploymentTarget: tenant.deployment_target || tenant.deploymentTarget || "imported",
      appVersion: tenant.app_version || tenant.appVersion || this.config.appVersion,
      region: tenant.region || "am",
      routeHost: registry.routes?.[0]?.host || tenant.primary_domain || tenant.primaryDomain,
      targetUrl: registry.routes?.[0]?.target_url || registry.routes?.[0]?.targetUrl || "http://api:4200"
    });
  }

  async getTenantBySlug(slug) {
    const tenantResult = await this.registryPool.query("SELECT * FROM tenants WHERE slug = $1", [normalizeSlug(slug)]);
    if (tenantResult.rowCount === 0) return null;
    return this.inflateTenant(tenantResult.rows[0]);
  }

  async getTenantByHost(host) {
    const routeHost = stripHostPort(host);
    const tenantResult = await this.registryPool.query(
      `SELECT t.*
       FROM tenants t
       JOIN tenant_routes r ON r.tenant_id = t.id
       WHERE r.host = $1 AND r.active = true
       LIMIT 1`,
      [routeHost]
    );
    if (tenantResult.rowCount === 0) return null;
    return this.inflateTenant(tenantResult.rows[0], routeHost);
  }

  async listTenants() {
    const result = await this.registryPool.query("SELECT * FROM tenants ORDER BY slug");
    return Promise.all(result.rows.map((row) => this.inflateTenant(row)));
  }

  async listRoutes(options = {}) {
    const activeOnly = options.activeOnly !== false;
    const result = await this.registryPool.query(
      `SELECT
          r.tenant_id,
          t.slug,
          t.company_name,
          t.deployment_target,
          r.host,
          r.product_code,
          r.target_url,
          r.active
       FROM tenant_routes r
       JOIN tenants t ON t.id = r.tenant_id
       WHERE ($1::boolean = false OR r.active = true)
       ORDER BY r.host, r.product_code`,
      [activeOnly]
    );
    return result.rows.map(routeRecord);
  }

  async setTenantRoute(slug, input = {}) {
    const tenant = await this.getTenantBySlug(slug);
    if (!tenant) throw new Error(`Tenant not found: ${slug}`);
    const host = stripHostPort(input.host || tenant.primaryDomain);
    if (!host) throw new Error("Tenant route host is required");
    const productCode = normalizeProductCode(input.productCode || input.product_code || "unified");
    const targetUrl = normalizeRouteTarget(input.targetUrl || input.target_url || tenant.routes.find((route) => route.host === host)?.targetUrl || "http://api:4200");
    const active = input.active !== undefined ? Boolean(input.active) : true;
    await this.registryPool.query(
      `INSERT INTO tenant_routes (tenant_id, host, product_code, target_url, active)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, host) DO UPDATE SET
        product_code = EXCLUDED.product_code,
        target_url = EXCLUDED.target_url,
        active = EXCLUDED.active`,
      [tenant.id, host, productCode, targetUrl, active]
    );
    return this.getTenantBySlug(tenant.slug);
  }

  async inflateTenant(row, routeHost = "") {
    const [modules, routes] = await Promise.all([
      this.registryPool.query("SELECT * FROM tenant_modules WHERE tenant_id = $1 ORDER BY module_code", [row.id]),
      this.registryPool.query("SELECT * FROM tenant_routes WHERE tenant_id = $1 ORDER BY host", [row.id])
    ]);
    return {
      id: row.id,
      slug: row.slug,
      companyName: row.company_name,
      primaryDomain: row.primary_domain,
      databaseName: row.database_name,
      databaseUrl: this.tenantDatabaseUrl(row.database_name),
      storagePrefix: row.storage_prefix,
      status: row.status,
      deploymentTarget: row.deployment_target,
      appVersion: row.app_version,
      region: row.region,
      routeHost: routeHost || row.primary_domain,
      modules: moduleRows(modules.rows),
      routes: routeRows(routes.rows),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  async setTenantStatus(slug, status) {
    const result = await this.registryPool.query(
      "UPDATE tenants SET status = $2, updated_at = now() WHERE slug = $1 RETURNING *",
      [normalizeSlug(slug), normalizeStatus(status)]
    );
    return result.rowCount ? this.inflateTenant(result.rows[0]) : null;
  }

  async updateTenantDeployment(slug, deploymentTarget, targetUrl = "") {
    const tenant = await this.getTenantBySlug(slug);
    if (!tenant) throw new Error(`Tenant not found: ${slug}`);
    const client = await this.registryPool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "UPDATE tenants SET deployment_target = $2, updated_at = now() WHERE slug = $1 RETURNING *",
        [tenant.slug, deploymentTarget]
      );
      if (targetUrl) {
        await client.query(
          "UPDATE tenant_routes SET target_url = $2 WHERE tenant_id = $1 AND active = true",
          [tenant.id, targetUrl]
        );
      }
      await client.query("COMMIT");
      return this.inflateTenant(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordOperation(slug, operation, status, details = {}) {
    const tenant = await this.getTenantBySlug(slug);
    if (!tenant) throw new Error(`Tenant not found: ${slug}`);
    const result = await this.registryPool.query(
      `INSERT INTO tenant_operations
        (tenant_id, operation, status, source_target, destination_target, artifact_path, checksum)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        tenant.id,
        operation,
        status,
        details.sourceTarget || tenant.deploymentTarget,
        details.destinationTarget || null,
        details.artifactPath || null,
        details.checksum || null
      ]
    );
    return result.rows[0];
  }

  async finishOperation(operationId, status, details = {}) {
    const result = await this.registryPool.query(
      `UPDATE tenant_operations
       SET status = $2, artifact_path = COALESCE($3, artifact_path), checksum = COALESCE($4, checksum), finished_at = now()
       WHERE id = $1
       RETURNING *`,
      [operationId, status, details.artifactPath || null, details.checksum || null]
    );
    return result.rows[0] || null;
  }

  async tenantHealth(slug) {
    const tenant = await this.getTenantBySlug(slug);
    if (!tenant) return { ok: false, checks: [{ name: "registry", ok: false, message: "tenant not found" }] };

    const checks = [{ name: "registry", ok: true, message: "tenant registry found" }];
    try {
      const pool = this.tenantPool(tenant.databaseName);
      await pool.query("SELECT 1");
      checks.push({ name: "database", ok: true, message: "tenant database connected" });

      const schemas = await pool.query(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1::text[])",
        [["core", "studio", "hayhashvapah", "crm", "audit"]]
      );
      const found = new Set(schemas.rows.map((row) => row.schema_name));
      for (const schema of ["core", "studio", "hayhashvapah", "crm", "audit"]) {
        checks.push({ name: `schema:${schema}`, ok: found.has(schema), message: found.has(schema) ? "schema exists" : "schema missing" });
      }

      const counts = await this.tenantDataCounts(tenant);
      for (const spec of TENANT_COUNT_TABLES) {
        const count = counts[spec.key];
        checks.push({
          name: `data:${spec.schema}.${spec.table}`,
          ok: Number.isInteger(count),
          message: Number.isInteger(count) ? `${count} rows` : "table missing",
          count
        });
      }
    } catch (error) {
      checks.push({ name: "database", ok: false, message: error.message });
    }

    return { ok: checks.every((check) => check.ok), tenant, checks };
  }

  async tenantDataCounts(tenantOrSlug) {
    const tenant = typeof tenantOrSlug === "string"
      ? await this.getTenantBySlug(tenantOrSlug)
      : tenantOrSlug;
    if (!tenant) return null;

    const pool = this.tenantPool(tenant.databaseName);
    const counts = {};
    for (const spec of TENANT_COUNT_TABLES) {
      const regclass = await pool.query("SELECT to_regclass($1) AS relation", [`${spec.schema}.${spec.table}`]);
      if (!regclass.rows[0]?.relation) {
        counts[spec.key] = null;
        continue;
      }
      const result = await pool.query(`SELECT COUNT(*)::bigint AS count FROM ${relationSql(spec.schema, spec.table)}`);
      counts[spec.key] = Number(result.rows[0]?.count || 0);
    }
    return counts;
  }

  async health() {
    await this.registryPool.query("SELECT 1");
    return { ok: true, registry: "connected" };
  }
}

module.exports = { PlatformDb, quoteIdentifier };
