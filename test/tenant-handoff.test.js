"use strict";

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyChecksums } = require("../src/checksums");
const { writeTenantHandoff } = require("../src/tenant-handoff");

function tenant() {
  return {
    id: "tenant-1",
    slug: "demo-client",
    companyName: "Demo Client LLC",
    primaryDomain: "demo-client.a1suite.am",
    databaseName: "a1_tenant_demo_client",
    databaseUrl: "postgresql://a1:secret@postgres:5432/a1_tenant_demo_client",
    storagePrefix: "tenants/demo-client/",
    status: "active",
    deploymentTarget: "vm-local",
    appVersion: "2026.06.01",
    region: "am",
    modules: [
      { code: "studio", enabled: true },
      { code: "hayhashvapah", enabled: true },
      { code: "crm", enabled: true }
    ],
    routes: [{
      host: "demo-client.a1suite.am",
      productCode: "unified",
      targetUrl: "http://10.10.5.40:4200",
      active: true
    }]
  };
}

test("writes a tenant handoff bundle with product env files and route context", async () => {
  const outRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "a1-tenant-handoff-"));
  const result = await writeTenantHandoff({
    platformDb: { getTenantBySlug: async () => tenant() },
    slug: "demo-client",
    outRoot,
    redact: true,
    email: "admin@a1suite.am",
    platformToken: "platform-token"
  });

  assert.equal(path.basename(result.outDir), "demo-client");
  assert.equal(result.routes[0].host, "demo-client.a1suite.am");
  assert.ok(result.files.some((file) => file.kind === "product-env" && file.productCode === "crm"));

  const tenantJson = JSON.parse(await fsp.readFile(path.join(result.outDir, "tenant.json"), "utf8"));
  assert.equal(tenantJson.databaseUrl, "postgresql://a1:REDACTED@postgres:5432/a1_tenant_demo_client");

  const caddyfile = await fsp.readFile(path.join(result.outDir, "Caddyfile"), "utf8");
  assert.match(caddyfile, /email admin@a1suite\.am/);
  assert.match(caddyfile, /demo-client\.a1suite\.am/);
  assert.match(caddyfile, /reverse_proxy http:\/\/10\.10\.5\.40:4200/);

  const crmEnv = await fsp.readFile(path.join(result.outDir, "product-env", "demo-client.crm.env"), "utf8");
  assert.match(crmEnv, /A1_CRM_STORAGE=platform-postgres/);
  assert.match(crmEnv, /A1_PLATFORM_TOKEN=REDACTED/);
  assert.match(crmEnv, /A1_CRM_DATABASE_URL=postgresql:\/\/a1:REDACTED@postgres:5432\/a1_tenant_demo_client/);

  const manifest = JSON.parse(await fsp.readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.tenantSlug, "demo-client");
  assert.equal(manifest.redacted, true);
  assert.deepEqual(manifest.routeHosts, ["demo-client.a1suite.am"]);

  assert.equal(path.basename(result.checksumPath), "checksums.txt");
  assert.match(result.checksum, /^[a-f0-9]{64}$/);
  const checks = await verifyChecksums(result.outDir);
  assert.equal(checks.every((check) => check.ok), true);
  assert.equal(checks.some((check) => check.file === "tenant.json"), true);
  assert.equal(checks.some((check) => check.file === "product-env/demo-client.crm.env"), true);
});
