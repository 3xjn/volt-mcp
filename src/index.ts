import { z } from "zod"
import { startVoltMcpDaemon } from "./daemon.js"
import { defaultStatePath, loadDaemonState } from "./state.js"

const environmentSchema = z.object({
  VOLT_MCP_VOLT_PORT: z.coerce.number().int().min(1_024).max(65_535).default(32_145),
  VOLT_MCP_HTTP_PORT: z.coerce.number().int().min(1_024).max(65_535).default(32_146),
})

async function main(): Promise<void> {
  const environment = environmentSchema.parse(process.env)
  const statePath = defaultStatePath()
  const state = await loadDaemonState(statePath)
  const daemon = await startVoltMcpDaemon({
    state,
    voltPort: environment.VOLT_MCP_VOLT_PORT,
    mcpPort: environment.VOLT_MCP_HTTP_PORT,
  })

  console.error(`Volt agent bridge listening on ws://127.0.0.1:${daemon.voltPort}/volt`)
  console.error(`Volt MCP listening on http://127.0.0.1:${daemon.mcpPort}/mcp`)
  console.error(`Volt MCP state loaded from ${statePath}`)

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
