# Product Import Runbook

This runbook moves current product data into an existing platform tenant database.

## 1. Create Tenant

```bash
infra/vm/a1-vm.sh a1 tenant create demo-client --modules studio,hayhashvapah,crm --company-name "Demo Client LLC" --studio-org-id org-armosphera-demo
```

Copy current product source files from the Mac into the Ubuntu VM:

```bash
infra/vm/copy-product-sources.sh demo-client
```

The copy script also copies SQLite `-wal` and `-shm` sidecar files when they exist, so live SQLite data written through WAL mode is available to the importer. The VM Compose runtime mounts `/opt/a1/imports` read-only into the API and worker containers. It also mounts `/opt/a1/exports` to `/app/exports` and `/opt/a1/backups` to `/app/backups`, so transfer bundles survive container rebuilds.
It also writes `/opt/a1/imports/product-sources/source-manifest.json`, recording
the exact source paths and VM destination paths used for Studio, HayHashvapah,
and CRM.

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

## 2. Import Product Source Bundle

Use each command line as a single shell command. Avoid multiline `\\`-continued command blocks.

The normal VM path is one bundle import from `source-manifest.json`:

```bash
infra/vm/a1-vm.sh a1 product import-check demo-client --source-root /opt/a1/imports/product-sources --source-manifest /opt/a1/imports/product-sources/source-manifest.json

infra/vm/a1-vm.sh a1 product import all demo-client --source-root /opt/a1/imports/product-sources --source-manifest /opt/a1/imports/product-sources/source-manifest.json --app-version 2026.06.01
```

`a1 product import-check` prints a JSON preflight report and exits non-zero when
any source file is missing.
This imports Studio first, then HayHashvapah, then CRM, and records the same
source manifest path on each `product.import.<product>` operation.
The operation checksum is a portable product-source content checksum; it hashes
the labeled product source files and does not include absolute staging paths or
timestamp/path metadata from `source-manifest.json`.
Before writing tenant data, the command preflights the manifest plus every
Studio, HayHashvapah, and CRM source file, so a missing copied file fails before
any partial product import operation starts.

Use the individual commands below only when rerunning one product import.

## 3. Import A1 Studio SQLite

```bash
infra/vm/a1-vm.sh a1 product import studio demo-client --sqlite /opt/a1/imports/product-sources/studio/armosphera-one.db --source-manifest /opt/a1/imports/product-sources/source-manifest.json --app-version 2026.06.01
```

Destination:

```text
studio.sqlite_import_batches
studio.legacy_rows
```

If the copied Studio SQLite database has exactly one row in `organizations`,
the import also writes that id into the registry as `tenants.studio_org_id`.
That lets A1 Studio receive `orgId` from token-authenticated tenant context
without a separate registry edit. If the Studio source has multiple
organizations, keep using `a1 tenant create ... --studio-org-id <org-id>` or a
registry update before enabling strict Studio tenant binding.
`a1 tenant check <slug>` fails with `mapping:studio.org` while the Studio module
is enabled and this mapping is missing.

## 4. Import A1 HayHashvapah SQLite

```bash
infra/vm/a1-vm.sh a1 product import hayhashvapah demo-client --sqlite /opt/a1/imports/product-sources/hayhashvapah/hayhashvapah.sqlite --source-manifest /opt/a1/imports/product-sources/source-manifest.json
```

Destination:

```text
hayhashvapah.accounts
hayhashvapah.sessions
hayhashvapah.audit_log
hayhashvapah.meta
```

## 5. Import A1 CRM JSON

```bash
infra/vm/a1-vm.sh a1 product import crm demo-client --blueprint /opt/a1/imports/product-sources/crm/tenants/demo-client.json --records /opt/a1/imports/product-sources/crm/records/demo-client.json --source-manifest /opt/a1/imports/product-sources/source-manifest.json
```

Destination:

```text
crm.tenant_blueprints
crm.records
```

## 6. Verify And Export

```bash
infra/vm/a1-vm.sh a1 tenant check demo-client --require-product-imports
infra/vm/a1-vm.sh a1 tenant operations demo-client --limit 20
infra/vm/a1-vm.sh a1 tenant export demo-client --require-product-imports
```

The check output includes row counts for the landing tables, including `studio.legacy_rows`, `hayhashvapah.accounts`, `hayhashvapah.sessions`, and `crm.records`. The export bundle metadata records the same database row counts plus the tenant file count. Import validates those counts after `pg_restore` and fails before activation if the restored row counts or tenant file count do not match.
Each product import records a `tenant_operations` row named
`product.import.<product>` with the source manifest path and portable content
checksum, so the tenant audit trail shows which staged product data fed the
tenant database without making the checksum depend on the VM directory path.
The `--require-product-imports` check and export guard require the latest
operation for each enabled product module to be completed before export. Use
`a1 tenant operations` before export to inspect the expected
`product.import.studio`, `product.import.hayhashvapah`, and
`product.import.crm` rows were recorded.
The guarded export also writes those completed product import operation rows
into `registry.json`; import replays them into the target registry so a restored
tenant can pass `a1 tenant check <slug> --require-product-imports` without
rerunning the original product SQLite/JSON imports.
On the target host, use
`a1 tenant import <slug> <export-dir> --require-product-imports` to make import
fail immediately when that replayed audit evidence is absent.
Import also restores every `tenant_routes` row from the bundle registry, so
unified and product-specific hosts are available before generating the target
Caddyfile.
If the target registry already has extra route rows from an earlier import,
routes absent from the bundle registry are marked inactive during import.
Enabled/disabled `tenant_modules` rows and their `schema_version` values are
restored from the same registry file, which keeps optional products disabled
after a move until the operator intentionally enables them.
If the target registry already has extra module rows from an earlier import,
modules absent from the bundle registry are forced disabled during import.
Tenant health and row-count checks only require schemas and landing tables for
enabled modules plus `core` and `audit`, so disabled optional products do not
make a valid restore drill fail.

For Mac Studio deployments, copy the source SQLite/JSON files into the Ubuntu VM first. The production/client import path runs inside the VM with Docker Engine, not Docker Desktop on macOS.
