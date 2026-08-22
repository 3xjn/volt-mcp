import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { BRIDGE_PATH, POLL_PATH, startBridge } from "./bridge.js"
import { BridgeStartupError } from "./errors.js"
import { HTTP_MCP_PATH, type HttpMcpServer, startHttpServer } from "./http.js"
import { formatStartupNotice, resolveToken } from "./token.js"
import { createMcpServer } from "./tools.js"

const environmentSchema = z.object({
  ROBLOX_CLIENT_MCP_PORT: z.coerce.number().int().min(1_024).max(65_535).default(32_145),
  ROBLOX_CLIENT_MCP_HTTP_PORT: z.coerce.number().int().min(1_024).max(65_535).default(32_146),
  ROBLOX_CLIENT_MCP_FILEPOLL: z.string().min(1).optional(),
})

async function main(): Promise<void> {
  const resolved = await resolveToken()
  const environment = environmentSchema.parse(process.env)
  if (environment.ROBLOX_CLIENT_MCP_PORT === environment.ROBLOX_CLIENT_MCP_HTTP_PORT) {
    throw new BridgeStartupError(
      "ROBLOX_CLIENT_MCP_HTTP_PORT must differ from ROBLOX_CLIENT_MCP_PORT",
    )
  }
  const bridge = startBridge({
    token: resolved.token,
    port: environment.ROBLOX_CLIENT_MCP_PORT,
    ...(environment.ROBLOX_CLIENT_MCP_FILEPOLL === undefined
      ? {}
      : { filePollDir: environment.ROBLOX_CLIENT_MCP_FILEPOLL }),
  })
  let httpServer: HttpMcpServer
  try {
    httpServer = startHttpServer({
      bridge,
      token: resolved.token,
      port: environment.ROBLOX_CLIENT_MCP_HTTP_PORT,
    })
  } catch (error) {
    await bridge.stop()
    throw error
  }
  const server = createMcpServer(bridge)
  const transport = new StdioServerTransport()

  let stopping = false
  async function stop(): Promise<void> {
    if (stopping) {
      return
    }
    stopping = true
    await httpServer.stop()
    await bridge.stop()
  }
  process.once("SIGINT", () => void stop())
  process.once("SIGTERM", () => void stop())

  console.error(formatStartupNotice(resolved))
  console.error(
    `Live client bridge listening on ws://127.0.0.1:${bridge.port}${BRIDGE_PATH} (HTTP poll http://127.0.0.1:${bridge.port}${POLL_PATH})`,
  )
  console.error(`MCP HTTP listening on http://127.0.0.1:${httpServer.port}${HTTP_MCP_PATH}`)
  await server.connect(transport)
}

try {
  await main()
} catch (error) {
  // no-excuse-ok: catch -- process entry point translates every startup failure.
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
