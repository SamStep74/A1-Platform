# Backup And Restore

## Full Backup

```bash
a1 backup full --require-product-imports
```

Backup layout:

```text
backups/full/<timestamp>/
  registry.dump
  metadata.json
  checksums.txt
  tenants/
    <slug>/
      metadata.json
      registry.json
      db.dump
      files/
      checksums.txt
```

The root `checksums.txt` covers the registry dump, full-backup metadata, and every tenant bundle. Each tenant `metadata.json` includes `counts.database_rows` and `counts.storage_files`. With `--require-product-imports`, each tenant export must have completed `product.import.*` audit rows for its enabled modules before the full backup is accepted. Restore verifies the root backup checksum before any registry restore, then verifies each tenant bundle and post-restore counts after `pg_restore` and file sync.

## Full Restore

```bash
a1 restore full ./backups/full/<timestamp> --require-product-imports
```

Restore flow:

1. Verify the root backup `checksums.txt`.
2. Restore `a1_registry`.
3. Restore each tenant database.
4. Restore each tenant file prefix.
5. Run tenant migrations.
6. Replay product import audit rows from each tenant bundle.
7. Run tenant checks.
8. When `--require-product-imports` is set, fail the restore if any enabled module lacks completed product import audit evidence.
9. Keep tenants in maintenance unless `--activate` is provided.
10. Write `restore-report.json` into the backup directory unless `--report-out` is provided.

Custom report path:

```bash
a1 restore full ./backups/full/<timestamp> --report-out ./restore-reports/monthly-drill.json --require-product-imports
```

Restore reports include:

- registry restore status
- root backup checksum status
- backup metadata summary
- one entry per tenant
- restored file counts
- post-restore tenant checks
- guarded product import audit checks when `--require-product-imports` is used
- failure details when the restore aborts

## Restore Test

Run monthly on a clean VM:

```bash
export A1_VM_HOST=ubuntu@restore-drill-vm
infra/vm/a1-vm.sh bootstrap
infra/vm/a1-vm.sh a1 restore full /opt/a1/backups/full/latest --require-product-imports
infra/vm/a1-vm.sh a1 tenant check demo-client --require-product-imports
```

The restore drill VM must use Linux Docker Engine or a compatible Linux container runtime. Docker Desktop is not part of the backup/restore acceptance path.

The restore drill is not accepted unless the restore report exists and has `"ok": true`.
