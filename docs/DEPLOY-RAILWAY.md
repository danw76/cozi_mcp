# Self-hosting Cozi MCP over HTTPS (Railway) + ChatGPT connector

This guide walks through deploying Cozi MCP as a **hosted Streamable HTTP MCP
endpoint** on [Railway](https://railway.com) and adding it to **ChatGPT
Developer Mode** as a custom connector.

Unlike the Smithery path, here **you** operate the process: your Cozi
credentials live only as environment variables on your own Railway service and
are never handed to a shared third-party MCP host. ChatGPT talks to your
endpoint over HTTPS and never sees your Cozi username or password — the server
uses them internally to reach `rest.cozi.com`.

> **Trust note.** Railway is still cloud infrastructure hosting your process, so
> your Cozi credentials sit in Railway's environment-variable store (encrypted
> at rest). That is the tradeoff you are choosing versus Smithery. If you want
> zero cloud custody of the credentials, run the container on hardware you
> control instead — the same image and env vars work anywhere.

---

## What gets deployed

The repo ships a dedicated HTTP entry point, `dist/http-server.js` (built from
`src/http-server.ts`), separate from the stdio entry used by npx/MCPB. It:

- serves the MCP Streamable HTTP transport at `POST /mcp` (path configurable),
- exposes an unauthenticated `GET /health` liveness probe,
- optionally requires an `Authorization: Bearer <token>` on every MCP request,
- reads the **same** `COZI_USERNAME` / `COZI_PASSWORD` / `COZI_READ_ONLY`
  environment variables as the other entry points.

It runs **stateless** (no session IDs), so restarts and horizontal scaling are
transparent to the client.

---

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `COZI_USERNAME` | ✅ | Your Cozi account email. |
| `COZI_PASSWORD` | ✅ | Your Cozi account password. |
| `MCP_BEARER_TOKEN` | strongly recommended | Shared secret. When set, every MCP request must send `Authorization: Bearer <token>`. Without it the endpoint is open to anyone who learns the URL. Generate with `openssl rand -hex 32`. |
| `COZI_READ_ONLY` | optional | `true` to expose only read tools and hide create/update/delete. Default `false`. |
| `MCP_PATH` | optional | Path the MCP endpoint is served at. Default `/mcp`. Make it unguessable as defense-in-depth if you can't use a bearer token. |
| `PORT` | injected | Railway sets this automatically; the server binds to it (defaults to `8080` locally). |
| `HOST` | optional | Bind address, default `0.0.0.0`. Leave as-is on Railway. |

See `.env.example` for a copy-paste template.

---

## Deploy on Railway

You'll need a Railway account and either the Railway CLI or the dashboard. This
project includes a `Dockerfile` and `railway.json`, so Railway builds the image
deterministically and runs `node dist/http-server.js` with a `/health` check.

### Option A — Dashboard (deploy from GitHub)

1. Push this branch/fork to your own GitHub repo (or use the upstream fork).
2. In Railway: **New Project → Deploy from GitHub repo** and pick the repo.
3. Railway detects the `Dockerfile` and `railway.json` automatically.
4. Open the service → **Variables** and add `COZI_USERNAME`, `COZI_PASSWORD`,
   and `MCP_BEARER_TOKEN` (plus `COZI_READ_ONLY` / `MCP_PATH` if you want them).
5. Under **Settings → Networking**, click **Generate Domain**. Railway gives you
   a public `https://<something>.up.railway.app` URL and terminates TLS for you.
6. Wait for the deploy to go green, then verify:
   ```bash
   curl https://<your-domain>.up.railway.app/health
   # → {"status":"ok","server":"cozi-mcp","version":"..."}
   ```

### Option B — Railway CLI

```bash
npm i -g @railway/cli
railway login
railway init                       # create/link a project
railway up                         # build & deploy from the Dockerfile
railway variables --set COZI_USERNAME=you@example.com \
                   --set COZI_PASSWORD='...' \
                   --set MCP_BEARER_TOKEN="$(openssl rand -hex 32)"
railway domain                     # generate the public HTTPS domain
```

Your MCP endpoint is then:

```
https://<your-domain>.up.railway.app/mcp
```

(or whatever you set `MCP_PATH` to).

---

## Add it to ChatGPT (Developer Mode)

1. In ChatGPT: **Settings → Connectors → Advanced → Developer mode** (requires a
   plan where custom connectors are available).
2. **Create / Add custom connector** and enter:
   - **Name:** e.g. `Cozi`
   - **MCP Server URL:** `https://<your-domain>.up.railway.app/mcp`
   - **Authentication:**
     - If ChatGPT offers an **access-token / API-key** field, paste your
       `MCP_BEARER_TOKEN` there (it is sent as `Authorization: Bearer <token>`,
       which is exactly what the server checks). **Recommended.**
     - If the only option is **No authentication**, you must leave
       `MCP_BEARER_TOKEN` unset on the server, because ChatGPT won't send it. In
       that case treat the URL as a secret and set an unguessable `MCP_PATH` —
       and understand that anyone with the URL can reach your Cozi account.
3. Save. ChatGPT runs the MCP handshake and lists the Cozi tools
   (`family_members`, `get_lists`, `get_calendar`, `create_appointment`, …).
4. In a chat, enable the connector and try: *"List my Cozi shopping list."*

> **OAuth:** This server does not implement an OAuth authorization server. If
> ChatGPT requires OAuth in your version and offers no token/no-auth path, that
> route isn't supported here without additional work — use the bearer-token or
> unguessable-URL path above.

---

## Local smoke test (optional)

You can exercise the exact HTTP surface locally before deploying:

```bash
npm run build
MCP_BEARER_TOKEN=devsecret COZI_USERNAME=you@example.com COZI_PASSWORD='...' \
  npm run start:http
# in another shell:
curl localhost:8080/health
curl -X POST localhost:8080/mcp \
  -H 'Authorization: Bearer devsecret' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

`npm run dev:http` runs the same entry with live reload via `tsx`.

---

## Security checklist

- [ ] `MCP_BEARER_TOKEN` set to a long random value (unless you have another
      access-control layer).
- [ ] Consider `COZI_READ_ONLY=true` if you only want ChatGPT to read, not
      modify, your family data.
- [ ] Treat the Railway domain + token like a password; rotate the token
      (`railway variables --set MCP_BEARER_TOKEN=...` then redeploy) if leaked.
- [ ] Remember credentials are read once at startup — after changing any
      `COZI_*` variable, redeploy/restart the service.
