"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { tenantRequestHost } = require("../src/request-host");

test("tenant request host prefers explicit A1 request host over gateway host", () => {
  const host = tenantRequestHost({
    host: "127.0.0.1:8088",
    "x-a1-request-host": "demo-client.a1suite.am"
  });

  assert.equal(host, "demo-client.a1suite.am");
});

test("tenant request host supports proxy forwarded host and direct host fallback", () => {
  assert.equal(tenantRequestHost({
    host: "platform.internal",
    "x-forwarded-host": "demo-client.a1suite.am, platform.internal"
  }), "demo-client.a1suite.am");

  assert.equal(tenantRequestHost({ host: "direct-client.a1suite.am:443" }), "direct-client.a1suite.am:443");
});
