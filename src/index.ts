import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { BRIDGE_PATH, POLL_PATH, startBridge } from "./bridge.js"
import { createMcpServer } from "./tools.js"

const environmentSchema = z.object({
  ROBLOX_CLIENT_MCP_TOKEN: z.string().min(32).max(256),
  ROBLOX_CLIENT_MCP_PORT: z.coerce.number().int().min(1_024).max(65_535).default(32_145),
  ROBLOX_CLIENT_MCP_FILEPOLL: z.string().min(1).optional(),
})

async function main(): Promise<void> {
  const environment = environmentSchema.parse(process.env)
  const bridge = startBridge({
    token: environment.ROBLOX_CLIENT_MCP_TOKEN,
    port: environment.ROBLOX_CLIENT_MCP_PORT,
    ...(environment.ROBLOX_CLIENT_MCP_FILEPOLL === undefined
      ? {}
      : { filePollDir: environment.ROBLOX_CLIENT_MCP_FILEPOLL }),
  })
  const server = createMcpServer(bridge)
  const transport = new StdioServerTransport()

  console.error(
    `Live client bridge listening on ws://127.0.0.1:${bridge.port}${BRIDGE_PATH} (HTTP poll http://127.0.0.1:${bridge.port}${POLL_PATH})`,
  )
  await server.connect(transport)
}

try {
  await main()
} catch (error) {
  // no-excuse-ok: catch -- process entry point translates every startup failure.
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
