# A1 Platform — AI (Admin Assistant)

A1 Platform has a net-new **advisory, read-only operations assistant** for platform
operators, built on the shared
[`@a1/ai`](https://github.com/SamStep74/A1-AI-Core) package (vendored at
`src/vendor/a1-ai`) over **OpenRouter**.

It is **advisory and read-only**: it explains, summarizes, and suggests — it never
provisions tenants, runs migrations, changes config, or executes commands.

## Configure (env)

| Env | Default | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | — | required; without it the endpoint returns 503 `AI_NOT_CONFIGURED` |
| `OPENROUTER_MODEL` | `auto` | optional model id (e.g. `openai/gpt-4o-mini`) |

## Endpoint (admin-guarded — `x-a1-admin-token`)

```
POST /api/admin/assistant
  { "question": "How many tenants are active, and what should I check before scaling?" }
->
  { "provider": "openrouter", "model": "...", "advisory": true,
    "answer": "...", "guardrails": [ ... ] }
```

## Safety

- **Read-only / advisory** — system prompt + returned `guardrails` make clear it
  performs no platform changes.
- **No tenant PII to the model.** The endpoint feeds the assistant only **safe
  aggregate context** — tenant counts and status breakdown — never slugs, domains,
  org-ids, or any tenant data.
- **Admin-gated** like every `/api/admin/*` route.

## How it works

```js
// src/server.js → POST /api/admin/assistant
const context  = await safePlatformContext(platformDb);   // { tenantCount, byStatus }
const assistant = createPlatformAssistant({ env: process.env });
const result    = await assistant.ask({ question, context, env: process.env });
```

## Notes

- **Egress**: Platform calls OpenRouter directly (no allowlist gate today).
- The OpenRouter key never leaves the server.
- API-only (Platform admin is token-based; no admin web UI).
