# Product Import Runbook

This runbook moves current product data into an existing platform tenant database.

## 1. Create Tenant

```bash
infra/vm/a1-vm.sh a1 tenant create demo-client --modules studio,hayhashvapah,crm --company-name "Demo Client LLC"
```

Copy current product source files from the Mac into the Ubuntu VM:

```bash
infra/vm/copy-product-sources.sh demo-client
```

The copy script also copies SQLite `-wal` and `-shm` sidecar files when they exist, so live SQLite data written through WAL mode is available to the importer. The VM Compose runtime mounts `/opt/a1/imports` read-only into the API and worker containers. It also mounts `/opt/a1/exports` to `/app/exports` and `/opt/a1/backups` to `/app/backups`, so transfer bundles survive container rebuilds.

When product repos are running with external VM/client data roots, pass the same
roots to the copy script:

```bash
export ARMOSPHERA_ONE_DATA_DIR=/opt/a1/product-data/studio
export ARMOSPHERA_ONE_DB=/opt/a1/product-data/studio/armosphera-one.db
export A1_HAYHASHVAPAH_DATA_DIR=/opt/a1/product-data/hayhashvapah
export A1_CRM_DATA_DIR=/opt/a1/product-data/crm
infra/vm/copy-product-sources.sh demo-client
```

Those variables point the importer at `armosphera-one.db`,
`hayhashvapah.sqlite`, `tenants/<slug>.json`, and `records/<slug>.json` outside
the product checkouts.

If CRM JSON does not yet exist under `A1-SMB-CRM-HY/data/tenants` and `data/records`, the copy script can generate a deterministic local-fallback demo source from the CRM repo. Override the CRM repo path with `A1_CRM_REPO_DIR`; set `A1_CRM_GENERATE_DEMO=0` to require existing CRM JSON files only.

## 2. Import A1 Studio SQLite

```bash
infra/vm/a1-vm.sh a1 product import studio demo-client \
  --sqlite /opt/a1/imports/product-sources/studio/armosphera-one.db \
  --app-version 2026.06.01
```

Destination:

```text
studio.sqlite_import_batches
studio.legacy_rows
```

## 3. Import A1 HayHashvapah SQLite

```bash
infra/vm/a1-vm.sh a1 product import hayhashvapah demo-client \
  --sqlite /opt/a1/imports/product-sources/hayhashvapah/hayhashvapah.sqlite
```

Destination:

```text
hayhashvapah.accounts
hayhashvapah.sessions
hayhashvapah.audit_log
hayhashvapah.meta
```

## 4. Import A1 CRM JSON

```bash
infra/vm/a1-vm.sh a1 product import crm demo-client \
  --blueprint /opt/a1/imports/product-sources/crm/tenants/demo-client.json \
  --records /opt/a1/imports/product-sources/crm/records/demo-client.json
```

Destination:

```text
crm.tenant_blueprints
crm.records
```

## 5. Verify And Export

```bash
infra/vm/a1-vm.sh a1 tenant check demo-client
infra/vm/a1-vm.sh a1 tenant export demo-client
```

The check output includes row counts for the landing tables, including `studio.legacy_rows`, `hayhashvapah.accounts`, `hayhashvapah.sessions`, and `crm.records`. The export bundle metadata records the same database row counts plus the tenant file count. Import validates those counts after `pg_restore` and fails before activation if the restored row counts or tenant file count do not match.

For Mac Studio deployments, copy the source SQLite/JSON files into the Ubuntu VM first. The production/client import path runs inside the VM with Docker Engine, not Docker Desktop on macOS.
