"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer, bodyBoolean, platformDb } = require("../src/server");

test.after(async () => {
  await platformDb.close();
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function withServer(deps, fn) {
  const server = createServer(deps);
  const baseUrl = await listen(server);
  try {
    return await fn(baseUrl);
  } finally {
    await close(server);
  }
}

async function postJson(baseUrl, path, body) {
  const headers = { "content-type": "application/json" };
  const adminToken = process.env.ADMIN_TOKEN || process.env.A1_ADMIN_TOKEN || "";
  if (adminToken) headers["x-a1-admin-token"] = adminToken;
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  return { response, payload: await response.json() };
}

async function postRawJson(baseUrl, path, rawBody) {
  const headers = { "content-type": "application/json" };
  const adminToken = process.env.ADMIN_TOKEN || process.env.A1_ADMIN_TOKEN || "";
  if (adminToken) headers["x-a1-admin-token"] = adminToken;
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: rawBody
  });
  return { response, payload: await response.json() };
}

async function getJson(baseUrl, path, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  return { response, payload: await response.json() };
}

test("production admin API fails closed when admin token is missing", async () => {
  const previousAdminToken = process.env.ADMIN_TOKEN;
  const previousA1AdminToken = process.env.A1_ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  delete process.env.A1_ADMIN_TOKEN;

  const calls = [];
  const deps = {
    config: { appVersion: "test", appEnv: "production" },
    platformDb: {
      createTenant: async (input) => {
        calls.push(input);
        return { slug: input.slug };
      }
    },
    storage: {}
  };

  try {
    await withServer(deps, async (baseUrl) => {
      const result = await postJson(baseUrl, "/api/admin/tenants", {
        slug: "demo-client",
        company_name: "Demo Client LLC",
        primary_domain: "demo-client.a1suite.am",
        modules: ["studio"],
        deployment_target: "vm-local",
        target_url: "http://api:4200"
      });
      assert.equal(result.response.status, 503);
      assert.equal(result.payload.error.code, "ADMIN_AUTH_UNCONFIGURED");
      assert.equal(result.payload.error.message, "Admin token is not configured");
    });
  } finally {
    if (previousAdminToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = previousAdminToken;
    if (previousA1AdminToken === undefined) delete process.env.A1_ADMIN_TOKEN;
    else process.env.A1_ADMIN_TOKEN = previousA1AdminToken;
  }

  assert.deepEqual(calls, []);
});

test("admin tenant create rejects non-object JSON bodies", async () => {
  const calls = [];
  const deps = {
    config: { appVersion: "test" },
    platformDb: {
      createTenant: async (input) => {
        calls.push(input);
        return { slug: input.slug };
      }
    },
    storage: {}
  };

  await withServer(deps, async (baseUrl) => {
    const result = await postRawJson(baseUrl, "/api/admin/tenants", "null");
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error.code, "BAD_JSON_BODY");
    assert.equal(result.payload.error.message, "JSON body must be an object");
  });

  assert.deepEqual(calls, []);
});

