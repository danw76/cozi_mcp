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

// Two independent ways to gate the endpoint. Unlike the stdio entries, which
// trust the local user, this one is reachable by anyone who learns the URL —
// and possession of the URL would otherwise mean full control of the Cozi
// account.
//
// 1. MCP_BEARER_TOKEN — a header gate: every request must carry
//    `Authorization: Bearer <token>`. The stronger option, but some clients
//    (notably ChatGPT's custom-connector form, which only offers OAuth or
//    "No authentication") can't attach a static header.
//
// 2. MCP_PATH_SECRET — a path gate: the MCP endpoint is served at
//    `<MCP_PATH>/<secret>` instead of `<MCP_PATH>`, and the base path 404s.
//    A client that can't send headers still connects with "No authentication"
//    because the unguessable path segment is the credential. Weaker than a
//    header (URLs leak into proxy logs, history, Referer), but effective when a
//    header gate isn't possible. When set, the bearer check is not additionally
//    required, so a header-less client works.
//
// If neither is set the endpoint is open; startup warns loudly.
const bearerToken = process.env.MCP_BEARER_TOKEN ?? '';
const pathSecret = process.env.MCP_PATH_SECRET ?? '';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const host = process.env.HOST ?? '0.0.0.0';
// The base path clients point at. Kept configurable; when MCP_PATH_SECRET is
// set the live endpoint is `${mcpBasePath}/${secret}`.
const mcpBasePath = (process.env.MCP_PATH ?? '/mcp').replace(/\/+$/, '') || '/mcp';
const mcpEndpointPath = pathSecret ? `${mcpBasePath}/${pathSecret}` : mcpBasePath;

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

if (!bearerToken && !pathSecret) {
  process.stderr.write(
    'Cozi MCP: neither MCP_BEARER_TOKEN nor MCP_PATH_SECRET is set — the HTTP ' +
      'endpoint is UNAUTHENTICATED. Anyone who reaches this URL can read and ' +
      'modify the configured Cozi account. Set MCP_BEARER_TOKEN (sent as ' +
      '"Authorization: Bearer <token>") or MCP_PATH_SECRET (an unguessable path ' +
      'segment for clients that cannot send headers), or restrict access another way.\n',
  );
}

/** Length-safe constant-time string comparison. */
function secretsEqual(presentedValue: string, expected: string): boolean {
  const presented = Buffer.from(presentedValue);
  const secret = Buffer.from(expected);
  if (presented.length !== secret.length) return false;
  return timingSafeEqual(presented, secret);
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
  return secretsEqual(token, expected);
}

/**
 * Does this request path address the MCP endpoint? In path-secret mode the
 * secret segment is checked in constant time here, so a correct path match *is*
 * the authorization; the base path (without the secret) deliberately does not
 * match, so it 404s like any unknown route and reveals nothing.
 */
export function matchesMcpEndpoint(pathname: string, basePath: string, secret: string): boolean {
  if (!secret) return pathname === basePath;
  const prefix = `${basePath}/`;
  if (!pathname.startsWith(prefix)) return false;
  return secretsEqual(pathname.slice(prefix.length), secret);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // In path-secret mode the caller already proved knowledge of the secret via
  // the URL (matchesMcpEndpoint), so the bearer header is not additionally
  // required — that's what lets a header-less client (ChatGPT "No auth")
  // connect. Otherwise fall back to the bearer gate.
  if (!pathSecret && !isAuthorized(req.headers.authorization, bearerToken)) {
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

  if (matchesMcpEndpoint(url.pathname, mcpBasePath, pathSecret)) {
    void handleMcp(req, res);
    return;
  }

  // Deliberately vague: in path-secret mode we must not confirm the base path
  // or leak the expected location of the secret endpoint.
  sendJson(res, 404, {
    jsonrpc: '2.0',
    error: { code: -32601, message: 'Not found' },
    id: null,
  });
});

// Only start listening when run as the entry point, so tests can import the
// pure helpers (isAuthorized) without binding a port.
if (process.env.COZI_MCP_HTTP_NO_LISTEN !== '1') {
  httpServer.listen(port, host, () => {
    // The secret segment is intentionally not logged; the path is shown as
    // `${base}/<secret>` so operators can see the shape without the value.
    const displayPath = pathSecret ? `${mcpBasePath}/<secret>` : mcpBasePath;
    const authMode = pathSecret
      ? 'path secret required'
      : bearerToken
        ? 'bearer token required'
        : 'OPEN';
    process.stderr.write(
      `Cozi MCP HTTP server (v${SERVER_VERSION}) listening on ${host}:${port}, ` +
        `MCP endpoint ${displayPath} — mode: ${readOnly ? 'read-only' : 'read-write'}, ` +
        `auth: ${authMode}.\n`,
    );
  });
}

export { httpServer };
