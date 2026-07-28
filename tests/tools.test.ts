import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { LiveBridge } from "../src/bridge.js"
import { createMcpServer } from "../src/tools.js"

const bridge: LiveBridge = {
  port: 0,
  async request() {
    return {}
  },
  status() {
    return { connected: false }
  },
  async stop() {},
}

test("advertises Roblox branding during MCP initialization", async () => {
  // Given
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer(bridge)
  const client = new Client({ name: "hydroxide-live-tools-test", version: "0.1.0" })

  // When
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  // Then
  expect(client.getServerVersion()).toMatchObject({
    name: "hydroxide-live",
    title: "Hydroxide Live for Roblox",
    icons: [
      {
        src: "https://images.rbxcdn.com/905bd722ee0a6ceda3caacde54c0b081.png",
        mimeType: "image/png",
        sizes: ["180x180"],
      },
    ],
  })

  await Promise.all([client.close(), server.close()])
})
