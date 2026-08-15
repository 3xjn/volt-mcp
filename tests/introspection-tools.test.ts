import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { LiveBridge } from "../src/bridge.js"
import type { RequestMethod } from "../src/protocol.js"
import { createMcpServer } from "../src/tools.js"

type CapturedRequest = {
  readonly method: RequestMethod
  readonly params: Readonly<Record<string, unknown>>
  readonly client?: string
}

const requests: CapturedRequest[] = []
const openClients: Client[] = []

const bridge: LiveBridge = {
  port: 0,
  listClients() {
    return []
  },
  async request(method, params, _timeoutMs, client) {
    requests.push({ method, params, ...(client === undefined ? {} : { client }) })
    return { accepted: true }
  },
  status() {
    return {
      state: "connected",
      paired: true,
      connected: true,
      agent: {
        agentVersion: "test",
        gameId: 0,
        placeId: 0,
        jobId: "",
        playerName: "",
        userId: 0,
      },
    }
  },
  preparePairing() {
    return { state: "unpaired", paired: false, connected: false }
  },
  presentPairing() {
    return { accepted: false, reason: "challenge_not_current" }
  },
  async stop() {},
}

async function openClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer(bridge)
  const client = new Client({ name: "volt-mcp-introspection-test", version: "0.1.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  openClients.push(client)
  return client
}

afterEach(async () => {
  requests.length = 0
  await Promise.all(openClients.splice(0).map((client) => client.close()))
})

test("forwards an Actor target when searching indexed script text", async () => {
  // Given
  const client = await openClient()
  const target = { kind: "actor", path: 'workspace["Actors"]["Camera"]' } as const

  // When
  await client.callTool({
    name: "roblox_search_scripts",
    arguments: {
      query: "camera smoothing",
      target,
      scope: "all",
      limit: 5,
      contextLines: 2,
      maxSnippets: 3,
      refresh: false,
    },
  })

  // Then
  expect(requests).toEqual([
    {
      method: "searchScripts",
      params: {
        query: "camera smoothing",
        target,
        scope: "all",
        limit: 5,
        contextLines: 2,
        maxSnippets: 3,
        refresh: false,
        includeOtherPlayers: false,
      },
    },
  ])
})

test("forwards the opt-in for scripts under other players", async () => {
  // Given
  const client = await openClient()

  // When
  await client.callTool({
    name: "roblox_list_scripts",
    arguments: {
      query: "PlayerScripts",
      includeOtherPlayers: true,
    },
  })

  // Then
  expect(requests).toEqual([
    {
      method: "listScripts",
      params: {
        query: "PlayerScripts",
        scope: "all",
        limit: 200,
        target: { kind: "game" },
        includeOtherPlayers: true,
      },
    },
  ])
})

test("keeps running and loaded scripts exempt from other-player filtering", () => {
  // Given
  const agentSource = readFileSync(new URL("../volt-agent.lua", import.meta.url), "utf8")

  // When
  const collectStart = agentSource.indexOf("local function collectScripts(")
  const collectEnd = agentSource.indexOf("\nlocal scriptIndex", collectStart)
  const collector = agentSource.slice(collectStart, collectEnd)

  // Then
  expect(collector).toContain("activeScripts[instance]")
  expect(collector).toContain("includeOtherPlayers")
  expect(collector).toContain("otherPlayer ~= nil and otherPlayer ~= Players.LocalPlayer")
})

test("forwards a Lua-state target when inspecting a discovered runtime closure", async () => {
  // Given
  const client = await openClient()
  const target = { kind: "state", id: 42 } as const

  // When
  await client.callTool({
    name: "roblox_inspect_closure",
    arguments: {
      path: 'game:GetService("Players")["Builder"]["PlayerScripts"]["Camera"]',
      target,
      closureId: "closure-42",
      prototypePath: [],
    },
  })

  // Then
  expect(requests).toEqual([
    {
      method: "inspectClosure",
      params: {
        path: 'game:GetService("Players")["Builder"]["PlayerScripts"]["Camera"]',
        target,
        closureId: "closure-42",
        prototypePath: [],
      },
    },
  ])
})

test("bounds closure previews before sending an agent response", () => {
  // Given closure upvalues can contain multi-megabyte runtime tables
  const agentSource = readFileSync(new URL("../volt-agent.lua", import.meta.url), "utf8")

  // When the agent builds summaries, selected details, and the websocket response
  const summaryStart = agentSource.indexOf("local function summarizeRuntimeClosure(")
  const summaryEnd = agentSource.indexOf("\nlocal function collectBytecodeConstants(", summaryStart)
  const summarySource = agentSource.slice(summaryStart, summaryEnd)
  const inspectStart = agentSource.indexOf("function handlers.inspectClosure(params)")
  const inspectEnd = agentSource.indexOf("\nfunction handlers.mutateClosure(params)", inspectStart)
  const inspectSource = agentSource.slice(inspectStart, inspectEnd)
  const respondStart = agentSource.indexOf("local function respond(id, succeeded, value)")
  const respondEnd = agentSource.indexOf("\nlocal function handleMessage(", respondStart)
  const respondSource = agentSource.slice(respondStart, respondEnd)

  // Then previews stay shallow and every successful result is size-checked before socket send
  expect(agentSource).toContain("local MAX_AGENT_RESULT_BYTES = 1536 * 1024")
  expect(agentSource).toContain("local function serializeClosureValue(value, depth)")
  expect(summarySource).toContain("value = serializeClosureValue(value, 1)")
  expect(inspectSource).toContain("value = serializeClosureValue(value, 0)")
  expect(inspectSource).not.toContain("value = serialize(value, 0, {})")
  expect(respondSource).toContain("#encodedValue > MAX_AGENT_RESULT_BYTES")
  expect(respondSource).toContain("Response exceeded the safe %d-byte limit")
})

test("uses compare-before-set inputs for a reversible primitive mutation", async () => {
  // Given
  const client = await openClient()

  // When
  await client.callTool({
    name: "roblox_mutate_closure",
    arguments: {
      path: 'workspace["Runtime"]["Controller"]',
      closureId: "closure-123",
      kind: "constant",
      index: 4,
      expected: 10,
      value: 11,
    },
  })

  // Then
  expect(requests).toEqual([
    {
      method: "mutateClosure",
      params: {
        path: 'workspace["Runtime"]["Controller"]',
        closureId: "closure-123",
        target: { kind: "game" },
        prototypePath: [],
        kind: "constant",
        index: 4,
        expected: 10,
        value: 11,
      },
    },
  ])
})

test("forwards the target and mutation ID when restoring a mutation", async () => {
  // Given
  const client = await openClient()
  const target = { kind: "actor", path: 'workspace["Workers"]["AI"]' } as const

  // When
  await client.callTool({
    name: "roblox_restore_mutation",
    arguments: { mutationId: "mutation-123", target },
  })

  // Then
  expect(requests).toEqual([
    {
      method: "restoreMutation",
      params: { mutationId: "mutation-123", target },
    },
  ])
})

test("adds an explicit default game target to existing runtime tools", async () => {
  // Given
  const client = await openClient()

  // When
  await client.callTool({
    name: "roblox_eval",
    arguments: { code: "return true", chunkName: "target contract" },
  })

  // Then
  expect(requests).toEqual([
    {
      method: "eval",
      params: {
        code: "return true",
        chunkName: "target contract",
        target: { kind: "game" },
      },
    },
  ])
})

test("routes a client selector separately from the Lua-state target", async () => {
  // Given two independent selectors identify the Roblox client and its Lua state
  const client = await openClient()
  const clientId = "123e4567-e89b-42d3-a456-426614174000"
  const target = { kind: "actor", path: 'workspace["Actors"]["Camera"]' } as const

  // When
  await client.callTool({
    name: "roblox_eval",
    arguments: { code: "return true", client: clientId, target },
  })

  // Then the client ID addresses the bridge and never enters the Luau request params
  expect(requests).toEqual([
    {
      method: "eval",
      client: clientId,
      params: { code: "return true", chunkName: "Volt MCP", target },
    },
  ])
})

test("keeps native decompilation out of startup, idle, and search paths", () => {
  const agentSource = readFileSync(new URL("../volt-agent.lua", import.meta.url), "utf8")
  const maintenanceStart = agentSource.indexOf("local function startIndexMaintenance()")
  const maintenanceEnd = agentSource.indexOf("local function send(payload)", maintenanceStart)
  const maintenance = agentSource.slice(maintenanceStart, maintenanceEnd)
  const searchStart = agentSource.indexOf("function handlers.searchScripts(params)")
  const searchEnd = agentSource.indexOf("function handlers.readScript(params)", searchStart)
  const searchHandler = agentSource.slice(searchStart, searchEnd)

  expect(maintenance).not.toContain("getIndexedSource")
  expect(maintenance).not.toContain("decompile")
  expect(searchHandler).toContain("getIndexedSource(entry, false)")
  expect(searchHandler).not.toContain("getIndexedSource(entry, true)")
  expect(agentSource).toContain("MAX_INDEX_SOURCE_BYTES")
  expect(agentSource).not.toContain("INDEX_DECOMPILE_DELAY_SECONDS")
  expect(agentSource.match(/pcall\(decompile/g)).toHaveLength(1)
})
