# Disaster Recovery

Initial targets:

```text
MVP RPO: 24 hours
MVP RTO: 4-8 hours
Commercial SaaS RPO: 1 hour or less
Commercial SaaS RTO: 1-2 hours
Accounting clients RPO: 15 minutes with WAL archiving
Accounting clients RTO: under 1 hour
```

Minimum production controls:

- PostgreSQL, Redis, and MinIO are not publicly exposed.
- Admin API is protected with `ADMIN_TOKEN` or placed behind VPN/SSO.
- TLS terminates at Caddy, Cloudflare, or a VPS gateway.
- Backups are encrypted before leaving the host.
- Tenant export/import/move operations are recorded in `tenant_operations`.
- Monthly restore tests run on a clean VM.
- Docker Desktop is not installed or required on production/client hosts.

Do not expose a Mac Studio directly to the internet. Put Cloudflare DNS/WAF or a VPS gateway in front, then reach the Mac Studio-hosted Ubuntu VM through WireGuard, Tailscale, or Cloudflare Tunnel.

For Mac Studio deployments, containers run inside Ubuntu ARM64 VM with Docker Engine. The macOS host is only the VM host and operator workstation.
