import { z } from "zod"
import { startLiveMcpDaemon } from "./daemon.js"

const environmentSchema = z.object({
  HYDROXIDE_MCP_TOKEN: z.string().min(32).max(256),
  HYDROXIDE_MCP_PORT: z.coerce.number().int().min(1_024).max(65_535).default(32_145),
  HYDROXIDE_MCP_HTTP_PORT: z.coerce.number().int().min(1_024).max(65_535).default(32_146),
})

async function main(): Promise<void> {
  const environment = environmentSchema.parse(process.env)
  const daemon = await startLiveMcpDaemon({
    token: environment.HYDROXIDE_MCP_TOKEN,
    voltPort: environment.HYDROXIDE_MCP_PORT,
    mcpPort: environment.HYDROXIDE_MCP_HTTP_PORT,
  })

  console.error(`Hydroxide Volt bridge listening on ws://127.0.0.1:${daemon.voltPort}/volt`)
  console.error(`Hydroxide MCP listening on http://127.0.0.1:${daemon.mcpPort}/mcp`)

  let stopping = false
  async function stop(): Promise<void> {
    if (stopping) {
      return
    }
    stopping = true
    await daemon.stop()
  }
  process.once("SIGINT", () => void stop())
  process.once("SIGTERM", () => void stop())
}

try {
  await main()
} catch (error) {
  // no-excuse-ok: catch -- process entry point translates every startup failure.
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
