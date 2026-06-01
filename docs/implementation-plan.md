# A1 Transferable Tenant Database Implementation Plan

## Runtime Update

The platform implementation uses Option A:

```text
Ubuntu ARM64 VM -> Docker Engine -> A1 Platform containers
```

Docker Desktop is not part of the production or client deployment plan. The Mac Studio can host the Ubuntu VM, but the containers run inside Linux with Docker Engine or a compatible Linux container runtime. This avoids a per-client Docker Desktop licensing dependency while preserving tenant portability.

## Architecture

- Shared repo: `/Users/samvelstepanyan/dev/A1-Platform`
- Local/private runtime: Ubuntu ARM64 VM on Mac Studio or a Linux VPS
- Container runtime: Docker Engine first, Podman/containerd later if needed
- Database: PostgreSQL 16
- Isolation: one PostgreSQL database per tenant, schemas per product
- Registry: central `a1_registry` database
- Files: S3-compatible object storage, MinIO locally, R2/S3/Wasabi/B2 in production
- Routing: Cloudflare DNS to VPS/gateway, then WireGuard/Tailscale/Cloudflare Tunnel to the active VM/host
- Transfer unit: `metadata.json + registry.json + db.dump + files/ + checksums.txt`

## Public Contracts

Tenant registry:

```text
tenants
tenant_modules
tenant_routes
tenant_operations
```

Tenant database:

```text
a1_tenant_<slug>
  core.*
  studio.*
  hayhashvapah.*
  crm.*
  audit.*
```

Tenant context:

```js
{
  id,
  slug,
  companyName,
  status,
  modules,
  storagePrefix,
  productCode,
  routeHost
}
```

`databaseUrl` is sensitive. The public tenant context endpoint omits it by default. Server-to-server callers must send the platform token to receive it.

## Implemented Foundation

- Docker/Compose runtime files for local test, VM runtime, and production examples
- Ubuntu VM Docker Engine installer
- Host-side VM helper script for sync, bootstrap, Compose, tunnel, and CLI commands
- Registry migrations
- Tenant schema migrations for `core`, `audit`, `studio`, `hayhashvapah`, and `crm`
- Registry/data access package
- Tenant context package
- S3/MinIO storage package
- Tenant export/import/check/move operations
- Full backup/restore commands
- Product importers:
  - A1 Studio SQLite to `studio.sqlite_import_batches` and `studio.legacy_rows`
  - A1 HayHashvapah SQLite to `hayhashvapah.*`
  - A1 CRM JSON to `crm.tenant_blueprints` and `crm.records`
- Product adapters in A1 Studio, A1 HayHashvapah, and A1 CRM for opt-in platform tenant resolution

## Migration Order

1. A1 Studio remains canonical identity and tenant control.
2. A1 HayHashvapah accepts platform SSO/context and moves production data to tenant Postgres/S3.
3. A1 CRM resolves tenant through platform registry and moves JSON storage to tenant Postgres/S3.
4. Tenant export/import/check/move becomes the standard client transfer workflow.
5. Gateway and backup runbooks assume Linux VM/VPS hosts, not Docker Desktop.

## Test Plan

Automated tests:

- Registry create, duplicate rejection, status transition, route lookup
- Tenant context host resolution, unknown host 404, maintenance blocking
- Storage tenant-prefix enforcement
- Product import fixtures for SQLite/JSON landing tables
- Export/import bundle checksums
- Move route rollback behavior
- Sensitive tenant context redaction

Manual VM acceptance:

```bash
export A1_VM_HOST=ubuntu@192.168.64.10
infra/vm/a1-vm.sh bootstrap
infra/vm/a1-vm.sh a1 tenant create demo-client --modules studio,hayhashvapah,crm
infra/vm/a1-vm.sh a1 tenant check demo-client
infra/vm/a1-vm.sh a1 tenant export demo-client
infra/vm/a1-vm.sh tunnel
```

Definition of done:

- A clean Ubuntu VM can start the platform from Git, Docker Engine, and `.env`.
- No Docker Desktop installation is required for clients or production hosts.
- A tenant using Studio, HayHashvapah, and CRM can be exported and restored on another VM.
- Product code no longer depends on `/Users/...`, repo-local `data/`, or random upload folders for production data.
- Tenant files live in S3-compatible storage.
- Tenant databases are isolated and transferable.
- Gateway route changes require no product code change.
- Full backup and full restore are tested.
