import { timingSafeEqual } from "node:crypto"
import type { ServerWebSocket } from "bun"
import {
  AgentRequestError,
  BridgeDisconnectedError,
  BridgeStartupError,
  BridgeTimeoutError,
  BridgeUnavailableError,
} from "./errors.js"
import {
  type AgentInfo,
  type AgentRequest,
  helloMessageSchema,
  type RequestMethod,
  responseMessageSchema,
} from "./protocol.js"

const AUTH_TIMEOUT_MS = 5_000
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024
const STOP_GRACE_MS = 100

type SocketData = {
  authenticated: boolean
}

type PendingRequest = {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: Error) => void
  readonly timeout: ReturnType<typeof setTimeout>
}

export type BridgeStatus = {
  readonly connected: boolean
  readonly agent?: AgentInfo
}

export interface LiveBridge {
  readonly port: number
  request(
    method: RequestMethod,
    params: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ): Promise<unknown>
  status(): BridgeStatus
  stop(): Promise<void>
}

export type BridgeOptions = {
  readonly token: string
  readonly port: number
  readonly requestTimeoutMs?: number
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source)
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null
    }
    throw error
  }
}

export function startBridge(options: BridgeOptions): LiveBridge {
  const defaultTimeoutMs = options.requestTimeoutMs ?? 30_000
  const pending = new Map<string, PendingRequest>()
  const authTimeouts = new Map<ServerWebSocket<SocketData>, ReturnType<typeof setTimeout>>()
  let activeSocket: ServerWebSocket<SocketData> | undefined
  let activeAgent: AgentInfo | undefined

  function rejectPending(error: Error): void {
    for (const request of pending.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    pending.clear()
  }

  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: options.port,
    fetch(request, bunServer) {
      const url = new URL(request.url)
      if (url.pathname !== "/volt") {
        return new Response("Not found", { status: 404 })
      }
      const upgraded = bunServer.upgrade(request, { data: { authenticated: false } })
      return upgraded ? undefined : new Response("WebSocket upgrade required", { status: 426 })
    },
    websocket: {
      idleTimeout: 0,
      maxPayloadLength: MAX_PAYLOAD_BYTES,
      open(socket) {
        const timeout = setTimeout(() => {
          socket.close(1008, "Authentication timed out")
        }, AUTH_TIMEOUT_MS)
        authTimeouts.set(socket, timeout)
      },
      message(socket, message) {
        if (typeof message !== "string") {
          socket.close(1003, "Text frames only")
          return
        }

        const raw = parseJson(message)
        if (!socket.data.authenticated) {
          const hello = helloMessageSchema.safeParse(raw)
          if (!hello.success || !tokenMatches(hello.data.token, options.token)) {
            socket.close(1008, "Authentication failed")
            return
          }

          const authTimeout = authTimeouts.get(socket)
          if (authTimeout !== undefined) {
            clearTimeout(authTimeout)
            authTimeouts.delete(socket)
          }

          if (activeSocket !== undefined && activeSocket !== socket) {
            activeSocket.close(1012, "Replaced by a newer Volt client")
            rejectPending(new BridgeDisconnectedError())
          }

          socket.data.authenticated = true
          activeSocket = socket
          activeAgent = hello.data.agent
          socket.send(JSON.stringify({ type: "ready" }))
          return
        }

        const response = responseMessageSchema.safeParse(raw)
        if (!response.success) {
          socket.close(1007, "Invalid response")
          return
        }

        const request = pending.get(response.data.id)
        if (request === undefined) {
          return
        }
        clearTimeout(request.timeout)
        pending.delete(response.data.id)
        if (response.data.ok) {
          request.resolve(response.data.result)
        } else {
          request.reject(new AgentRequestError(response.data.id, response.data.error))
        }
      },
      close(socket) {
        const authTimeout = authTimeouts.get(socket)
        if (authTimeout !== undefined) {
          clearTimeout(authTimeout)
          authTimeouts.delete(socket)
        }
        if (activeSocket === socket) {
          activeSocket = undefined
          activeAgent = undefined
          rejectPending(new BridgeDisconnectedError())
        }
      },
    },
  })
  const boundPort = server.port
  if (boundPort === undefined) {
    throw new BridgeStartupError("Bun did not report the live bridge port")
  }

  return {
    port: boundPort,
    status() {
      return activeAgent === undefined
        ? { connected: false }
        : { connected: true, agent: activeAgent }
    },
    async request(method, params, timeoutMs = defaultTimeoutMs) {
      const socket = activeSocket
      if (socket === undefined) {
        throw new BridgeUnavailableError()
      }

      const id = crypto.randomUUID()
      const request: AgentRequest = { type: "request", id, method, params }
      return await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id)
          reject(new BridgeTimeoutError(id, timeoutMs))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timeout })
        socket.send(JSON.stringify(request))
      })
    },
    async stop() {
      rejectPending(new BridgeDisconnectedError())
      await Promise.race([server.stop(true), Bun.sleep(STOP_GRACE_MS)])
      activeSocket = undefined
      activeAgent = undefined
    },
  }
}
