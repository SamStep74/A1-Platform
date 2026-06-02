# Client Move Runbook

Example tenant:

```text
demo-client
```

## Procedure

1. Announce a maintenance window.
2. Run `a1 tenant check demo-client --require-product-imports`.
3. Run `a1 tenant export demo-client --require-product-imports`.
4. Run `a1 tenant handoff demo-client` to write route and product-service env context.
5. Copy `/opt/a1/exports/demo-client` from the source VM host to the target host.
6. Start A1 Platform on the target Linux VM/host.
7. Run `a1 tenant import demo-client /path/to/exports/demo-client --require-product-imports`.
8. Run `a1 tenant check demo-client --require-product-imports` on the target host.
9. Switch the gateway route only after the target health check passes.
10. Activate the target tenant.
11. Keep the old host read-only during the rollback window.

## Commands

Use each line as a separate shell command. Avoid pasting multiline `\`-continued commands.

```bash
export A1_VM_HOST=ubuntu@source-vm
infra/vm/a1-vm.sh a1 tenant maintenance demo-client on
infra/vm/a1-vm.sh a1 tenant export demo-client --require-product-imports
infra/vm/a1-vm.sh a1 tenant handoff demo-client --out /app/exports/handoff --redact

scp -r ubuntu@source-vm:/opt/a1/exports/demo-client ./demo-client-export
scp -r ubuntu@source-vm:/opt/a1/exports/handoff/demo-client/demo-client ./demo-client-handoff/demo-client
scp -r ./demo-client-export ubuntu@target-vm:/opt/a1/imports/demo-client
scp -r ./demo-client-handoff/demo-client ubuntu@target-vm:/opt/a1/imports/demo-client-handoff

export A1_VM_HOST=ubuntu@target-vm
infra/vm/a1-vm.sh sync
infra/vm/a1-vm.sh init-env
infra/vm/a1-vm.sh up
infra/vm/a1-vm.sh migrate
infra/vm/a1-vm.sh a1 tenant handoff-check /opt/a1/imports/demo-client-handoff/demo-client
# handoff-check also accepts the parent folder:
# infra/vm/a1-vm.sh a1 tenant handoff-check /opt/a1/imports/demo-client-handoff
infra/vm/a1-vm.sh a1 tenant import demo-client /opt/a1/imports/demo-client --require-product-imports
infra/vm/a1-vm.sh a1 tenant check demo-client --require-product-imports

export A1_VM_HOST=ubuntu@source-vm
infra/vm/a1-vm.sh a1 tenant move demo-client --target target-vm --target-url http://10.10.5.40:4200 --target-check-url http://10.10.5.40:4200/api/platform/health --post-switch-check-url https://demo-client.a1suite.am/api/platform/health --require-product-imports
infra/vm/a1-vm.sh a1 gateway caddy --out /app/exports/Caddyfile.generated --email admin@a1suite.am
```

If you need a line-per-step variant, run:

```bash
export A1_VM_HOST=ubuntu@source-vm
infra/vm/a1-vm.sh a1 tenant move demo-client --target target-vm --target-url http://10.10.5.40:4200 --target-check-url http://10.10.5.40:4200/api/platform/health --post-switch-check-url https://demo-client.a1suite.am/api/platform/health --require-product-imports
```

The handoff directory contains `tenant.json`, `routes.json`, a generated
`Caddyfile`, `handoff-manifest.json`, `checksums.txt`, and per-product env files under
`product-env/`. Use `--redact` for support/runbook copies. Generate a
non-redacted handoff only inside the trusted VM/client environment when service
files need real database URLs and platform tokens.

After copying the handoff folder, verify `checksums.txt` before applying product
service env files or gateway snippets. Use `a1 tenant handoff-check` to verify
that manifest paths are portable relative paths and that every copied file still
matches the source checksum. For handoffs generated with `--redact`, the check
also fails if `tenant.json` or any product env file contains an unredacted
Postgres password or `A1_PLATFORM_TOKEN`.

## Rollback Rules

- If target import fails, including missing product import audit evidence, do not switch the route.
- If required product import audit rows are missing, `tenant export` and `tenant move` abort before route switching.
- If `--target-check-url` fails, `tenant move` does not switch the route.
- If route switch or `--post-switch-check-url` fails, `tenant move` restores the previous deployment target and route URL.
- After a successful route switch, `tenant move` clears the temporary `migrating` status back to the tenant status that existed before the move command. If the tenant was manually placed in maintenance before the move, turn maintenance off only after final business validation.
- If public validation fails after the command completes, point the route back to the old target and reactivate the old tenant.

## Runtime Rule

Both source and target must be Linux VM/host deployments using Docker Engine or a compatible Linux container runtime. Do not use Docker Desktop as the production/client runtime for a tenant move.
