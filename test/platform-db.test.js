"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PlatformDb } = require("../src/platform-db");

test("lists tenant operations with camelCase fields and bounded limit", async () => {
  let capturedSql = "";
  let capturedParams = [];
  const startedAt = new Date("2026-06-01T09:00:00.000Z");
  const finishedAt = new Date("2026-06-01T09:01:00.000Z");
  const db = Object.create(PlatformDb.prototype);
  db.getTenantBySlug = async (slug) => ({ id: "tenant-1", slug });
  db.registryPool = {
    query: async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return {
        rows: [{
          id: "operation-1",
          tenant_id: "tenant-1",
          operation: "product.import.crm",
          status: "completed",
          source_target: "local",
          destination_target: null,
          artifact_path: "/opt/a1/imports/product-sources/source-manifest.json",
          checksum: "sha256:abc",
          started_at: startedAt,
          finished_at: finishedAt
        }]
      };
    }
  };

  const operations = await db.listTenantOperations("demo-client", { limit: 500 });

  assert.match(capturedSql, /FROM tenant_operations/);
  assert.match(capturedSql, /ORDER BY started_at DESC, id DESC/);
  assert.deepEqual(capturedParams, ["tenant-1", 200]);
  assert.deepEqual(operations, [{
    id: "operation-1",
    tenantId: "tenant-1",
    operation: "product.import.crm",
    status: "completed",
    sourceTarget: "local",
    destinationTarget: null,
    artifactPath: "/opt/a1/imports/product-sources/source-manifest.json",
    checksum: "sha256:abc",
    startedAt,
    finishedAt
  }]);
});

test("tenant operation listing rejects unknown tenants", async () => {
  const db = Object.create(PlatformDb.prototype);
  db.getTenantBySlug = async () => null;

  await assert.rejects(
    () => db.listTenantOperations("missing-client"),
    /Tenant not found: missing-client/
  );
});
