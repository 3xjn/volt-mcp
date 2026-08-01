import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { z } from "zod"
import { loadDaemonState } from "../src/state.js"

const environment = z
  .object({
    VOLT_MCP_ENDPOINT: z.url().default("http://127.0.0.1:32146/mcp"),
  })
  .parse(process.env)
const state = await loadDaemonState()

const textResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
})

const transport = new StreamableHTTPClientTransport(new URL(environment.VOLT_MCP_ENDPOINT), {
  requestInit: {
    headers: { Authorization: `Bearer ${state.clientToken}` },
  },
})
const client = new Client({ name: "volt-mcp-smoke", version: "0.1.1" })

try {
  await client.connect(transport)
  const tools = await client.listTools()
  const statusResult = textResultSchema.parse(
    await client.callTool({ name: "roblox_status", arguments: {} }),
  )
  process.stdout.write(
    JSON.stringify(
      {
        server: client.getServerVersion(),
        toolNames: tools.tools.map(({ name }) => name),
        status: JSON.parse(statusResult.content[0]?.text ?? ""),
      },
      null,
      2,
    ),
  )
} finally {
  await client.close()
}
