# A1 Platform

Transferable tenant database foundation for A1 Studio, A1 HayHashvapah, and A1 CRM.

This repo owns the shared platform layer:

- central tenant registry (`a1_registry`)
- one PostgreSQL database per tenant (`a1_tenant_<slug>`)
- product schemas inside each tenant database (`core`, `studio`, `hayhashvapah`, `crm`, `audit`)
- S3-compatible tenant file storage
- CLI/API tenant create, maintenance, export, import, check, move, backup, and restore
- VM-first Compose runtime for Linux hosts without Docker Desktop

## Runtime Decision

Client and production deployments must not depend on Docker Desktop. The supported Option A runtime is:

```text
Mac Studio or operator laptop
  -> Ubuntu ARM64 VM over SSH
    -> Docker Engine
      -> A1 Platform containers
```

Compose is still used, but it runs inside Linux. The Mac host only syncs code, opens SSH tunnels, and runs helper commands.

See [docs/vm-runtime.md](docs/vm-runtime.md) and [docs/implementation-plan.md](docs/implementation-plan.md).

## VM Runtime

```bash
cd /Users/samvelstepanyan/dev/A1-Platform
npm install
export A1_VM_HOST="ubuntu@192.168.64.10"
# Don't leave angle brackets in placeholders (for example <vm-ip>), they are shell redirection.
npm run vm:bootstrap
```

For the local Lima VM created on the Mac, use:

```bash
export A1_LIMA_INSTANCE=a1-platform
```

Open an SSH tunnel from the Mac:

```bash
npm run vm:tunnel
```

Then the gateway is available on the Mac at:

```text
http://127.0.0.1:8088
```

For repo-local tests only, `infra/compose/compose.local.yml` can still be used on a Linux host. Do not require Docker Desktop for client machines.

## CLI

```bash
infra/vm/a1-vm.sh a1 tenant create demo-client --modules studio,hayhashvapah,crm --studio-org-id org-armosphera-demo
infra/vm/a1-vm.sh a1 tenant check demo-client
infra/vm/a1-vm.sh a1 tenant set-studio-org-id demo-client org-armosphera-demo
infra/vm/a1-vm.sh a1 tenant operations demo-client --limit 20
infra/vm/a1-vm.sh a1 tenant export demo-client --require-product-imports
infra/vm/a1-vm.sh a1 tenant handoff demo-client --out /app/exports/handoff --redact
infra/vm/a1-vm.sh a1 tenant handoff-check /app/exports/handoff/demo-client
infra/vm/a1-vm.sh a1 tenant import demo-client /app/exports/demo-client --activate --require-product-imports
infra/vm/a1-vm.sh a1 tenant move demo-client --target vps-01 --target-url http://10.10.5.40:4200 --target-check-url http://10.10.5.40:4200/api/platform/health --post-switch-check-url https://demo-client.a1suite.am/api/platform/health --require-product-imports
infra/vm/a1-vm.sh a1 route set demo-client demo-client.a1suite.am --target-url http://10.10.5.40:4200
infra/vm/a1-vm.sh a1 gateway caddy --out /app/exports/Caddyfile.generated --email admin@a1suite.am
infra/vm/a1-vm.sh a1 product env all demo-client --redact
infra/vm/a1-vm.sh a1 product env all demo-client --out /app/exports/product-env/demo-client
infra/vm/a1-vm.sh a1 product import-check demo-client --source-root /opt/a1/imports/product-sources --source-manifest /opt/a1/imports/product-sources/source-manifest.json
infra/vm/a1-vm.sh a1 product import all demo-client --source-root /opt/a1/imports/product-sources --source-manifest /opt/a1/imports/product-sources/source-manifest.json
infra/vm/a1-vm.sh a1 tenant check demo-client --require-product-imports
infra/vm/a1-vm.sh a1 backup full --require-product-imports
infra/vm/a1-vm.sh a1 restore full /opt/a1/backups/full/latest --report-out /app/exports/restore-report.json --require-product-imports
infra/vm/a1-vm.sh a1 product import crm demo-client --blueprint /opt/a1/imports/product-sources/crm/tenants/demo-client.json --records /opt/a1/imports/product-sources/crm/records/demo-client.json --source-manifest /opt/a1/imports/product-sources/source-manifest.json
infra/vm/a1-vm.sh a1 product import hayhashvapah demo-client --sqlite /opt/a1/imports/product-sources/hayhashvapah/hayhashvapah.sqlite --source-manifest /opt/a1/imports/product-sources/source-manifest.json
infra/vm/a1-vm.sh a1 product import studio demo-client --sqlite /opt/a1/imports/product-sources/studio/armosphera-one.db --source-manifest /opt/a1/imports/product-sources/source-manifest.json
```

