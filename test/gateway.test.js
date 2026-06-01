"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { caddyEmail, caddyHost, caddyUpstream, generateCaddyfile } = require("../src/gateway");

test("generates Caddy routes from active tenant route rows", () => {
  const caddyfile = generateCaddyfile([
    {
      slug: "demo-client",
      host: "demo-client.a1suite.am",
      productCode: "unified",
      targetUrl: "http://10.10.5.40:4200",
      deploymentTarget: "vps-01",
      active: true
    },
    {
      slug: "old-client",
      host: "old-client.a1suite.am",
      productCode: "unified",
      targetUrl: "http://10.10.5.20:4200",
      deploymentTarget: "old-vm",
      active: false
    }
  ], { email: "admin@a1suite.am" });

  assert.match(caddyfile, /email admin@a1suite\.am/);
  assert.match(caddyfile, /demo-client\.a1suite\.am \{/);
  assert.match(caddyfile, /reverse_proxy http:\/\/10\.10\.5\.40:4200/);
  assert.doesNotMatch(caddyfile, /old-client/);
});

test("rejects unsafe gateway hosts and route targets", () => {
  assert.equal(caddyHost("Demo-Client.A1Suite.AM:443"), "demo-client.a1suite.am");
  assert.equal(caddyEmail("admin@a1suite.am"), "admin@a1suite.am");
  assert.equal(caddyUpstream("https://edge.example.com:8443/"), "https://edge.example.com:8443");
  assert.throws(() => caddyHost("demo.a1suite.am\nimport evil"), /Unsafe Caddy host/);
  assert.throws(() => caddyEmail("admin@a1suite.am\nimport evil"), /Unsafe Caddy email/);
  assert.throws(() => caddyUpstream("file:///tmp/socket"), /Unsupported route target protocol/);
  assert.throws(() => caddyUpstream("http://10.10.5.40:4200/path"), /origin without path/);
});
