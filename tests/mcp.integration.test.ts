import { afterEach, expect, test } from "bun:test"
import { z } from "zod"
import { startVoltMcpDaemon, type VoltMcpDaemon } from "../src/daemon.js"
import { requestMessageSchema } from "../src/protocol.js"

const TOKEN = "abcdef0123456789abcdef0123456789"

class IntegrationHarnessError extends Error {
  readonly name = "IntegrationHarnessError"
}

let daemon: VoltMcpDaemon | undefined
let socket: WebSocket | undefined

type TestClient = {
  readonly endpoint: string
  readonly sessionId: string
  nextRequestId: number
}

const clients: TestClient[] = []

function waitForOpen(client: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    client.addEventListener("open", () => resolve(), { once: true })
    client.addEventListener(
      "error",
      () => reject(new IntegrationHarnessError("Volt peer failed to connect")),
      { once: true },
    )
  })
}

function waitForMessage(client: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    client.addEventListener(
      "message",
      (event) => {
        if (typeof event.data !== "string") {
          reject(new IntegrationHarnessError("Expected a text frame"))
          return
        }
        try {
          resolve(JSON.parse(event.data))
        } catch (error) {
          if (error instanceof SyntaxError) {
            reject(error)
            return
          }
          throw error
        }
      },
      { once: true },
    )
  })
}

function headers(sessionId?: string): Record<string, string> {
  return {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    ...(sessionId === undefined ? {} : { "Mcp-Session-Id": sessionId }),
  }
}

async function createClient(name: string, port: number): Promise<TestClient> {
  const endpoint = `http://127.0.0.1:${port}/mcp`
  const response = await fetch(endpoint, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name, version: "0.1.0" },
      },
    }),
  })
  expect(response.status).toBe(200)
  const sessionId = response.headers.get("mcp-session-id")
  if (sessionId === null) {
    throw new IntegrationHarnessError("MCP server did not initialize a session")
  }
  const client = { endpoint, sessionId, nextRequestId: 2 }
  clients.push(client)
  const initialized = await fetch(endpoint, {
    method: "POST",
    headers: headers(sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  })
  expect(initialized.status).toBe(202)
  return client
}

async function authenticateVolt(port: number): Promise<void> {
  socket = new WebSocket(`ws://127.0.0.1:${port}/volt`)
  await waitForOpen(socket)
  const ready = waitForMessage(socket)
  socket.send(
    JSON.stringify({
      type: "hello",
      token: TOKEN,
      agent: {
        agentVersion: "integration",
        placeId: 321,
        jobId: "integration-job",
        playerName: "Builder",
        userId: 654,
      },
    }),
  )
  expect(await ready).toEqual({ type: "ready" })
}

async function answerListScripts(client: TestClient, expectedQuery: string): Promise<void> {
  if (socket === undefined) {
    throw new IntegrationHarnessError("Volt peer is not connected")
  }
  const requestReceived = waitForMessage(socket)
  const requestId = client.nextRequestId
  client.nextRequestId += 1
  const toolResult = fetch(client.endpoint, {
    method: "POST",
    headers: headers(client.sessionId),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: {
        name: "roblox_list_scripts",
        arguments: { query: expectedQuery, scope: "all", limit: 20 },
      },
    }),
  })
  const request = requestMessageSchema.parse(await requestReceived)
  expect(request.method).toBe("listScripts")
  const { query } = request.params
  expect(query).toBe(expectedQuery)
  socket.send(
    JSON.stringify({
      type: "response",
      id: request.id,
      ok: true,
      result: {
        scripts: [
          { name: `${expectedQuery}Manager`, className: "LocalScript", path: expectedQuery },
        ],
        total: 1,
        returned: 1,
        scope: "all",
        query: expectedQuery,
      },
    }),
  )
  const parsed = z
    .object({
      result: z.object({
        content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
      }),
    })
    .parse(await (await toolResult).json())
  expect(parsed.result.content[0]?.text).toContain(`${expectedQuery}Manager`)
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await fetch(client.endpoint, {
      method: "DELETE",
      headers: headers(client.sessionId),
    })
  }
  socket?.close()
  socket = undefined
  await daemon?.stop()
  daemon = undefined
})

test("shares one authenticated Volt bridge across two HTTP MCP clients", async () => {
  daemon = await startVoltMcpDaemon({ token: TOKEN, voltPort: 0, mcpPort: 0 })
  const endpoint = `http://127.0.0.1:${daemon.mcpPort}/mcp`
  const unauthorized = await fetch(endpoint, { method: "POST" })
  expect(unauthorized.status).toBe(401)

  const [first, second] = await Promise.all([
    createClient("volt-mcp-test-a", daemon.mcpPort),
    createClient("volt-mcp-test-b", daemon.mcpPort),
  ])
  await authenticateVolt(daemon.voltPort)

  await answerListScripts(first, "Door")
  await answerListScripts(second, "Weapon")
})

test("releases both listeners when the daemon stops", async () => {
  daemon = await startVoltMcpDaemon({ token: TOKEN, voltPort: 0, mcpPort: 0 })
  const voltPort = daemon.voltPort
  const mcpPort = daemon.mcpPort
  await daemon.stop()
  daemon = undefined

  const voltReplacement = Bun.serve({
    hostname: "127.0.0.1",
    port: voltPort,
    fetch: () => new Response("volt"),
  })
  const mcpReplacement = Bun.serve({
    hostname: "127.0.0.1",
    port: mcpPort,
    fetch: () => new Response("mcp"),
  })
  await Promise.all([voltReplacement.stop(true), mcpReplacement.stop(true)])
})
