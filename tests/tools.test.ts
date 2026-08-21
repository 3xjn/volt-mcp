import { afterEach, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { LiveBridge } from "../src/bridge.js"
import type { RequestMethod } from "../src/protocol.js"
import { createMcpServer } from "../src/tools.js"

const TOOL_NAMES = [
  "roblox_list_instances",
  "roblox_list_scripts",
  "roblox_read_source",
  "roblox_eval",
] as const

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
    return { connected: false }
  },
  async stop() {},
}

async function openClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer(bridge)
  const client = new Client({ name: "live-mcp-tools-test", version: "0.1.1" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  openClients.push(client)
  return client
}

afterEach(async () => {
  requests.length = 0
  await Promise.all(openClients.splice(0).map((client) => client.close()))
})

test("advertises the four inspect tools", async () => {
  const client = await openClient()
  expect(client.getServerVersion()).toMatchObject({
    name: "live-mcp",
    version: "0.1.1",
  })
  const tools = await client.listTools()
  expect(tools.tools.map(({ name }) => name)).toEqual([...TOOL_NAMES])
})

test("forwards instance, script, source, and eval calls", async () => {
  const client = await openClient()

  await client.callTool({
    name: "roblox_list_instances",
    arguments: { path: "game", query: "Players", className: "Players", limit: 10 },
  })
  await client.callTool({
    name: "roblox_list_scripts",
    arguments: { query: "door", scope: "running", limit: 20 },
  })
  await client.callTool({
    name: "roblox_read_source",
    arguments: { path: 'game:GetService("Players")', startLine: 2, lineCount: 50 },
  })
  await client.callTool({
    name: "roblox_eval",
    arguments: { code: "return 1", chunkName: "test" },
  })

  expect(requests).toEqual([
    {
      method: "listInstances",
      params: { path: "game", query: "Players", className: "Players", limit: 10 },
    },
    {
      method: "listScripts",
      params: { query: "door", scope: "running", limit: 20 },
    },
    {
      method: "readSource",
      params: { path: 'game:GetService("Players")', startLine: 2, lineCount: 50 },
    },
    {
      method: "eval",
      params: { code: "return 1", chunkName: "test" },
    },
  ])
})
