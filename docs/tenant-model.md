# Tenant Model

## Registry

The registry lives in `a1_registry` and is the only place that maps a public route to a tenant database and storage prefix.

Core tables:

- `tenants`: tenant identity, status, database name, storage prefix, deployment target, app version, and optional A1 Studio org mapping.
- `tenant_modules`: enabled modules: `studio`, `hayhashvapah`, `crm`.
- `tenant_routes`: host-to-target routing metadata.
- `tenant_operations`: export/import/move/backup audit trail.

Tenant transfer bundles include completed `product.import.*` operation evidence
inside `registry.json`. Import replays that evidence into the target
`tenant_operations` table after restore validation so guarded transfer checks
remain portable across hosts.

`studio_org_id` binds the Platform tenant to the current A1 Studio local
organization id while Studio still runs on SQLite. Token-authenticated
`GET /api/tenants/current` calls return that value as `orgId`; Studio uses it to
reject unmapped tenants and cross-host session replay before touching tenant
data. Public tenant lookups omit the mapping.

## Tenant Database

Each tenant has a dedicated PostgreSQL database:

```text
a1_tenant_<slug>
  core.*
  studio.*
  hayhashvapah.*
  crm.*
  audit.*
```

Database-per-tenant is the default because it makes transfer, restore, deletion, and dedicated-client deployment straightforward.

## Tenant Status

```text
active       normal access
maintenance blocked for product users, admin can operate
suspended   blocked for business/account reasons
migrating   blocked while export/import/move runs
archived    read-only retained history
```

Tenant context must be resolved before any product touches business data.

## Runtime Placement

The registry and tenant databases run inside the active Linux host:

```text
Ubuntu ARM64 VM on Mac Studio, Linux VPS, cloud VM, or dedicated Linux client hardware
```

Docker Desktop is not a runtime dependency. For Mac Studio-hosted deployments, containers run inside an Ubuntu ARM64 VM with Docker Engine. Route changes point the gateway to the active VM/host, not to a macOS Docker Desktop service.
