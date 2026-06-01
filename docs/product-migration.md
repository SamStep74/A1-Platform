# Product Migration Plan

This platform foundation is the migration target for the three existing repos.

## A1 Studio

Current repo:

```text
/Users/samvelstepanyan/dev/A1-Suite-Local
```

Current storage:

- SQLite through `server/db.js`
- OS app-support path through `server/config.js`

Migration:

1. Add `packages/tenant-context` to request bootstrapping.
2. Resolve tenant by host before opening any business repository.
3. Replace process-wide SQLite connection with tenant-scoped Postgres connection.
4. Move identity/session/app assignment tables into `core`.
5. Move Studio-specific documents and generated export metadata into `studio`.
6. Store generated files under `tenants/<slug>/studio/`.

Initial import command inside the VM API container:

```bash
infra/vm/a1-vm.sh a1 product import studio <slug> --sqlite /path/in/vm/armosphera-one.db --app-version 2026.06.01
```

This loads every SQLite table into `studio.sqlite_import_batches` and `studio.legacy_rows` for audited migration before app code is switched to normalized repositories.

## A1 HayHashvapah

Current repo:

```text
/Users/samvelstepanyan/dev/A1-SMB-HH-HY
```

Current storage:

- SQLite in `lib/store.js`
- separate suite SQLite in `suite/store.js`
- local filesystem data directory

Current VM/client bridge:

- `A1_HAYHASHVAPAH_DATA_DIR=/opt/a1/product-data/hayhashvapah`
- `A1_HAYHASHVAPAH_SUITE_DATA_DIR=/opt/a1/product-data/hayhashvapah-suite`
- `A1_HAYHASHVAPAH_DATA_DIR` takes priority over legacy `DATA_DIR` in the product repo.

Migration:

1. Replace `store.init(DATA_DIR)` with tenant context plus tenant DB connection.
2. Move `accounts`, `sessions`, `audit_log`, and `meta` to `hayhashvapah`.
3. Keep `accounts.doc` as JSONB first to preserve behavior.
4. Move generated invoices, archives, e-invoice XML, and audit artifacts into S3 keys under `tenants/<slug>/hayhashvapah/`.
5. Move suite identity/session responsibility into A1 Studio/core; keep HayHashvapah as a module.

Initial import command inside the VM API container:

```bash
infra/vm/a1-vm.sh a1 product import hayhashvapah <slug> --sqlite /path/in/vm/hayhashvapah.sqlite
```

This loads `accounts`, `sessions`, `audit_log`, and `meta` into the `hayhashvapah` schema. Account documents remain JSONB for the first portable database slice.

## A1 CRM

Current repo:

```text
/Users/samvelstepanyan/dev/A1-SMB-CRM-HY
```

Current storage:

- tenant blueprints as `data/tenants/<slug>.json`
- tenant records as `data/records/<slug>.json`

Current VM/client bridge:

- `A1_CRM_DATA_DIR=/opt/a1/product-data/crm`
- local development falls back to repo-local `data` only when the A1 root is blank.

Migration:

1. Resolve slug through platform registry, not only host/query parsing.
2. Replace `lib/tenantStore.js` with `crm.tenant_blueprints`.
3. Replace `lib/recordStore.js` with `crm.records`.
4. Keep JSONB documents first so CRM behavior stays stable.
5. Move documents, portal artifacts, quotes, and payment files into `tenants/<slug>/crm/`.

Initial import command inside the VM API container:

```bash
infra/vm/a1-vm.sh a1 product import crm <slug> \
  --blueprint /path/in/vm/tenants/<slug>.json \
  --records /path/in/vm/records/<slug>.json
```

This loads the current CRM tenant blueprint into `crm.tenant_blueprints` and live records into `crm.records`.

## Acceptance

For each product, done means:

- no production dependency on `/Users/...` or repo-local `data/`
- tenant context exists before business data access
- product data can be included in `a1 tenant export`
- existing product tests still pass
- rendered desktop/mobile smoke checks still pass
- production/client runtime is Linux VM/host with Docker Engine or compatible runtime, not Docker Desktop
