import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { z } from "zod"
import type { LiveBridge } from "../src/bridge.js"
import { createMcpServer } from "../src/tools.js"

const bridge: LiveBridge = {
  port: 0,
  listClients() {
    return [
      {
        client: "123e4567-e89b-42d3-a456-426614174000",
        connectedAt: "2026-08-13T20:00:00.000Z",
        agent: {
          agentVersion: "test",
          gameId: 42,
          placeId: 123,
          jobId: "job",
          playerName: "Builder",
          userId: 456,
        },
      },
    ]
  },
  async request() {
    return {}
  },
  status() {
    return { state: "unpaired", paired: false, connected: false }
  },
  preparePairing() {
    return { state: "unpaired", paired: false, connected: false }
  },
  presentPairing() {
    return { accepted: false, reason: "challenge_not_current" }
  },
  async stop() {},
}

test("advertises Roblox branding during MCP initialization", async () => {
  // Given
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer(bridge)
  const client = new Client({ name: "volt-mcp-tools-test", version: "0.1.0" })

  // When
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  // Then
  expect(client.getServerVersion()).toMatchObject({
    name: "volt-mcp",
    title: "Volt MCP for Roblox",
    icons: [
      {
        src: "https://images.rbxcdn.com/905bd722ee0a6ceda3caacde54c0b081.png",
        mimeType: "image/png",
        sizes: ["180x180"],
      },
    ],
  })
  const tools = await client.listTools()
  expect(tools.tools.map(({ name }) => name)).toContain("roblox_list_clients")
  const clientAddressedTools = [
    "roblox_list_targets",
    "roblox_list_scripts",
    "roblox_search_scripts",
    "roblox_read_script",
    "roblox_inspect_closure",
    "roblox_mutate_closure",
    "roblox_restore_mutation",
    "roblox_eval",
  ]
  for (const name of clientAddressedTools) {
    expect(tools.tools.find((tool) => tool.name === name)?.inputSchema).toMatchObject({
      properties: {
        client: { type: "string", format: "uuid" },
      },
    })
  }

  const listed = z
    .object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1) })
    .parse(await client.callTool({ name: "roblox_list_clients", arguments: {} }))
  const firstBlock = listed.content[0]
  if (firstBlock === undefined) {
    throw new Error("Expected a text result")
  }
  expect(JSON.parse(firstBlock.text)).toMatchObject({
    count: 1,
    selectionRequired: false,
    clients: [{ client: "123e4567-e89b-42d3-a456-426614174000" }],
  })

  await Promise.all([client.close(), server.close()])
})
