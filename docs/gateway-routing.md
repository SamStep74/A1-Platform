# Gateway Routing

A1 Platform owns tenant route metadata in the registry table `tenant_routes`.
Product repos should not hardcode client VM, VPS, or Mac Studio IPs.

## Set A Route

```bash
infra/vm/a1-vm.sh a1 route set demo-client demo-client.a1suite.am \
  --product unified \
  --target-url http://10.10.5.40:4200
```

Use `--product studio`, `--product hayhashvapah`, or `--product crm` only when a host is dedicated to one product. The default route product is `unified`.

List active routes:

```bash
infra/vm/a1-vm.sh a1 route list
```

Include inactive routes:

```bash
infra/vm/a1-vm.sh a1 route list --all
```

## Generate Caddy Config

Render active registry routes into a Caddyfile:

```bash
infra/vm/a1-vm.sh a1 gateway caddy --out /app/exports/Caddyfile.generated --email admin@a1suite.am
```

The generated file contains one Caddy site block per active `tenant_routes` row:

```caddyfile
demo-client.a1suite.am {
  encode zstd gzip
  reverse_proxy http://10.10.5.40:4200
}
```

Copy the generated file into the gateway host's Caddy config location and reload Caddy only after `a1 tenant check <slug>` passes on the target host.

## Move Flow

For a client move:

1. Export the tenant from the source host.
2. Import and check the tenant on the destination host.
3. Run `a1 tenant move` with `--target-check-url`, `--post-switch-check-url`, and `--require-product-imports`.
4. Run `a1 gateway caddy` and reload Caddy.
5. Keep the old host read-only until public validation is complete.

`tenant move` refuses to switch when required product import audit rows are
missing or when the target health check fails. If the route switch happens and
post-switch validation fails, it restores the previous deployment target and
route URL.

This keeps route changes outside product code and avoids Docker Desktop as a runtime dependency. The gateway points to Linux VM/host targets running Docker Engine or another Linux container runtime.
