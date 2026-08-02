import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import createServer, { SERVER_VERSION } from './server.js';

/**
 * Self-hosted Streamable HTTP entry point.
 *
 * The stdio entry (bin.ts) is for local MCP clients that spawn the process;
 * this entry exposes the same MCP server over HTTPS so remote clients that
 * speak the Streamable HTTP transport — e.g. a ChatGPT Developer Mode custom
 * connector — can reach it. Deploy behind a TLS-terminating proxy (Railway,
 * Fly, a reverse proxy) that forwards to $PORT.
 *
 * Credentials model is unchanged from the other entry points: COZI_USERNAME /
 * COZI_PASSWORD are read once at startup and live only in this process's
 * environment. Whoever operates this deployment holds the Cozi account.
 */

const username = process.env.COZI_USERNAME ?? '';
const password = process.env.COZI_PASSWORD ?? '';
const readOnly = parseBooleanEnv(process.env.COZI_READ_ONLY);

// Optional shared-secret gate on the HTTP endpoint. Unlike the stdio entries,
// which trust the local user, this one is reachable by anyone who learns the
// URL — and possession of the URL would otherwise mean full control of the
// Cozi account. When MCP_BEARER_TOKEN is set, every request must carry
// `Authorization: Bearer <token>`. Left unset, the endpoint is open (only
// appropriate when some other layer restricts access); startup warns loudly.
const bearerToken = process.env.MCP_BEARER_TOKEN ?? '';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const host = process.env.HOST ?? '0.0.0.0';
// The path ChatGPT (or any client) points at. Kept configurable so the URL
// can be made unguessable as defense-in-depth when no bearer token is used.
const mcpPath = process.env.MCP_PATH ?? '/mcp';

function parseBooleanEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false;
  process.stderr.write(
    `Cozi MCP: COZI_READ_ONLY="${value}" is not a recognized boolean value ` +
      '(expected true/false, 1/0, yes/no, on/off) — defaulting to read-write mode.\n',
  );
  return false;
}

if (!username || !password) {
  const missing = [!username ? 'COZI_USERNAME' : null, !password ? 'COZI_PASSWORD' : null].filter(
    (name): name is string => name !== null,
  );
  process.stderr.write(
    `Cozi MCP: ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
      'Every tool call will fail with an authentication error until both are configured ' +
      'as environment variables on this deployment.\n',
  );
}

if (!bearerToken) {
  process.stderr.write(
    'Cozi MCP: MCP_BEARER_TOKEN is not set — the HTTP endpoint is UNAUTHENTICATED. ' +
      'Anyone who reaches this URL can read and modify the configured Cozi account. ' +
      'Set MCP_BEARER_TOKEN to a long random secret and send it as ' +
      '"Authorization: Bearer <token>", or ensure access is restricted another way.\n',
  );
}

/**
 * Constant-time bearer check. Returns true when auth is satisfied — either no
 * token is configured (open mode) or the presented token matches exactly.
 */
export function isAuthorized(authHeader: string | undefined, expected: string): boolean {
  if (!expected) return true;
  if (!authHeader) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  const token = match?.[1];
  if (!token) return false;
  const presented = Buffer.from(token);
  const secret = Buffer.from(expected);
  if (presented.length !== secret.length) return false;
  return timingSafeEqual(presented, secret);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAuthorized(req.headers.authorization, bearerToken)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    sendJson(res, 401, {
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized: valid bearer token required' },
      id: null,
    });
    return;
  }

  // Stateless: a fresh server + transport per request. The Cozi client (and its
  // cached auth token) is shared module state in server.ts, so this is cheap —
  // only the thin MCP wiring is rebuilt. No session IDs to track, which keeps
  // horizontal scaling and cold-start restarts transparent to the client.
  const server = createServer({ config: { username, password, readOnly } });
  // Omitting sessionIdGenerator selects stateless mode: no session IDs, a fresh
  // transport required per request (satisfied here). Written as an omission
  // rather than `sessionIdGenerator: undefined` to stay clean under the repo's
  // exactOptionalPropertyTypes setting.
  const transport = new StreamableHTTPServerTransport({});
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    process.stderr.write(`Cozi MCP: request handling failed: ${(err as Error).message}\n`);
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
}

const httpServer = createHttpServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Liveness/readiness probe. No auth — returns no account data, only that the
  // process is up and which build is running.
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
    sendJson(res, 200, { status: 'ok', server: 'cozi-mcp', version: SERVER_VERSION });
    return;
  }

  if (url.pathname === mcpPath) {
    void handleMcp(req, res);
    return;
  }

  sendJson(res, 404, {
    jsonrpc: '2.0',
    error: { code: -32601, message: `Not found. MCP endpoint is ${mcpPath}` },
    id: null,
  });
});

// Only start listening when run as the entry point, so tests can import the
// pure helpers (isAuthorized) without binding a port.
if (process.env.COZI_MCP_HTTP_NO_LISTEN !== '1') {
  httpServer.listen(port, host, () => {
    process.stderr.write(
      `Cozi MCP HTTP server (v${SERVER_VERSION}) listening on ${host}:${port}, ` +
        `MCP endpoint ${mcpPath} — mode: ${readOnly ? 'read-only' : 'read-write'}, ` +
        `auth: ${bearerToken ? 'bearer token required' : 'OPEN'}.\n`,
    );
  });
}

export { httpServer };
