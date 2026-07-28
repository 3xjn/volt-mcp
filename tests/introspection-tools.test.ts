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
}

const requests: CapturedRequest[] = []
const openClients: Client[] = []

const bridge: LiveBridge = {
  port: 0,
  async request(method, params) {
    requests.push({ method, params })
    return { accepted: true }
  },
  status() {
    return { connected: true }
  },
  async stop() {},
}

async function openClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer(bridge)
  const client = new Client({ name: "hydroxide-introspection-test", version: "0.1.0" })
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
      },
    },
  ])
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

test("keeps whole-corpus decompilation out of the synchronous search path", () => {
  const agentSource = readFileSync(new URL("../volt-agent.lua", import.meta.url), "utf8")
  const searchStart = agentSource.indexOf("function handlers.searchScripts(params)")
  const searchEnd = agentSource.indexOf("function handlers.readScript(params)", searchStart)
  const searchHandler = agentSource.slice(searchStart, searchEnd)

  expect(searchHandler).toContain("getIndexedSource(entry, false)")
  expect(searchHandler).not.toContain("getIndexedSource(entry, true)")
  expect(agentSource).toContain("MAX_INDEX_SOURCE_BYTES")
  expect(agentSource).toContain("INDEX_DECOMPILE_DELAY_SECONDS")
})
