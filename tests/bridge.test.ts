import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRIDGE_PATH, type LiveBridge, startBridge } from "../src/bridge.js"
import { BridgeTimeoutError, BridgeUnavailableError } from "../src/errors.js"
import { type AgentInfo, requestMessageSchema, responseMessageSchema } from "../src/protocol.js"

const TOKEN = "0123456789abcdef0123456789abcdef"
const AGENT: AgentInfo = {
  agentVersion: "test",
  placeId: 123,
  jobId: "job",
  playerName: "Builder",
  userId: 456,
}

let bridge: LiveBridge | undefined
let socket: WebSocket | undefined

class TestHarnessError extends Error {
  readonly name = "TestHarnessError"
}

function waitForOpen(client: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    client.addEventListener("open", () => resolve(), { once: true })
    client.addEventListener(
      "error",
      () => reject(new TestHarnessError("WebSocket failed to open")),
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
          reject(new TestHarnessError("Expected a text frame"))
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

async function openAgent(): Promise<WebSocket> {
  if (bridge === undefined) {
    throw new TestHarnessError("Bridge was not started")
  }
  const client = new WebSocket(`ws://127.0.0.1:${bridge.port}${BRIDGE_PATH}`)
  await waitForOpen(client)
  return client
}

afterEach(async () => {
  await bridge?.stop()
  socket?.close()
  socket = undefined
  bridge = undefined
})

describe("live bridge", () => {
  test("rejects requests without an authenticated live client", async () => {
    bridge = startBridge({ token: TOKEN, port: 0 })
    expect(bridge.status()).toEqual({ connected: false })
    await expect(bridge.request("listScripts", {})).rejects.toBeInstanceOf(BridgeUnavailableError)
  })

  test("authenticates an agent and correlates a response", async () => {
    bridge = startBridge({ token: TOKEN, port: 0 })
    socket = await openAgent()
    const ready = waitForMessage(socket)
    socket.send(JSON.stringify({ type: "hello", token: TOKEN, agent: AGENT }))
    expect(await ready).toEqual({ type: "ready" })
    expect(bridge.status()).toEqual({
      connected: true,
      agent: { ...AGENT, transport: "websocket" },
    })

    const requestReceived = waitForMessage(socket)
    const pendingResult = bridge.request("listScripts", { query: "door" })
    const request = requestMessageSchema.parse(await requestReceived)
    expect(request.method).toBe("listScripts")
    socket.send(
      JSON.stringify(
        responseMessageSchema.parse({
          type: "response",
          id: request.id,
          ok: true,
          result: { scripts: [], total: 0, returned: 0 },
        }),
      ),
    )

    await expect(pendingResult).resolves.toEqual({ scripts: [], total: 0, returned: 0 })
  })

  test("times out a request that the agent does not answer", async () => {
    bridge = startBridge({ token: TOKEN, port: 0 })
    socket = await openAgent()
    const ready = waitForMessage(socket)
    socket.send(JSON.stringify({ type: "hello", token: TOKEN, agent: AGENT }))
    await ready
    await expect(bridge.request("listScripts", {}, 10)).rejects.toBeInstanceOf(BridgeTimeoutError)
  })

  test("does not accept an incorrect token", async () => {
    bridge = startBridge({ token: TOKEN, port: 0 })
    socket = await openAgent()
    socket.send(
      JSON.stringify({
        type: "hello",
        token: "fedcba9876543210fedcba9876543210",
        agent: AGENT,
      }),
    )
    await Bun.sleep(20)
    expect(bridge.status()).toEqual({ connected: false })
    expect(socket.readyState).not.toBe(WebSocket.OPEN)
  })

  test("authenticates over HTTP poll and correlates a response", async () => {
    bridge = startBridge({ token: TOKEN, port: 0 })
    const endpoint = `http://127.0.0.1:${bridge.port}/live/poll`
    const hello = await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ type: "hello", token: TOKEN, agent: AGENT }),
    })
    expect(hello.status).toBe(200)
    expect(await hello.json()).toEqual({ type: "ready" })
    expect(bridge.status()).toMatchObject({
      connected: true,
      agent: { ...AGENT, transport: "http" },
    })

    const pendingResult = bridge.request("listScripts", { query: "door" })
    const poll = await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ type: "poll", token: TOKEN }),
    })
    const request = requestMessageSchema.parse(await poll.json())
    expect(request.method).toBe("listScripts")
    const answered = await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({
        type: "response",
        token: TOKEN,
        id: request.id,
        ok: true,
        result: { scripts: [], total: 0, returned: 0 },
      }),
    })
    expect(await answered.json()).toEqual({ type: "ack" })
    await expect(pendingResult).resolves.toEqual({ scripts: [], total: 0, returned: 0 })
  })

  test("rejects HTTP poll with an incorrect token", async () => {
    bridge = startBridge({ token: TOKEN, port: 0 })
    const response = await fetch(`http://127.0.0.1:${bridge.port}/live/poll`, {
      method: "POST",
      body: JSON.stringify({
        type: "hello",
        token: "fedcba9876543210fedcba9876543210",
        agent: AGENT,
      }),
    })
    expect(response.status).toBe(401)
    expect(bridge.status()).toEqual({ connected: false })
  })

  test("authenticates over file poll and correlates a response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "live-mcp-file-"))
    try {
      bridge = startBridge({ token: TOKEN, port: 0, filePollDir: directory })
      await writeFile(
        join(directory, "to-host.json"),
        JSON.stringify({ type: "hello", token: TOKEN, agent: AGENT }),
      )
      let ready: unknown
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          ready = JSON.parse(await readFile(join(directory, "to-agent.json"), "utf8"))
          break
        } catch {
          await Bun.sleep(50)
        }
      }
      expect(ready).toEqual({ type: "ready" })
      expect(bridge.status()).toMatchObject({
        connected: true,
        agent: { ...AGENT, transport: "file" },
      })

      const pendingResult = bridge.request("listScripts", { query: "door" })
      let request: ReturnType<typeof requestMessageSchema.parse> | undefined
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const payload: unknown = JSON.parse(
          await readFile(join(directory, "to-agent.json"), "utf8"),
        )
        if (
          typeof payload === "object" &&
          payload !== null &&
          "type" in payload &&
          payload.type === "request"
        ) {
          request = requestMessageSchema.parse(payload)
          break
        }
        await Bun.sleep(50)
      }
      if (request === undefined) {
        throw new TestHarnessError("File poll did not deliver a request")
      }
      expect(request.method).toBe("listScripts")
      await writeFile(
        join(directory, "to-host.json"),
        JSON.stringify({
          type: "response",
          token: TOKEN,
          id: request.id,
          ok: true,
          result: { scripts: [], total: 0, returned: 0 },
        }),
      )
      await expect(pendingResult).resolves.toEqual({ scripts: [], total: 0, returned: 0 })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
