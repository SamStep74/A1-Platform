"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveTenantContext, TenantAccessError } = require("../src/tenant-context");

function tenant(overrides = {}) {
  return {
    id: "tenant-1",
    slug: "demo",
    companyName: "Demo LLC",
    status: "active",
    modules: [
      { code: "studio", enabled: true },
      { code: "hayhashvapah", enabled: true },
      { code: "crm", enabled: false }
    ],
    databaseUrl: "postgresql://example/a1_tenant_demo",
    storagePrefix: "tenants/demo/",
    ...overrides
  };
}

test("resolves tenant context by route host and product module", async () => {
  const registry = { getTenantByHost: async (host) => host === "demo.a1suite.am" ? tenant() : null };
  const context = await resolveTenantContext({ registry, host: "demo.a1suite.am:443", productCode: "studio" });
  assert.equal(context.slug, "demo");
  assert.equal(context.productCode, "studio");
  assert.equal(context.routeHost, "demo.a1suite.am");
});

test("blocks missing tenants and disabled modules", async () => {
  await assert.rejects(
    resolveTenantContext({ registry: { getTenantByHost: async () => null }, host: "missing.a1suite.am" }),
    (error) => error instanceof TenantAccessError && error.statusCode === 404
  );

  await assert.rejects(
    resolveTenantContext({ registry: { getTenantByHost: async () => tenant() }, host: "demo.a1suite.am", productCode: "crm" }),
    (error) => error instanceof TenantAccessError && error.code === "MODULE_DISABLED"
  );
});

test("blocks maintenance tenants before product code touches data", async () => {
  await assert.rejects(
    resolveTenantContext({
      registry: { getTenantByHost: async () => tenant({ status: "maintenance" }) },
      host: "demo.a1suite.am",
      productCode: "studio"
    }),
    (error) => error instanceof TenantAccessError && error.statusCode === 503
  );
});
