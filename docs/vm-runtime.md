# Option A VM Runtime

## Decision

A1 Platform must not require Docker Desktop for client or production deployments.

The supported local/private runtime is:

```text
Mac Studio host
  -> Ubuntu ARM64 VM
    -> Docker Engine on Linux
      -> A1 Platform Compose stack
```

Docker Desktop is a desktop product with its own subscription terms. Docker Engine is installed inside Linux and keeps the container portability benefits without adding a Docker Desktop license dependency for each client.

Docker Desktop is only required when running containers directly on macOS/Windows desktop hosts. For ARM64 client deployments, the platform path is VM-first: Ubuntu VM + Docker Engine + Compose, so clients are only exposed to VM/SaaS costs, not Docker Desktop seats.

Podman or containerd can be evaluated later, but the current implemented path is Docker Engine because it gives the most direct Compose compatibility for PostgreSQL, Redis, MinIO, Caddy, API, and worker services.

Reference points:

- Docker Desktop license: https://docs.docker.com/subscription/desktop-license/
- Docker Engine install on Ubuntu: https://docs.docker.com/installation/ubuntulinux/
- Docker Compose plugin on Linux: https://docs.docker.com/compose/install/linux/

## VM Requirements

Recommended VM:

- Ubuntu Server ARM64 LTS
- 4 vCPU minimum, 8 vCPU preferred
- 8 GB RAM minimum, 16 GB preferred for larger tenants
- 80 GB disk minimum for demo, 250 GB+ for real client data
- SSH access from the Mac host
- No public exposure of PostgreSQL, Redis, or MinIO

On Mac Studio MQH63LL/A, use an ARM64 Ubuntu VM. The VM can be created with any acceptable hypervisor. The platform repo does not require Docker Desktop on macOS.

## Install Docker Engine In The VM

From the Mac host:

```bash
cd /Users/samvelstepanyan/dev/A1-Platform
A1_VM_HOST=ubuntu@192.168.64.10 infra/vm/a1-vm.sh install-engine
```

Or from inside the Ubuntu VM:

```bash
cd /opt/a1/A1-Platform
bash infra/vm/install-docker-engine.sh
```

After install, log out and back in if the script adds the VM user to the `docker` group.

## Bootstrap The A1 Stack

From the Mac host:

```bash
cd /Users/samvelstepanyan/dev/A1-Platform
A1_VM_HOST=ubuntu@192.168.64.10 infra/vm/a1-vm.sh bootstrap
```

Equivalent npm shortcut:

```bash
export A1_VM_HOST=ubuntu@192.168.64.10
npm run vm:bootstrap
```

What bootstrap does:

1. Installs Docker Engine in the VM.
2. Syncs this repo to `/opt/a1/A1-Platform`.
3. Creates `/opt/a1/A1-Platform/infra/compose/.env` from `.env.example` if missing.
4. Starts `infra/compose/compose.vm.yml`.
5. Runs registry migrations.
6. Runs platform health.

Before real use, edit the VM file:

```bash
ssh ubuntu@192.168.64.10
cd /opt/a1/A1-Platform
nano infra/compose/.env
```

Replace all development secrets before onboarding a real tenant.

## First-boot runbook (copy/paste-safe)

Use each command separately. Do not paste multiline heredoc-style command blocks into one shell input.

```bash
cd /Users/samvelstepanyan/dev/A1-Platform
export A1_VM_HOST=ubuntu@192.168.64.10
npm install
npm run vm:bootstrap
npm run vm:tunnel
```

Keep `npm run vm:tunnel` running in its own terminal. After that, use this terminal for CLI actions:

```bash
infra/vm/copy-product-sources.sh demo-client
infra/vm/a1-vm.sh a1 tenant create demo-client --modules studio,hayhashvapah,crm --studio-org-id org-armosphera-demo
infra/vm/a1-vm.sh a1 tenant check demo-client
```

## Daily Commands

```bash
export A1_VM_HOST=ubuntu@192.168.64.10

infra/vm/a1-vm.sh sync
infra/vm/a1-vm.sh up
infra/vm/a1-vm.sh migrate
infra/vm/a1-vm.sh health
infra/vm/a1-vm.sh a1 tenant create demo-client --modules studio,hayhashvapah,crm --studio-org-id org-armosphera-demo
infra/vm/a1-vm.sh a1 tenant check demo-client
infra/vm/a1-vm.sh ps
infra/vm/a1-vm.sh logs api worker
```

The same commands are exposed as npm shortcuts:

```bash
npm run vm:check
npm run vm:sync
npm run vm:up
npm run vm:migrate
npm run vm:health
npm run vm:ps
```

Copy current Mac product source files into the VM before running import commands:

```bash
infra/vm/copy-product-sources.sh demo-client
```

The script uses `A1_CRM_REPO_DIR` when locating CRM JSON sources and defaults to `$HOME/dev/A1-SMB-CRM-HY`. If CRM JSON files are missing, it generates deterministic demo CRM JSON from that repo unless `A1_CRM_GENERATE_DEMO=0` is set.

This stages files under:

```text
/opt/a1/imports/product-sources/
  studio/armosphera-one.db
  studio/armosphera-one.db-wal
  studio/armosphera-one.db-shm
  hayhashvapah/hayhashvapah.sqlite
  hayhashvapah/hayhashvapah.sqlite-wal
  hayhashvapah/hayhashvapah.sqlite-shm
  crm/tenants/<slug>.json
  crm/records/<slug>.json
  source-manifest.json
```

