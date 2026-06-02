"use strict";

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyChecksums, writeChecksums } = require("../src/checksums");
const { verifyTenantHandoff, writeTenantHandoff } = require("../src/tenant-handoff");

function tenant() {
  return {
    id: "tenant-1",
    slug: "demo-client",
    companyName: "Demo Client LLC",
    primaryDomain: "demo-client.a1suite.am",
    studioOrgId: "org-armosphera-demo",
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
  assert.equal(tenantJson.studioOrgId, "org-armosphera-demo");

  const caddyfile = await fsp.readFile(path.join(result.outDir, "Caddyfile"), "utf8");
  assert.match(caddyfile, /email admin@a1suite\.am/);
  assert.match(caddyfile, /demo-client\.a1suite\.am/);
  assert.match(caddyfile, /reverse_proxy http:\/\/10\.10\.5\.40:4200/);

  const crmEnv = await fsp.readFile(path.join(result.outDir, "product-env", "demo-client.crm.env"), "utf8");
  assert.match(crmEnv, /A1_CRM_STORAGE=platform-postgres/);
  assert.match(crmEnv, /A1_PLATFORM_TOKEN=REDACTED/);
  assert.match(crmEnv, /A1_CRM_DATABASE_URL=postgresql:\/\/a1:REDACTED@postgres:5432\/a1_tenant_demo_client/);

  const hayhashvapahEnv = await fsp.readFile(path.join(result.outDir, "product-env", "demo-client.hayhashvapah.env"), "utf8");
  assert.match(hayhashvapahEnv, /A1_HAYHASHVAPAH_STORAGE=platform-postgres/);
  assert.match(hayhashvapahEnv, /A1_HAYHASHVAPAH_DATABASE_URL=postgresql:\/\/a1:REDACTED@postgres:5432\/a1_tenant_demo_client/);
  assert.match(hayhashvapahEnv, /A1_HAYHASHVAPAH_TENANT_SLUG=demo-client/);

  const manifest = JSON.parse(await fsp.readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.tenantSlug, "demo-client");
  assert.equal(manifest.redacted, true);
  assert.deepEqual(manifest.routeHosts, ["demo-client.a1suite.am"]);
  assert.equal(manifest.productEnvDir, "product-env");
  assert.equal(manifest.files.every((file) => file.path && !path.isAbsolute(file.path)), true);
  assert.equal(manifest.files.some((file) => file.kind === "checksums" && file.path === "checksums.txt"), true);
  assert.equal(manifest.files.some((file) => file.kind === "handoff-manifest" && file.path === "handoff-manifest.json"), true);

  assert.equal(path.basename(result.checksumPath), "checksums.txt");
  assert.match(result.checksum, /^[a-f0-9]{64}$/);
  const checks = await verifyChecksums(result.outDir);
  assert.equal(checks.every((check) => check.ok), true);
  assert.equal(checks.some((check) => check.file === "tenant.json"), true);
  assert.equal(checks.some((check) => check.file === "product-env/demo-client.crm.env"), true);

  const productEnvManifest = JSON.parse(await fsp.readFile(path.join(result.outDir, "product-env", "demo-client.manifest.json"), "utf8"));
  assert.equal(productEnvManifest.files.every((file) => !path.isAbsolute(file.path)), true);
  assert.deepEqual(productEnvManifest.files.map((file) => file.path), [
    "demo-client.studio.env",
    "demo-client.hayhashvapah.env",
    "demo-client.crm.env"
  ]);

  const handoffCheck = await verifyTenantHandoff(result.outDir);
  assert.equal(handoffCheck.ok, true);
  assert.equal(handoffCheck.tenantSlug, "demo-client");
  assert.equal(handoffCheck.checksumFiles.some((check) => check.file === "tenant.json"), true);
  assert.ok(handoffCheck.checks.some((check) => check.name === "redaction:tenant-database-url" && check.ok));
  assert.ok(handoffCheck.checks.some((check) => check.name === "redaction:product-env:product-env/demo-client.crm.env" && check.ok));
});

test("fails handoff verification when a bundled file changes", async () => {
  const outRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "a1-tenant-handoff-tamper-"));
  const result = await writeTenantHandoff({
    platformDb: { getTenantBySlug: async () => tenant() },
    slug: "demo-client",
    outRoot,
    redact: true
  });

  await fsp.appendFile(path.join(result.outDir, "tenant.json"), "\n", "utf8");

  const failed = await verifyTenantHandoff(result.outDir);
  assert.equal(failed.ok, false);
  assert.ok(failed.checks.some((check) => check.name === "checksums" && /tenant\.json/.test(check.message)));
  assert.ok(failed.checksumFiles.some((check) => check.file === "tenant.json" && !check.ok));
});

test("rejects non-portable paths in a handoff manifest", async () => {
  const outRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "a1-tenant-handoff-path-"));
  const result = await writeTenantHandoff({
    platformDb: { getTenantBySlug: async () => tenant() },
    slug: "demo-client",
    outRoot,
    redact: true
  });

  const manifest = JSON.parse(await fsp.readFile(result.manifestPath, "utf8"));
  manifest.files.push({ kind: "outside", path: "../outside.env" });
  await fsp.writeFile(result.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const failed = await verifyTenantHandoff(result.outDir);
  assert.equal(failed.ok, false);
  assert.ok(failed.checks.some((check) => check.name === "manifest:files" && !check.ok));
  assert.ok(failed.checks.some((check) => check.name === "manifest:file:../outside.env" && !check.ok));
});

test("fails redacted handoff verification when recomputed bundle leaks secrets", async () => {
  const outRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "a1-tenant-handoff-redaction-"));
  const result = await writeTenantHandoff({
    platformDb: { getTenantBySlug: async () => tenant() },
    slug: "demo-client",
    outRoot,
    redact: true,
    platformToken: "platform-token"
  });

  const tenantPath = path.join(result.outDir, "tenant.json");
  const tenantJson = JSON.parse(await fsp.readFile(tenantPath, "utf8"));
  tenantJson.databaseUrl = "postgresql://a1:secret@postgres:5432/a1_tenant_demo_client";
  await fsp.writeFile(tenantPath, `${JSON.stringify(tenantJson, null, 2)}\n`, "utf8");

  const crmEnvPath = path.join(result.outDir, "product-env", "demo-client.crm.env");
  const crmEnv = await fsp.readFile(crmEnvPath, "utf8");
  await fsp.writeFile(
    crmEnvPath,
    crmEnv
      .replace("A1_PLATFORM_TOKEN=REDACTED", "A1_PLATFORM_TOKEN=platform-token")
      .replace(
        "A1_CRM_DATABASE_URL=postgresql://a1:REDACTED@postgres:5432/a1_tenant_demo_client",
        "A1_CRM_DATABASE_URL=postgresql://a1:secret@postgres:5432/a1_tenant_demo_client"
      ),
    "utf8"
  );
  await writeChecksums(result.outDir);

  const failed = await verifyTenantHandoff(result.outDir);
  assert.equal(failed.ok, false);
  assert.ok(failed.checks.some((check) => check.name === "checksums" && check.ok));
  assert.ok(failed.checks.some((check) => check.name === "redaction:tenant-database-url" && !check.ok));
  assert.ok(failed.checks.some((check) => (
    check.name === "redaction:product-env:product-env/demo-client.crm.env" &&
    !check.ok &&
    /A1_CRM_DATABASE_URL/.test(check.message) &&
    /A1_PLATFORM_TOKEN/.test(check.message)
  )));
});