To copy current Mac product source files into the Ubuntu VM for import:

```bash
npm run vm:copy-product-sources -- demo-client
```

## HTTP API

```text
GET  /api/platform/health
GET  /api/tenants/current
POST /api/admin/tenants
POST /api/admin/tenants/:slug/maintenance
POST /api/admin/tenants/:slug/export
POST /api/admin/tenants/:slug/import
POST /api/admin/tenants/:slug/check
POST /api/admin/tenants/:slug/studio-org-id
GET  /api/admin/tenants/:slug/operations
POST /api/admin/tenants/:slug/move
```

For admin `export`, `import`, `check`, and `move`, send `requireProductImports` or
`require_product_imports` in the JSON body to enforce completed
`product.import.*` audit rows for all enabled product modules. A failed guarded
transfer returns HTTP `409` with `TENANT_PREFLIGHT_FAILED` and `failedChecks`.
For admin `move`, send `targetUrl`/`target_url`, `targetCheckUrl`/`target_check_url`,
and `postSwitchCheckUrl`/`post_switch_check_url` to match the CLI route-switch
health checks.

Set `ADMIN_TOKEN` or `A1_ADMIN_TOKEN` and send it as `x-a1-admin-token` on admin routes.
In `APP_ENV=production`, admin routes fail closed with `ADMIN_AUTH_UNCONFIGURED`
when no admin token is configured. Development keeps token auth optional for
local drills only.
`GET /api/tenants/current` is safe for public route lookup by default and omits `databaseUrl` plus Studio org mapping fields; server-to-server callers that need the tenant database URL or Studio `orgId` must send `x-a1-platform-token` matching `A1_PLATFORM_TOKEN` or `x-a1-admin-token` matching the admin token. When a tenant is bound to the current A1 Studio SQLite organization, the token-authenticated response includes `orgId` so Studio can fail closed for unmapped or cross-host sessions.
Products behind a VM tunnel or gateway should send the browser/request tenant host in `x-a1-request-host`; Platform falls back to `x-forwarded-host` and then `Host` for direct calls.

## Transfer Unit

Tenant exports are created as:

```text
/app/exports/<slug>/ inside the API container
/opt/a1/exports/<slug>/ on the VM host
  metadata.json
  registry.json
  db.dump
  files/
  checksums.txt
```

That bundle is the portable unit for moving one client between an Ubuntu VM on Mac Studio, VPS, cloud VM, or dedicated client hardware.
Guarded exports include completed `product.import.*` operation evidence in
`registry.json`; imports replay that evidence into the target registry.

## Product Migration Boundary

This foundation does not rewrite all three product repos in one unsafe pass. It creates the shared contracts and landing schemas they should migrate onto:

- A1 Studio: move identity/org/session/docs data from SQLite into `core` and `studio`.
- A1 HayHashvapah: move account/session/audit JSON documents from SQLite into `hayhashvapah`.
- A1 CRM: move tenant blueprints and records from JSON files into `crm`.
- Import commands are available now through `a1 product import ...`; product app code migration is the next slice.

See [docs/product-migration.md](docs/product-migration.md).

Gateway route updates are registry-driven through `a1 route ...` and `a1 gateway caddy`; see [docs/gateway-routing.md](docs/gateway-routing.md).
