# Backup And Restore

## Full Backup

```bash
a1 backup full
```

Backup layout:

```text
backups/full/<timestamp>/
  registry.dump
  metadata.json
  tenants/
    <slug>/
      metadata.json
      registry.json
      db.dump
      files/
      checksums.txt
```

Each tenant `metadata.json` includes `counts.database_rows` and `counts.storage_files`. Restore verifies those counts after `pg_restore` and file sync, alongside checksum verification.

## Full Restore

```bash
a1 restore full ./backups/full/<timestamp>
```

Restore flow:

1. Restore `a1_registry`.
2. Restore each tenant database.
3. Restore each tenant file prefix.
4. Run tenant migrations.
5. Run tenant checks.
6. Keep tenants in maintenance unless `--activate` is provided.
7. Write `restore-report.json` into the backup directory unless `--report-out` is provided.

Custom report path:

```bash
a1 restore full ./backups/full/<timestamp> --report-out ./restore-reports/monthly-drill.json
```

Restore reports include:

- registry restore status
- backup metadata summary
- one entry per tenant
- restored file counts
- post-restore tenant checks
- failure details when the restore aborts

## Restore Test

Run monthly on a clean VM:

```bash
export A1_VM_HOST=ubuntu@restore-drill-vm
infra/vm/a1-vm.sh bootstrap
infra/vm/a1-vm.sh a1 restore full /opt/a1/backups/full/latest
infra/vm/a1-vm.sh a1 tenant check demo-client
```

The restore drill VM must use Linux Docker Engine or a compatible Linux container runtime. Docker Desktop is not part of the backup/restore acceptance path.

The restore drill is not accepted unless the restore report exists and has `"ok": true`.
