import { type LiveBridge, startBridge } from "./bridge.js"
import { type LiveMcpHttpServer, startHttpServer } from "./http.js"

export type LiveMcpDaemonOptions = {
  readonly token: string
  readonly voltPort: number
  readonly mcpPort: number
}

export interface LiveMcpDaemon {
  readonly bridge: LiveBridge
  readonly voltPort: number
  readonly mcpPort: number
  stop(): Promise<void>
}

export async function startLiveMcpDaemon(options: LiveMcpDaemonOptions): Promise<LiveMcpDaemon> {
  const bridge = startBridge({ token: options.token, port: options.voltPort })
  let httpServer: LiveMcpHttpServer
  try {
    httpServer = startHttpServer({
      bridge,
      token: options.token,
      port: options.mcpPort,
    })
  } catch (error) {
    // no-excuse-ok: catch -- startup rollback releases the first listener.
    await bridge.stop()
    throw error
  }

  let stopped = false
  return {
    bridge,
    voltPort: bridge.port,
    mcpPort: httpServer.port,
    async stop() {
      if (stopped) {
        return
      }
      stopped = true
      await httpServer.stop()
      await bridge.stop()
    },
  }
}
