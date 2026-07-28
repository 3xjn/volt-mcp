import { type LiveBridge, startBridge } from "./bridge.js"
import { startHttpServer, type VoltMcpHttpServer } from "./http.js"

export type VoltMcpDaemonOptions = {
  readonly token: string
  readonly voltPort: number
  readonly mcpPort: number
}

export interface VoltMcpDaemon {
  readonly bridge: LiveBridge
  readonly voltPort: number
  readonly mcpPort: number
  stop(): Promise<void>
}

export async function startVoltMcpDaemon(options: VoltMcpDaemonOptions): Promise<VoltMcpDaemon> {
  const bridge = startBridge({ token: options.token, port: options.voltPort })
  let httpServer: VoltMcpHttpServer
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
