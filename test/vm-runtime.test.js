"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("VM runtime is exposed as first-class npm scripts", () => {
  const pkg = JSON.parse(read("package.json"));
  for (const name of ["vm:bootstrap", "vm:sync", "vm:up", "vm:migrate", "vm:health", "vm:tunnel"]) {
    assert.match(pkg.scripts[name], /^infra\/vm\/a1-vm\.sh /);
  }
});

test("VM Compose uses a real VM env file instead of the checked-in example", () => {
  const compose = read("infra/compose/compose.vm.yml");
  assert.match(compose, /env_file:\n\s+- \.env/);
  assert.doesNotMatch(compose, /\.env\.example/);
  assert.match(compose, /\/opt\/a1\/imports:\/opt\/a1\/imports:ro/);
  assert.match(compose, /\/opt\/a1\/exports:\/app\/exports/);
  assert.match(compose, /\/opt\/a1\/backups:\/app\/backups/);
});

test("VM helper supports bootstrap, tunneling, and product source copy", () => {
  const helper = read("infra/vm/a1-vm.sh");
  assert.match(helper, /bootstrap\)/);
  assert.match(helper, /tunnel\)/);
  assert.match(helper, /put <local> <dest>/);
  assert.match(helper, /prepare_runtime_dirs/);

  const copyScript = read("infra/vm/copy-product-sources.sh");
  assert.match(copyScript, /armosphera-one\.db/);
  assert.match(copyScript, /ARMOSPHERA_ONE_DATA_DIR/);
  assert.match(copyScript, /ARMOSPHERA_ONE_DB/);
  assert.match(copyScript, /A1_STUDIO_DATA_DIR/);
  assert.match(copyScript, /hayhashvapah\.sqlite/);
  assert.match(copyScript, /A1_HAYHASHVAPAH_DATA_DIR/);
  assert.match(copyScript, /put_sqlite_bundle/);
  assert.match(copyScript, /\$source-wal/);
  assert.match(copyScript, /\$source-shm/);
  assert.match(copyScript, /crm\/tenants/);
  assert.match(copyScript, /A1_CRM_REPO_DIR:-\$HOME\/dev\/A1-SMB-CRM-HY/);
  assert.match(copyScript, /A1_CRM_GENERATE_DEMO/);
  assert.match(copyScript, /generateCrmBlueprint/);
  assert.match(copyScript, /source-manifest\.json/);
  assert.match(copyScript, /format_version: "1"/);
  assert.doesNotMatch(copyScript, /\/Users\/samvelstepanyan/);
});

test("CLI exposes platform-owned route and gateway commands", () => {
  const cli = read("cli/a1.js");
  assert.match(cli, /a1 route list/);
  assert.match(cli, /a1 route set <slug> <host>/);
  assert.match(cli, /a1 gateway caddy/);
  assert.match(cli, /a1 tenant operations <slug>/);
  assert.match(cli, /a1 tenant handoff <slug>/);
  assert.match(cli, /a1 product env studio\|hayhashvapah\|crm\|all <slug> \[--out dir\]/);
  assert.match(cli, /--source-manifest <file>/);
  assert.match(cli, /importProductData/);
  assert.match(cli, /renderProductEnv/);
  assert.match(cli, /writeProductEnvFiles/);
  assert.match(cli, /writeTenantHandoff/);
  assert.match(cli, /listTenantOperations/);
  assert.match(cli, /generateCaddyfile/);
  assert.match(cli, /--report-out restore-report\.json/);

  const server = read("src/server.js");
  assert.match(server, /\/operations/);
  assert.match(server, /listTenantOperations/);

  const platformDb = read("src/platform-db/index.js");
  assert.match(platformDb, /FROM tenant_operations/);
  assert.match(platformDb, /ORDER BY started_at DESC, id DESC/);
});

test("docs define Docker Desktop as non-runtime and Docker Engine VM as supported path", () => {
  const runtimeDoc = read("docs/vm-runtime.md");
  const plan = read("docs/implementation-plan.md");
  const gatewayDoc = read("docs/gateway-routing.md");
  const backupDoc = read("docs/backup-restore.md");
  assert.match(runtimeDoc, /must not require Docker Desktop/);
  assert.match(runtimeDoc, /Ubuntu ARM64 VM[\s\S]*Docker Engine/);
  assert.match(plan, /No Docker Desktop installation is required/);
  assert.match(plan, /restore report showing/);
  assert.match(gatewayDoc, /a1 route set/);
  assert.match(gatewayDoc, /a1 gateway caddy/);
  assert.match(gatewayDoc, /tenant_routes/);
  assert.match(backupDoc, /restore-report\.json/);
});
