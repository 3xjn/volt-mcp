import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { startVoltMcpDaemon, type VoltMcpDaemon } from "../src/daemon.js"
import { loadDaemonState } from "../src/state.js"

const responseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number(),
  result: z.unknown(),
})

const initializeResultSchema = z.object({
  serverInfo: z.object({
    name: z.literal("volt-mcp"),
    title: z.literal("Volt MCP for Roblox"),
  }),
})

const toolsResultSchema = z.object({
  tools: z.array(z.object({ name: z.string() })),
})
const toolCallResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
})

let daemon: VoltMcpDaemon | undefined
let agentSocket: WebSocket | undefined
let temporaryDirectory: string | undefined
let spawnedEndpoint: string | undefined
let spawnedClientToken: string | undefined

function waitForOpen(client: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    client.addEventListener("open", () => resolve(), { once: true })
    client.addEventListener("error", () => reject(new Error("Agent failed to connect")), {
      once: true,
    })
  })
}

function waitForMessage(client: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    client.addEventListener(
      "message",
      (event) => {
        if (typeof event.data !== "string") {
          reject(new Error("Expected text from agent socket"))
          return
        }
        resolve(z.record(z.string(), z.unknown()).parse(JSON.parse(event.data)))
      },
      { once: true },
    )
  })
}

async function expectNoMessage(client: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const listener = () => {
      clearTimeout(timeout)
      client.removeEventListener("message", listener)
      reject(new Error("Pairing dialog was triggered before MCP presentation"))
    }
    const timeout = setTimeout(() => {
      client.removeEventListener("message", listener)
      resolve()
    }, 25)
    client.addEventListener("message", listener)
  })
}

