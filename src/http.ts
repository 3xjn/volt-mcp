import { timingSafeEqual } from "node:crypto"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { LiveBridge } from "./bridge.js"
import { createMcpServer } from "./tools.js"

const SESSION_HEADER = "mcp-session-id"

type McpSession = {
  readonly server: McpServer
  readonly transport: WebStandardStreamableHTTPServerTransport
}

export type HttpServerOptions = {
  readonly bridge: LiveBridge
  readonly token: string
  readonly port: number
}

export interface LiveMcpHttpServer {
  readonly port: number
  stop(): Promise<void>
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function isAuthorized(request: Request, token: string): boolean {
  const authorization = request.headers.get("authorization")
  if (authorization === null || !authorization.startsWith("Bearer ")) {
    return false
  }
  return tokenMatches(authorization.slice("Bearer ".length), token)
}

function jsonError(status: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code: -32_000, message }, id: null }, { status })
}

export function startHttpServer(options: HttpServerOptions): LiveMcpHttpServer {
  const sessions = new Map<string, McpSession>()

  async function createSession(request: Request): Promise<Response> {
    const server = createMcpServer(options.bridge)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized(sessionId) {
        sessions.set(sessionId, { server, transport })
      },
      onsessionclosed(sessionId) {
        sessions.delete(sessionId)
      },
    })
    await server.connect(transport)
    const response = await transport.handleRequest(request)
    if (transport.sessionId === undefined) {
      await server.close()
    }
    return response
  }

  const httpServer = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== "/mcp") {
        return new Response("Not found", { status: 404 })
      }
      if (!isAuthorized(request, options.token)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": "Bearer" },
        })
      }

      const sessionId = request.headers.get(SESSION_HEADER)
      if (sessionId !== null) {
        const session = sessions.get(sessionId)
        return session === undefined
          ? jsonError(404, "Session not found")
          : await session.transport.handleRequest(request)
      }
      if (request.method !== "POST") {
        return jsonError(400, "Missing MCP session ID")
      }
      return await createSession(request)
    },
  })
  const port = httpServer.port
  if (port === undefined) {
    throw new Error("Bun did not report the MCP HTTP port")
  }

  let stopped = false
  return {
    port,
    async stop() {
      if (stopped) {
        return
      }
      stopped = true
      for (const session of sessions.values()) {
        await session.server.close()
      }
      sessions.clear()
      await httpServer.stop(true)
    },
  }
}
