import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { z } from "zod"
import { requestMessageSchema } from "../src/protocol.js"

const TOKEN = "abcdef0123456789abcdef0123456789"

class IntegrationHarnessError extends Error {
  readonly name = "IntegrationHarnessError"
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener(
      "error",
      () => reject(new IntegrationHarnessError("Volt peer failed to connect")),
      { once: true },
    )
  })
}

function waitForMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.addEventListener(
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

async function getUnusedPort(): Promise<number> {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") })
  const port = reservation.port
  await reservation.stop(true)
  if (port === undefined) {
    throw new IntegrationHarnessError("Bun did not allocate a port")
  }
  return port
}

function childEnvironment(port: number): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[key] = value
    }
  }
  environment["HYDROXIDE_MCP_TOKEN"] = TOKEN
  environment["HYDROXIDE_MCP_PORT"] = String(port)
  return environment
}

test("serves a live Volt response through the stdio MCP transport", async () => {
  const port = await getUnusedPort()
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", "src/index.ts"],
    cwd: import.meta.dir.replace(/[\\/]tests$/, ""),
    env: childEnvironment(port),
    stderr: "pipe",
  })
  const client = new Client({ name: "hydroxide-live-test", version: "0.1.0" })
  let socket: WebSocket | undefined

  try {
    await client.connect(transport)
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

    const requestReceived = waitForMessage(socket)
    const toolResult = client.callTool({
      name: "roblox_list_scripts",
      arguments: { query: "door", scope: "all", limit: 20 },
    })
    const request = requestMessageSchema.parse(await requestReceived)
    expect(request.method).toBe("listScripts")
    socket.send(
      JSON.stringify({
        type: "response",
        id: request.id,
        ok: true,
        result: {
          scripts: [
            {
              name: "DoorManager",
              className: "LocalScript",
              path: 'game:GetService("Players")["Builder"]["PlayerScripts"]["DoorManager"]',
            },
          ],
          total: 1,
          returned: 1,
          scope: "all",
          query: "door",
        },
      }),
    )

    const parsed = z
      .object({
        content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
      })
      .parse(await toolResult)
    expect(parsed.content[0]?.text).toContain("DoorManager")
  } finally {
    socket?.close()
    await client.close()
  }
})
