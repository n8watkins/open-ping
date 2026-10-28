import { Hono } from "hono";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import type { AppEnv } from "../types";
import { apiTokenIdentity } from "../middleware/auth";
import { countApiTokens } from "../db/api-tokens";
import { hitRateLimit } from "../db/rate-limit";
import { registerTools, type ToolContext } from "./tools";
import { requestWaitUntil } from "../routes/monitors";
import pkg from "../../../package.json";

/**
 * The MCP server at /mcp (Streamable HTTP, stateless).
 *
 * Every POST builds a fresh McpServer, answers one JSON-RPC message with a
 * plain JSON body and is done: no session, no SSE stream, no Durable Object,
 * so it runs on the Workers Free plan like the rest of OpenPing. Both protocol
 * generations are served: 2026-07-28 clients through the SDK's
 * createMcpHandler, and 2025 clients (initialize handshake) through a
 * stateless Streamable HTTP transport in JSON mode.
 *
 * Access is an admin API token only (Authorization: Bearer <token>): the
 * API_TOKEN secret or a token created under Developers, the same check as the
 * REST API. No cookies, no CORS: a browser page on another origin is refused
 * before authentication. With neither the secret nor a stored token the
 * endpoint does not exist (404). Tools call the same
 * validation and data functions as the REST routes (./tools.ts).
 */

/** Largest accepted request body; a create_monitor call is a few KB. */
export const MCP_MAX_BODY_BYTES = 256 * 1024;
/** Authenticated requests allowed per minute (one D1 write each). */
export const MCP_RATE_LIMIT_PER_MINUTE = 120;

const INSTRUCTIONS = [
  "OpenPing is a self-hosted uptime monitor. Call get_status first for an overview.",
  "Monitor, window and page ids come from the list_* tools.",
  "Times are ISO 8601 in the install's timezone. Credentials and heartbeat tokens are never readable; a heartbeat ping URL is shown only when the monitor is created or its token rotated.",
  "Tools marked destructive need confirm: true; set it only after the user explicitly agrees.",
].join(" ");

/** A fresh server with every OpenPing tool, for one request. */
export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: "openping", title: "OpenPing", version: pkg.version },
    { instructions: INSTRUCTIONS, maxToolInputElements: 2000 },
  );
  registerTools(server, ctx);
  return server;
}

function jsonRpcError(status: number, code: number, message: string, headers?: HeadersInit): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Serve one authenticated MCP request (both protocol generations, JSON only). */
export async function serveMcp(request: Request, ctx: ToolContext): Promise<Response> {
  const factory = () => buildMcpServer(ctx);
  if (await isLegacyRequest(request, undefined, { maxRequestBodySize: MCP_MAX_BODY_BYTES })) {
    // Stateless 2025 Streamable HTTP: there is no session to stream (GET) or
    // end (DELETE).
    if (request.method !== "POST") {
      return jsonRpcError(405, -32000, "Method not allowed: this MCP server is stateless, POST only.", {
        allow: "POST",
      });
    }
    const server = factory();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  }
  const handler = createMcpHandler(factory, {
    legacy: "reject",
    responseMode: "json",
    keepAliveMs: 0,
    maxRequestBodySize: MCP_MAX_BODY_BYTES,
  });
  try {
    return await handler.fetch(request);
  } finally {
    await handler.close().catch(() => {});
  }
}

/** The /mcp route: availability, origin, bearer auth and rate limit, then MCP. */
export const mcp = new Hono<AppEnv>();

mcp.all("/", async (c) => {
  const authorization = c.req.header("authorization");
  const who = await apiTokenIdentity(c.env, authorization);
  // Off until there is a token to use: the secret, or one made under Developers.
  if (!who && !c.env.API_TOKEN && (await countApiTokens(c.env)) === 0) {
    return c.json(
      {
        error: "mcp_disabled",
        message:
          "The MCP server is off on this install. Create an API token under Developers, or set the API_TOKEN Worker secret, to turn it on (see docs/MCP.md).",
      },
      404,
    );
  }

  const selfOrigin = new URL(c.req.url).origin;
  // MCP clients are not browsers and send no Origin. A browser page on another
  // site (or a DNS-rebinding page) does, and is refused outright. No CORS
  // headers are ever sent, so a cross-origin page cannot read a response.
  const origin = c.req.header("origin");
  if (origin && origin !== selfOrigin) {
    return c.json({ error: "forbidden_origin", message: "Cross-origin requests to /mcp are not allowed." }, 403);
  }

  if (!who) {
    c.header(
      "WWW-Authenticate",
      authorization ? 'Bearer realm="OpenPing", error="invalid_token"' : 'Bearer realm="OpenPing"',
    );
    return c.json(
      {
        error: "unauthorized",
        message: "Send Authorization: Bearer <token>, an API token from Developers or the API_TOKEN Worker secret.",
      },
      401,
    );
  }

  // Only authenticated requests reach the limiter, so an anonymous flood never
  // costs a D1 write; a runaway client loop is capped here.
  if (c.req.method === "POST") {
    const limit = await hitRateLimit(c.env, "mcp:api-token", MCP_RATE_LIMIT_PER_MINUTE);
    if (!limit.allowed) {
      return jsonRpcError(429, -32000, `Rate limit: at most ${MCP_RATE_LIMIT_PER_MINUTE} MCP requests a minute.`, {
        "retry-after": String(limit.retryAfterSeconds),
      });
    }
  }

  return serveMcp(c.req.raw, { env: c.env, origin: selfOrigin, waitUntil: requestWaitUntil(c) });
});
