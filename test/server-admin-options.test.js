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

test("bodyBoolean accepts camelCase, snake_case, and false strings", () => {
  assert.equal(bodyBoolean({ requireProductImports: true }, "requireProductImports", "require_product_imports"), true);
  assert.equal(bodyBoolean({ require_product_imports: "true" }, "requireProductImports", "require_product_imports"), true);
  assert.equal(bodyBoolean({ require_product_imports: "false" }, "requireProductImports", "require_product_imports"), false);
  assert.equal(bodyBoolean({}, "requireProductImports", "require_product_imports"), false);
  assert.equal(bodyBoolean(null, "requireProductImports", "require_product_imports"), false);
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
