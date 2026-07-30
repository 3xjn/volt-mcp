import { type LiveBridge, startBridge } from "./bridge.js"
import { startHttpServer, type VoltMcpHttpServer } from "./http.js"
import type { LocalDaemonState } from "./state.js"

export type VoltMcpDaemonOptions = {
  readonly state: LocalDaemonState
  readonly voltPort: number
  readonly mcpPort: number
  readonly pairingTimeoutMs?: number
}

export interface VoltMcpDaemon {
  readonly bridge: LiveBridge
  readonly voltPort: number
  readonly mcpPort: number
  stop(): Promise<void>
}

export async function startVoltMcpDaemon(options: VoltMcpDaemonOptions): Promise<VoltMcpDaemon> {
  const bridge = startBridge({
    state: options.state,
    port: options.voltPort,
    ...(options.pairingTimeoutMs === undefined
      ? {}
      : { pairingTimeoutMs: options.pairingTimeoutMs }),
  })
  let httpServer: VoltMcpHttpServer
  let stopped = false
  async function stop(): Promise<void> {
    if (stopped) {
      return
    }
    stopped = true
    await httpServer.stop()
    await bridge.stop()
  }
  try {
    httpServer = startHttpServer({
      bridge,
      token: options.state.clientToken,
      port: options.mcpPort,
      onShutdown: () => void stop(),
    })
  } catch (error) {
    // no-excuse-ok: catch -- startup rollback releases the first listener.
    await bridge.stop()
    throw error
  }

  return {
    bridge,
    voltPort: bridge.port,
    mcpPort: httpServer.port,
    stop,
  }
}