test("admin tenant create rejects invalid slug input as a client error", async () => {
  const calls = [];
  const deps = {
    config: { appVersion: "test" },
    platformDb: {
      createTenant: async (input) => {
        calls.push(input);
        return { slug: input.slug };
      }
    },
    storage: {}
  };

  await withServer(deps, async (baseUrl) => {
    const result = await postJson(baseUrl, "/api/admin/tenants", {
      slug: "",
      company_name: "Demo Client LLC"
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error.code, "INVALID_TENANT_SLUG");
    assert.equal(result.payload.error.message, "Tenant slug is required");
  });

  assert.deepEqual(calls, []);
});

test("bodyBoolean accepts camelCase, snake_case, and false strings", () => {
  assert.equal(bodyBoolean({ requireProductImports: true }, "requireProductImports", "require_product_imports"), true);
  assert.equal(bodyBoolean({ require_product_imports: "true" }, "requireProductImports", "require_product_imports"), true);
  assert.equal(bodyBoolean({ require_product_imports: "false" }, "requireProductImports", "require_product_imports"), false);
  assert.equal(bodyBoolean({}, "requireProductImports", "require_product_imports"), false);
  assert.equal(bodyBoolean(null, "requireProductImports", "require_product_imports"), false);
  assert.throws(
    () => bodyBoolean({ requireProductImports: "maybe" }, "requireProductImports", "require_product_imports"),
    /requireProductImports must be a boolean/
  );
  assert.throws(
    () => bodyBoolean({ requireProductImports: { enabled: true } }, "requireProductImports", "require_product_imports"),
    /requireProductImports must be a boolean/
  );
});

test("admin tenant export parses false keepMaintenance string without keeping maintenance", async () => {
  const calls = [];
  const deps = {
    config: { appVersion: "test" },
    platformDb: {},
    storage: {},
    exportTenantFn: async (input) => {
      calls.push(input);
      return { outputDir: "/tmp/export", checksum: "sha256:test" };
    }
  };

  await withServer(deps, async (baseUrl) => {
    const result = await postJson(baseUrl, "/api/admin/tenants/demo-client/export", {
      keepMaintenance: "false",
      require_product_imports: "true"
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.ok, true);
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].slug, "demo-client");
  assert.equal(calls[0].keepMaintenance, false);
  assert.equal(calls[0].requireProductImports, true);
});

test("admin tenant import parses false activate string without activating tenant", async () => {
  const calls = [];
  const deps = {
    config: { appVersion: "test" },
    platformDb: {},
    storage: {},
    importTenantFn: async (input) => {
      calls.push(input);
      return { tenant: { slug: input.slug }, restoredFiles: [] };
    }
  };

  await withServer(deps, async (baseUrl) => {
    const result = await postJson(baseUrl, "/api/admin/tenants/demo-client/import", {
      importDir: "/tmp/import",
      activate: "false"
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.ok, true);
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].slug, "demo-client");
  assert.equal(calls[0].activate, false);
});

test("admin tenant check rejects unknown requireProductImports strings before transfer checks", async () => {
  const calls = [];
  const deps = {
    config: { appVersion: "test" },
    platformDb: {},
    storage: {},
    checkTenantFn: async (input) => {
      calls.push(input);
      return { ok: true };
    }
  };

  await withServer(deps, async (baseUrl) => {
    const result = await postJson(baseUrl, "/api/admin/tenants/demo-client/check", {
      requireProductImports: "maybe"
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error.code, "BAD_BOOLEAN");
    assert.equal(result.payload.error.message, "requireProductImports must be a boolean");
  });

  assert.deepEqual(calls, []);
});

test("admin tenant maintenance parses false string without enabling maintenance", async () => {
  const calls = [];
  const deps = {
    config: { appVersion: "test" },
    platformDb: {
      setTenantStatus: async (slug, status) => {
        calls.push({ slug, status });
        return { slug, status };
      }
    },
    storage: {}
  };

  await withServer(deps, async (baseUrl) => {
    const result = await postJson(baseUrl, "/api/admin/tenants/demo-client/maintenance", {
      enabled: "false"
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload.tenant, {
      slug: "demo-client",
      status: "active"
    });
  });

  assert.deepEqual(calls, [{ slug: "demo-client", status: "active" }]);
});

test("admin tenant maintenance defaults to enabling maintenance", async () => {
  const calls = [];
  const deps = {
    config: { appVersion: "test" },
    platformDb: {
      setTenantStatus: async (slug, status) => {
        calls.push({ slug, status });
        return { slug, status };
      }
    },
    storage: {}
  };

  await withServer(deps, async (baseUrl) => {
    const result = await postJson(baseUrl, "/api/admin/tenants/demo-client/maintenance", {});
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload.tenant, {
      slug: "demo-client",
      status: "maintenance"
    });
  });

  assert.deepEqual(calls, [{ slug: "demo-client", status: "maintenance" }]);
});

test("admin tenant maintenance rejects unknown enabled strings before mutation", async () => {
  const calls = [];
  const deps = {
    config: { appVersion: "test" },
    platformDb: {
      setTenantStatus: async (slug, status) => {
        calls.push({ slug, status });
        return { slug, status };
      }
    },
    storage: {}
  };

  await withServer(deps, async (baseUrl) => {
    const result = await postJson(baseUrl, "/api/admin/tenants/demo-client/maintenance", {
      enabled: "maybe"
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error.code, "BAD_BOOLEAN");
    assert.equal(result.payload.error.message, "enabled must be a boolean");
  });

  assert.deepEqual(calls, []);
});

test("admin tenant maintenance validates mode even when enabled is present", async () => {
  const calls = [];
  const deps = {
    config: { appVersion: "test" },
    platformDb: {
      setTenantStatus: async (slug, status) => {
        calls.push({ slug, status });
        return { slug, status };
      }
    },
    storage: {}
  };

  await withServer(deps, async (baseUrl) => {
    const result = await postJson(baseUrl, "/api/admin/tenants/demo-client/maintenance", {
      enabled: true,
      mode: "maybe"
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error.code, "BAD_BOOLEAN");
    assert.equal(result.payload.error.message, "mode must be a boolean");
  });

  assert.deepEqual(calls, []);
});

test("admin tenant maintenance rejects unknown mode strings before mutation", async () => {
  const calls = [];
  const deps = {
    config: { appVersion: "test" },
    platformDb: {
      setTenantStatus: async (slug, status) => {
        calls.push({ slug, status });
        return { slug, status };
      }
    },
    storage: {}
  };

  await withServer(deps, async (baseUrl) => {
    const result = await postJson(baseUrl, "/api/admin/tenants/demo-client/maintenance", {
      mode: "maybe"
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error.code, "BAD_BOOLEAN");
    assert.equal(result.payload.error.message, "mode must be a boolean");
  });

  assert.deepEqual(calls, []);
});

test("admin tenant maintenance preserves mode off compatibility", async () => {
  const calls = [];
  const deps = {
    config: { appVersion: "test" },
    platformDb: {
      setTenantStatus: async (slug, status) => {
        calls.push({ slug, status });
        return { slug, status };
      }
    },
    storage: {}
  };

  await withServer(deps, async (baseUrl) => {
    const result = await postJson(baseUrl, "/api/admin/tenants/demo-client/maintenance", {
      mode: "off"
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload.tenant, {
      slug: "demo-client",
      status: "active"
    });
  });

  assert.deepEqual(calls, [{ slug: "demo-client", status: "active" }]);
});

test("current tenant route hides Studio org mapping unless platform token is provided", async () => {
  const previousToken = process.env.A1_PLATFORM_TOKEN;
  process.env.A1_PLATFORM_TOKEN = "platform-secret";
  const seenHosts = [];
  const deps = {
    config: { appVersion: "test" },
    platformDb: {
      getTenantByHost: async (host) => {
        seenHosts.push(host);
        if (host !== "demo-client.a1suite.am") return null;
        return {
          id: "tenant-1",
          slug: "demo-client",
          companyName: "Demo Client LLC",
          status: "active",
          modules: [{ code: "studio", enabled: true }],
          studioOrgId: "org-armosphera-demo",
          databaseUrl: "postgresql://a1:secret@postgres:5432/a1_tenant_demo_client",
          storagePrefix: "tenants/demo-client/"
        };
      }
    },
    storage: {}
  };

  try {
    await withServer(deps, async (baseUrl) => {
      const publicResult = await getJson(baseUrl, "/api/tenants/current?product=studio", {
        host: "gateway.local",
        "x-a1-request-host": "demo-client.a1suite.am"
      });
      assert.equal(publicResult.response.status, 200);
      assert.equal(publicResult.payload.tenant.slug, "demo-client");
      assert.equal(publicResult.payload.tenant.databaseUrl, undefined);
      assert.equal(publicResult.payload.tenant.orgId, undefined);
      assert.equal(publicResult.payload.tenant.studioOrgId, undefined);

      const sensitiveResult = await getJson(baseUrl, "/api/tenants/current?product=studio", {
        host: "gateway.local",
        "x-a1-request-host": "demo-client.a1suite.am",
        "x-a1-platform-token": "platform-secret"
      });
      assert.equal(sensitiveResult.response.status, 200);
      assert.equal(sensitiveResult.payload.tenant.databaseUrl, "postgresql://a1:secret@postgres:5432/a1_tenant_demo_client");
      assert.equal(sensitiveResult.payload.tenant.orgId, "org-armosphera-demo");
      assert.equal(sensitiveResult.payload.tenant.studioOrgId, "org-armosphera-demo");

      const legacyResult = await getJson(baseUrl, "/api/platform/tenants/current?product=studio", {
        host: "gateway.local",
        "x-a1-request-host": "demo-client.a1suite.am"
      });
      assert.equal(legacyResult.response.status, 200);
      assert.equal(legacyResult.payload.tenant.slug, "demo-client");
    });
  } finally {
    if (previousToken === undefined) delete process.env.A1_PLATFORM_TOKEN;
    else process.env.A1_PLATFORM_TOKEN = previousToken;
  }

  assert.deepEqual(seenHosts, [
    "demo-client.a1suite.am",
    "demo-client.a1suite.am",
    "demo-client.a1suite.am"
  ]);
});

test("admin tenant create forwards Studio organization mapping", async () => {
  const calls = [];
  const deps = {
    config: { appVersion: "test" },
    platformDb: {
      createTenant: async (input) => {
        calls.push(input);
        return { slug: input.slug, studioOrgId: input.studioOrgId };
      }
    },
    storage: {}
  };

  await withServer(deps, async (baseUrl) => {
    const result = await postJson(baseUrl, "/api/admin/tenants", {
      slug: "demo-client",
      company_name: "Demo Client LLC",
      primary_domain: "demo-client.a1suite.am",
      studio_org_id: "org-armosphera-demo",
      modules: ["studio", "crm"],
      deployment_target: "vm-local",
      target_url: "http://api:4200"
    });
    assert.equal(result.response.status, 201);
    assert.equal(result.payload.tenant.studioOrgId, "org-armosphera-demo");
  });

  assert.deepEqual(calls[0], {
    slug: "demo-client",
    companyName: "Demo Client LLC",
    primaryDomain: "demo-client.a1suite.am",
    studioOrgId: "org-armosphera-demo",
    modules: ["studio", "crm"],
    deploymentTarget: "vm-local",
    targetUrl: "http://api:4200"
  });
});

test("admin tenant studio org id endpoint updates existing tenant mapping", async () => {
  const calls = [];
  const deps = {
    config: { appVersion: "test" },
    platformDb: {
      setTenantStudioOrgId: async (slug, studioOrgId) => {
        calls.push({ slug, studioOrgId });
        return { slug, studioOrgId };
      }
    },
    storage: {}
  };

  await withServer(deps, async (baseUrl) => {
    const result = await postJson(baseUrl, "/api/admin/tenants/demo-client/studio-org-id", {
      studio_org_id: "org-armosphera-demo"
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.ok, true);
    assert.deepEqual(result.payload.tenant, {
      slug: "demo-client",
      studioOrgId: "org-armosphera-demo"
    });
  });

  assert.deepEqual(calls, [{ slug: "demo-client", studioOrgId: "org-armosphera-demo" }]);
});

test("admin transfer endpoints forward product import guard option", async () => {
  const calls = [];
  const deps = {
    config: { appVersion: "test" },
    platformDb: {},
    storage: { kind: "fake-storage" },
    exportTenantFn: async (options) => {
      calls.push({ operation: "export", options });
      return { outputDir: "exports/demo-client", checksum: "export-checksum" };
    },
    importTenantFn: async (options) => {
      calls.push({ operation: "import", options });
      return { tenant: { slug: options.slug }, restoredFiles: 0 };
    },
    checkTenantFn: async (options) => {
      calls.push({ operation: "check", options });
      return { ok: true, checks: [] };
    },
    moveTenantFn: async (options) => {
      calls.push({ operation: "move", options });
      return { tenant: { slug: options.slug }, exportDir: "exports/demo-client", checksum: "move-checksum" };
    }
  };

  await withServer(deps, async (baseUrl) => {
    const exportResult = await postJson(baseUrl, "/api/admin/tenants/demo-client/export", {
      require_product_imports: true
    });
    assert.equal(exportResult.response.status, 200);
    assert.equal(exportResult.payload.checksum, "export-checksum");

    const importResult = await postJson(baseUrl, "/api/admin/tenants/demo-client/import", {
      importDir: "/opt/a1/imports/demo-client",
      require_product_imports: true
    });
    assert.equal(importResult.response.status, 200);
    assert.equal(importResult.payload.restoredFiles, 0);

    const checkResult = await postJson(baseUrl, "/api/admin/tenants/demo-client/check", {
      requireProductImports: true
    });
    assert.equal(checkResult.response.status, 200);
    assert.equal(checkResult.payload.ok, true);

    const moveResult = await postJson(baseUrl, "/api/admin/tenants/demo-client/move", {
      target: "vps-01",
      target_url: "http://10.10.5.40:4200",
      target_check_url: "http://10.10.5.40:4200/api/platform/health",
      post_switch_check_url: "https://demo-client.a1suite.am/api/platform/health",
      require_product_imports: "true"
    });
    assert.equal(moveResult.response.status, 200);
    assert.equal(moveResult.payload.tenant.slug, "demo-client");
  });

  assert.deepEqual(
    calls.map((call) => ({
      operation: call.operation,
      slug: call.options.slug,
      requireProductImports: call.options.requireProductImports
    })),
    [
      { operation: "export", slug: "demo-client", requireProductImports: true },
      { operation: "import", slug: "demo-client", requireProductImports: true },
      { operation: "check", slug: "demo-client", requireProductImports: true },
      { operation: "move", slug: "demo-client", requireProductImports: true }
    ]
  );
  assert.equal(calls[1].options.importDir, "/opt/a1/imports/demo-client");
  assert.equal(calls[3].options.targetUrl, "http://10.10.5.40:4200");
  assert.equal(calls[3].options.targetCheckUrl, "http://10.10.5.40:4200/api/platform/health");
  assert.equal(calls[3].options.postSwitchCheckUrl, "https://demo-client.a1suite.am/api/platform/health");
});

test("admin API returns controlled preflight failure details", async () => {
  const deps = {
    config: { appVersion: "test" },
    platformDb: {},
    storage: {},
    exportTenantFn: async () => {
      throw Object.assign(new Error("Tenant export preflight failed: operation:product.import.studio"), {
        code: "TENANT_PREFLIGHT_FAILED",
        statusCode: 409,
        failedChecks: [{
          name: "operation:product.import.studio",
          ok: false,
          message: "completed product import operation missing"
        }]
      });
    }
  };

  await withServer(deps, async (baseUrl) => {
    const result = await postJson(baseUrl, "/api/admin/tenants/demo-client/export", {
      requireProductImports: true
    });
    assert.equal(result.response.status, 409);
    assert.equal(result.payload.error.code, "TENANT_PREFLIGHT_FAILED");
    assert.match(result.payload.error.message, /Tenant export preflight failed/);
    assert.deepEqual(result.payload.error.failedChecks, [{
      name: "operation:product.import.studio",
      ok: false,
      message: "completed product import operation missing"
    }]);
  });
});
