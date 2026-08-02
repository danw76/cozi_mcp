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
| `MCP_BEARER_TOKEN` | gate option 1 | Header gate. When set, every MCP request must send `Authorization: Bearer <token>`. Strongest option, but only for clients that can attach a static header. Generate with `openssl rand -hex 32`. |
| `MCP_PATH_SECRET` | gate option 2 | Path gate for clients that **cannot** send a header (e.g. ChatGPT — see below). When set, the endpoint moves to `<MCP_PATH>/<secret>` and the bare base path 404s; clients connect with "No authentication" and the unguessable path is the credential. The bearer check is not additionally required. Generate with `openssl rand -hex 32`. |
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

### Two gotchas worth knowing

If you create the service through Railway's API/MCP (rather than the dashboard
"Deploy from repo" button), Railway may default to its own builder (Nixpacks /
Railpack) and **ignore `railway.json`**, booting `npm start` (the stdio entry)
instead of the HTTP server — you'll see a `502 Application failed to respond`.
Two settings make it deterministic:

- **Force the Dockerfile builder + start command** on the service:
  set its Dockerfile path to `Dockerfile` and its start command to
  `node dist/http-server.js`. In the dashboard: service → **Settings → Build**
  (Builder → Dockerfile) and **Settings → Deploy** (Custom Start Command).
- **Pin the port.** Railway routes the public domain to the container's port.
  If it can't detect it you'll get `502`/connection resets. Set a `PORT`
  variable (e.g. `8080`, matching the Dockerfile's `EXPOSE`/`ENV PORT`) so the
  app and the router agree, or set the domain's target port to `8080`.

Also set the healthcheck path to `/health` (service → Settings → Deploy) so a
deploy is only marked healthy once the app is actually serving.

Your MCP endpoint is then:

```
https://<your-domain>.up.railway.app/mcp
```

(or whatever you set `MCP_PATH` to).

---

## Add it to ChatGPT (Developer Mode)

ChatGPT's custom-connector form only offers **OAuth** or **No authentication** —
there is no field for a static bearer header, and "Mixed" just attempts OAuth
discovery (which fails here with *"MCP server does not implement OAuth"*). So the
working route is **No authentication + a path secret**:

1. On the server, set **`MCP_PATH_SECRET`** to a long random value
   (`openssl rand -hex 32`). The endpoint moves to
   `https://<your-domain>.up.railway.app/mcp/<secret>` and the bare `/mcp` path
   returns 404. (`MCP_BEARER_TOKEN` is not needed in this mode.)
2. In ChatGPT: **Settings → Connectors → Advanced → Developer mode** (requires a
   plan where custom connectors are available).
3. **Create / Add custom connector** and enter:
   - **Name:** e.g. `Cozi`
   - **MCP Server URL:** `https://<your-domain>.up.railway.app/mcp/<secret>`
     (the full path *including* the secret segment)
   - **Authentication:** **No authentication**
4. Save. ChatGPT runs the MCP handshake and lists the Cozi tools
   (`family_members`, `get_lists`, `get_calendar`, `create_appointment`, …).
5. In a chat, enable the connector and try: *"List my Cozi shopping list."*

> **Security tradeoff:** a path secret is weaker than a header — URLs can leak
> into proxy logs, browser history, and `Referer` headers. Treat the full URL
> like a password: don't share it, and rotate `MCP_PATH_SECRET` if it leaks.
> For clients that *can* send a header, prefer `MCP_BEARER_TOKEN` instead.

> **OAuth:** This server does not implement an OAuth authorization server, so
> ChatGPT's OAuth/"Mixed" options won't work — use the No-authentication +
> path-secret route above.

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