async function runProxy(
  messages: readonly Record<string, unknown>[],
  environment: Readonly<Record<string, string>>,
): Promise<z.infer<typeof responseSchema>[]> {
  const child = Bun.spawn({
    cmd: ["bun", "run", "./scripts/mcp.ts"],
    cwd: import.meta.dir.replace(/[\\/]tests$/, ""),
    env: { ...process.env, ...environment },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  child.stdin.write(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`)
  child.stdin.end()
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exitCode, stderr).toBe(0)
  return stdout
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => responseSchema.parse(JSON.parse(line)))
}

function initializeMessage(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "volt-mcp-plugin-test", version: "0.1.0" },
    },
  }
}

afterEach(async () => {
  agentSocket?.close()
  await daemon?.stop()
  if (spawnedEndpoint !== undefined && spawnedClientToken !== undefined) {
    await fetch(`${spawnedEndpoint.replace(/\/mcp$/, "")}/admin/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${spawnedClientToken}` },
    }).catch(() => undefined)
  }
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
  daemon = undefined
  agentSocket = undefined
  temporaryDirectory = undefined
  spawnedEndpoint = undefined
  spawnedClientToken = undefined
})

test("starts in setup mode when local daemon state is unavailable", async () => {
  // Given an installed client adapter before product-neutral setup has run
  const messages = [initializeMessage(1), { jsonrpc: "2.0", id: 2, method: "tools/list" }]

  // When any stdio MCP client starts the bundled adapter
  const responses = await runProxy(messages, {
    VOLT_MCP_STATE_PATH: join(import.meta.dir, "missing-state.json"),
    VOLT_MCP_ENDPOINT: "http://127.0.0.1:1/mcp",
  })

  // Then plugin initialization succeeds and exposes no unsafe placeholder tools
  expect(initializeResultSchema.parse(responses[0]?.result).serverInfo.title).toBe(
    "Volt MCP for Roblox",
  )
  expect(toolsResultSchema.parse(responses[1]?.result).tools).toEqual([])
})

test("relays MCP-initiated pairing before presenting it to Roblox", async () => {
  // Given generic setup has created local state and the persistent daemon is running
  temporaryDirectory = await mkdtemp(join(tmpdir(), "volt-mcp-adapter-"))
  const statePath = join(temporaryDirectory, "state.json")
  const state = await loadDaemonState(statePath)
  daemon = await startVoltMcpDaemon({ state, voltPort: 0, mcpPort: 0 })
  agentSocket = new WebSocket(`ws://127.0.0.1:${daemon.voltPort}/volt`)
  await waitForOpen(agentSocket)
  agentSocket.send(
    JSON.stringify({
      type: "pair_request",
      agent: {
        agentVersion: "adapter-test",
        gameId: 55,
        placeId: 66,
        jobId: "adapter-job",
        playerName: "Builder",
        userId: 77,
      },
    }),
  )
  await Bun.sleep(20)
  await expectNoMessage(agentSocket)
  const messages = [
    initializeMessage(1),
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "roblox_prepare_pairing", arguments: {} },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "roblox_status", arguments: {} },
    },
  ]

  // When an editor starts the adapter without owning a client secret
  const responses = await runProxy(messages, {
    VOLT_MCP_STATE_PATH: statePath,
    VOLT_MCP_ENDPOINT: `http://127.0.0.1:${daemon.mcpPort}/mcp`,
  })

  // Then the bridge's real Roblox tools are discoverable
  const toolNames = toolsResultSchema.parse(responses[1]?.result).tools.map(({ name }) => name)
  expect(toolNames).toContain("roblox_status")
  expect(toolNames).toContain("roblox_prepare_pairing")
  expect(toolNames).toContain("roblox_present_pairing")
  expect(toolNames).toContain("roblox_search_scripts")
  const preparedResult = toolCallResultSchema.parse(responses[2]?.result)
  const statusResult = toolCallResultSchema.parse(responses[3]?.result)
  const prepared = z
    .object({
      state: z.literal("challenge_ready"),
      challenge: z.object({
        challengeId: z.uuid(),
        verificationCode: z.string().regex(/^\d{6}$/),
        expiresAt: z.iso.datetime(),
        approvalState: z.literal("ready_to_present"),
        pendingRobloxSession: z.object({
          playerName: z.literal("Builder"),
          gameId: z.literal(55),
          placeId: z.literal(66),
          jobId: z.literal("adapter-job"),
        }),
        daemon: z.object({
          identity: z.literal("local_volt_mcp_daemon"),
          endpoint: z.literal(`ws://127.0.0.1:${daemon.voltPort}/volt`),
        }),
        authorization: z.object({
          codePurpose: z.literal("correlation_only"),
          approvalAuthority: z.literal("volt_messagebox_yes"),
          persistence: z.literal("until_pairing_reset"),
        }),
        nextAction: z.string().min(1),
      }),
    })
    .parse(JSON.parse(preparedResult.content[0]?.text ?? ""))
  expect(JSON.parse(statusResult.content[0]?.text ?? "")).toEqual(
    JSON.parse(preparedResult.content[0]?.text ?? ""),
  )
  await expectNoMessage(agentSocket)

  // When a later explicit MCP call presents that exact challenge
  const dialogChallenge = waitForMessage(agentSocket)
  const presentation = runProxy(
    [
      initializeMessage(10),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "roblox_present_pairing",
          arguments: { challengeId: prepared.challenge.challengeId },
        },
      },
    ],
    {
      VOLT_MCP_STATE_PATH: statePath,
      VOLT_MCP_ENDPOINT: `http://127.0.0.1:${daemon.mcpPort}/mcp`,
    },
  )
  expect(await dialogChallenge).toMatchObject({
    type: "pair_challenge",
    challengeId: prepared.challenge.challengeId,
    code: prepared.challenge.verificationCode,
  })
  const presentedResult = toolCallResultSchema.parse((await presentation)[1]?.result)
  expect(JSON.parse(presentedResult.content[0]?.text ?? "")).toMatchObject({
    accepted: true,
    state: "awaiting_user_approval",
    challenge: { challengeId: prepared.challenge.challengeId },
  })
})

test("starts the installed daemon and leaves it available after the adapter exits", async () => {
  // Given setup state points at an installed runtime but no daemon is running
  temporaryDirectory = await mkdtemp(join(tmpdir(), "volt-mcp-autostart-"))
  const statePath = join(temporaryDirectory, "state.json")
  const state = await loadDaemonState(statePath)
  const repositoryRoot = import.meta.dir.replace(/[\\/]tests$/, "")
  await state.setRuntimeRoot(repositoryRoot)
  const voltPort = await reservePort()
  const mcpPort = await reservePort()
  spawnedEndpoint = `http://127.0.0.1:${mcpPort}/mcp`
  spawnedClientToken = state.clientToken

  // When an MCP client initializes through the adapter
  const responses = await runProxy(
    [initializeMessage(1), { jsonrpc: "2.0", id: 2, method: "tools/list" }],
    {
      VOLT_MCP_STATE_PATH: statePath,
      VOLT_MCP_ENDPOINT: spawnedEndpoint,
      VOLT_MCP_VOLT_PORT: String(voltPort),
      VOLT_MCP_HTTP_PORT: String(mcpPort),
    },
  )

  // Then tools are relayed and the detached daemon remains reachable after stdio closes
  expect(toolsResultSchema.parse(responses[1]?.result).tools.length).toBeGreaterThan(0)
  await Bun.sleep(100)
  const unauthorized = await fetch(spawnedEndpoint, { method: "POST" })
  expect(unauthorized.status).toBe(401)
})

async function reservePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = server.port
  await server.stop(true)
  if (port === undefined) {
    throw new Error("Bun did not allocate a test port")
  }
  return port
}