The API and worker containers mount `/opt/a1/imports` read-only. They mount `/opt/a1/exports` to `/app/exports` and `/opt/a1/backups` to `/app/backups`, so exported tenant bundles and full backups are available from the VM host.
The `source-manifest.json` file is an operator audit record for the product
source files copied into the VM before running `a1 product import ...`.
Import the full copied source bundle with one command:

```bash
infra/vm/a1-vm.sh a1 product import-check demo-client \
  --source-root /opt/a1/imports/product-sources \
  --source-manifest /opt/a1/imports/product-sources/source-manifest.json

infra/vm/a1-vm.sh a1 product import all demo-client \
  --source-root /opt/a1/imports/product-sources \
  --source-manifest /opt/a1/imports/product-sources/source-manifest.json

infra/vm/a1-vm.sh a1 tenant check demo-client --require-product-imports
```

`a1 product import-check` is a dry run that returns per-file JSON status and
does not write tenant data.
The bundle import checks every source file listed in the manifest before writing
tenant data, so missing copied files fail before a partial import starts.
The post-import tenant check confirms the latest import operation for every
enabled product module is completed before the tenant is exported or moved.

Until all product modules read/write the tenant Postgres schemas directly, keep
product bridge data outside the product checkouts:

```bash
sudo mkdir -p /opt/a1/product-data/studio /opt/a1/product-data/hayhashvapah /opt/a1/product-data/hayhashvapah-suite /opt/a1/product-data/crm
```

Set these in the product service environment, not the Platform API container:

```dotenv
ARMOSPHERA_ONE_DATA_DIR=/opt/a1/product-data/studio
ARMOSPHERA_ONE_DB=/opt/a1/product-data/studio/armosphera-one.db
A1_HAYHASHVAPAH_STORAGE=platform-postgres
A1_HAYHASHVAPAH_DATABASE_URL=postgresql://.../a1_tenant_<slug>
A1_HAYHASHVAPAH_TENANT_SLUG=<slug>
A1_HAYHASHVAPAH_DATA_DIR=/opt/a1/product-data/hayhashvapah
A1_HAYHASHVAPAH_SUITE_DATA_DIR=/opt/a1/product-data/hayhashvapah-suite
A1_CRM_STORAGE=platform-postgres
A1_CRM_DATABASE_URL=postgresql://.../a1_tenant_<slug>
A1_CRM_DATA_DIR=/opt/a1/product-data/crm
```

After creating a tenant, generate product service env snippets from the registry:

```bash
infra/vm/a1-vm.sh a1 product env all demo-client --redact
infra/vm/a1-vm.sh a1 product env crm demo-client
infra/vm/a1-vm.sh a1 product env all demo-client --out /app/exports/product-env/demo-client
infra/vm/a1-vm.sh a1 tenant handoff demo-client --out /app/exports/handoff --redact
infra/vm/a1-vm.sh a1 tenant handoff-check /app/exports/handoff/demo-client
```

The redacted form is safe for tickets and runbooks. The non-redacted HayHashvapah
and CRM outputs include `A1_HAYHASHVAPAH_STORAGE=platform-postgres`,
`A1_HAYHASHVAPAH_DATABASE_URL`, `A1_CRM_STORAGE=platform-postgres`, and
`A1_CRM_DATABASE_URL` for the tenant database, so use them only inside the
trusted VM/client service environment.
When `--out` is used, Platform writes `demo-client.studio.env`,
`demo-client.hayhashvapah.env`, `demo-client.crm.env`, and
`demo-client.manifest.json` under the output directory.
`a1 tenant handoff` wraps those env files with `tenant.json`, `routes.json`, a
generated tenant Caddyfile, `checksums.txt`, and a handoff manifest for
transfer/change tickets.
After copying the handoff directory to another VM, run
`infra/vm/a1-vm.sh a1 tenant handoff-check /opt/a1/imports/<slug>-handoff`
before applying product service env files or gateway snippets. For `--redact`
handoffs, this also validates that tenant DB URLs and product env snippets do
not contain unredacted Postgres passwords or `A1_PLATFORM_TOKEN` values.

## Browser Access From Mac

The VM Compose file binds the local gateway to `127.0.0.1:8088` inside the VM. Keep it private and open an SSH tunnel from the Mac:

```bash
export A1_VM_HOST=ubuntu@192.168.64.10
infra/vm/a1-vm.sh tunnel
```

Then open:

```text
http://127.0.0.1:8088
```

The MinIO console is also tunneled to:

```text
http://127.0.0.1:9001
```

## Production And Client Deployments

For VPS, dedicated client hardware, or cloud VM deployments, use Linux plus Docker Engine or a compatible container runtime directly on that host. Do not ask clients to install Docker Desktop.

Production routing stays the same:

```text
Cloudflare DNS/WAF
  -> VPS or gateway
    -> WireGuard/Tailscale/Cloudflare Tunnel
      -> active A1 host or client VM
```

Only Caddy or the gateway should receive public traffic. PostgreSQL, Redis, and MinIO stay private on the Compose network.

## Acceptance Update

The runtime is acceptable when:

- `docker --version` and `docker compose version` work inside the Ubuntu VM.
- `infra/vm/a1-vm.sh bootstrap` starts the stack without Docker Desktop.
- `infra/vm/a1-vm.sh a1 tenant create demo-client --modules studio,hayhashvapah,crm --studio-org-id org-armosphera-demo` succeeds.
- `infra/vm/a1-vm.sh a1 tenant export demo-client --require-product-imports` produces the transfer bundle.
- A second VM can import the bundle with `--require-product-imports` and pass `tenant check`.
