"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { hasSensitiveTenantAccess, tenantContextResponse } = require("../src/http-tenant-response");

test("public tenant context omits database credentials and Studio org mapping", () => {
  const tenant = tenantContextResponse({
    slug: "demo-client",
    orgId: "org-armosphera-demo",
    studioOrgId: "org-armosphera-demo",
    databaseUrl: "postgresql://a1:secret@postgres:5432/a1_tenant_demo_client",
    storagePrefix: "tenants/demo-client/"
  });

  assert.equal(tenant.slug, "demo-client");
  assert.equal(tenant.orgId, undefined);
  assert.equal(tenant.studioOrgId, undefined);
  assert.equal(tenant.databaseUrl, undefined);
});

test("platform token allows sensitive tenant context for server-to-server calls", () => {
  const env = { A1_PLATFORM_TOKEN: "platform-secret" };
  assert.equal(hasSensitiveTenantAccess({ "x-a1-platform-token": "platform-secret" }, env), true);
  assert.equal(hasSensitiveTenantAccess({ "x-a1-platform-token": "wrong" }, env), false);

  const tenant = tenantContextResponse({
    slug: "demo-client",
    orgId: "org-armosphera-demo",
    studioOrgId: "org-armosphera-demo",
    databaseUrl: "postgresql://a1:secret@postgres:5432/a1_tenant_demo_client"
  }, { includeSensitive: true });
  assert.match(tenant.databaseUrl, /^postgresql:\/\//);
  assert.equal(tenant.orgId, "org-armosphera-demo");
  assert.equal(tenant.studioOrgId, "org-armosphera-demo");
});
