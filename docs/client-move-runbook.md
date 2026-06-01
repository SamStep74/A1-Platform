# Client Move Runbook

Example tenant:

```text
demo-client
```

## Procedure

1. Announce a maintenance window.
2. Run `a1 tenant check demo-client`.
3. Run `a1 tenant export demo-client`.
4. Copy `/opt/a1/exports/demo-client` from the source VM host to the target host.
5. Start A1 Platform on the target Linux VM/host.
6. Run `a1 tenant import demo-client /path/to/exports/demo-client`.
7. Run `a1 tenant check demo-client` on the target host.
8. Switch the gateway route only after the target health check passes.
9. Activate the target tenant.
10. Keep the old host read-only during the rollback window.

## Commands

```bash
export A1_VM_HOST=ubuntu@source-vm
infra/vm/a1-vm.sh a1 tenant maintenance demo-client on
infra/vm/a1-vm.sh a1 tenant export demo-client

scp -r ubuntu@source-vm:/opt/a1/exports/demo-client ./demo-client-export
scp -r ./demo-client-export ubuntu@target-vm:/opt/a1/imports/demo-client

export A1_VM_HOST=ubuntu@target-vm
infra/vm/a1-vm.sh sync
infra/vm/a1-vm.sh init-env
infra/vm/a1-vm.sh up
infra/vm/a1-vm.sh migrate
infra/vm/a1-vm.sh a1 tenant import demo-client /opt/a1/imports/demo-client
infra/vm/a1-vm.sh a1 tenant check demo-client

export A1_VM_HOST=ubuntu@source-vm
infra/vm/a1-vm.sh a1 route set demo-client demo-client.a1suite.am --target-url http://10.10.5.40:4200
infra/vm/a1-vm.sh a1 gateway caddy --out /app/exports/Caddyfile.generated --email admin@a1suite.am
```

## Rollback Rules

- If target import fails, do not switch the route.
- If target check fails, do not switch the route.
- If route switch fails, restore the previous gateway target.
- If public validation fails after switch, point the route back to the old target and reactivate the old tenant.

## Runtime Rule

Both source and target must be Linux VM/host deployments using Docker Engine or a compatible Linux container runtime. Do not use Docker Desktop as the production/client runtime for a tenant move.
