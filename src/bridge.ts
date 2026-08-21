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
  parseHttpAgentResponse,
  pollMessageSchema,
  type RequestMethod,
  responseMessageSchema,
} from "./protocol.js"

const AUTH_TIMEOUT_MS = 5_000
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024
const STOP_GRACE_MS = 100
const POLL_WAIT_MS = 2_000
const HTTP_IDLE_MS = 15_000
export const BRIDGE_PATH = "/live"
export const POLL_PATH = "/live/poll"

type SocketData = {
  authenticated: boolean
}

type PendingRequest = {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: Error) => void
  readonly timeout: ReturnType<typeof setTimeout>
}

type PollWaiter = {
  resolve(request: AgentRequest | undefined): void
  timeout: ReturnType<typeof setTimeout>
}

type ActiveSession =
  | { kind: "websocket"; socket: ServerWebSocket<SocketData>; agent: AgentInfo }
  | { kind: "http"; agent: AgentInfo; lastSeen: number }

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

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status })
}

export function startBridge(options: BridgeOptions): LiveBridge {
  const defaultTimeoutMs = options.requestTimeoutMs ?? 30_000
  const pending = new Map<string, PendingRequest>()
  const authTimeouts = new Map<ServerWebSocket<SocketData>, ReturnType<typeof setTimeout>>()
  const outbound: AgentRequest[] = []
  const waiters: PollWaiter[] = []
  let session: ActiveSession | undefined

  function rejectPending(error: Error): void {
    for (const request of pending.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    pending.clear()
  }

  function clearWaiters(): void {
    outbound.length = 0
    for (const waiter of waiters.splice(0)) {
      waiter.resolve(undefined)
    }
  }

  function dropSession(error = new BridgeDisconnectedError()): void {
    const current = session
    session = undefined
    rejectPending(error)
    clearWaiters()
    if (current?.kind === "websocket") {
      current.socket.close(1012, "Replaced by a newer live client")
    }
  }

  function httpSessionAlive(): boolean {
    return session?.kind === "http" && Date.now() - session.lastSeen <= HTTP_IDLE_MS
  }

  function deliverHttp(request: AgentRequest): void {
    const waiter = waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve(request)
      return
    }
    outbound.push(request)
  }

  function takeOutbound(waitMs: number): Promise<AgentRequest | undefined> {
    const queued = outbound.shift()
    if (queued !== undefined) {
      return Promise.resolve(queued)
    }
    return new Promise((resolve) => {
      const waiter: PollWaiter = {
        resolve(request) {
          clearTimeout(waiter.timeout)
          resolve(request)
        },
        timeout: setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index !== -1) {
            waiters.splice(index, 1)
          }
          resolve(undefined)
        }, waitMs),
      }
      waiters.push(waiter)
    })
  }

  function acceptResponse(raw: unknown): boolean {
    const response = responseMessageSchema.safeParse(raw)
    if (!response.success) {
      return false
    }
    const request = pending.get(response.data.id)
    if (request === undefined) {
      return true
    }
    clearTimeout(request.timeout)
    pending.delete(response.data.id)
    if (response.data.ok) {
      request.resolve(response.data.result)
    } else {
      request.reject(new AgentRequestError(response.data.id, response.data.error))
    }
    return true
  }

  async function handlePoll(request: Request): Promise<Response> {
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      return jsonResponse(400, { type: "error", error: "Invalid JSON" })
    }

    const hello = helloMessageSchema.safeParse(raw)
    if (hello.success) {
      if (!tokenMatches(hello.data.token, options.token)) {
        return jsonResponse(401, { type: "error", error: "Authentication failed" })
      }
      dropSession()
      session = {
        kind: "http",
        agent: { ...hello.data.agent, transport: "http" },
        lastSeen: Date.now(),
      }
      return jsonResponse(200, { type: "ready" })
    }

    const poll = pollMessageSchema.safeParse(raw)
    if (poll.success) {
      if (!tokenMatches(poll.data.token, options.token) || !httpSessionAlive()) {
        return jsonResponse(401, { type: "error", error: "Authentication failed" })
      }
      if (session?.kind === "http") {
        session.lastSeen = Date.now()
      }
      const next = await takeOutbound(POLL_WAIT_MS)
      return next === undefined ? jsonResponse(200, { type: "idle" }) : jsonResponse(200, next)
    }

    const response = parseHttpAgentResponse(raw)
    if (response !== undefined) {
      if (!tokenMatches(response.token, options.token) || !httpSessionAlive()) {
        return jsonResponse(401, { type: "error", error: "Authentication failed" })
      }
      if (session?.kind === "http") {
        session.lastSeen = Date.now()
      }
      if (!acceptResponse(response)) {
        return jsonResponse(400, { type: "error", error: "Invalid response" })
      }
      return jsonResponse(200, { type: "ack" })
    }

    return jsonResponse(400, { type: "error", error: "Unknown poll message" })
  }

  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: options.port,
    fetch(request, bunServer) {
      const url = new URL(request.url)
      if (url.pathname === POLL_PATH) {
        if (request.method !== "POST") {
          return new Response("Method not allowed", { status: 405 })
        }
        return handlePoll(request)
      }
      if (url.pathname !== BRIDGE_PATH) {
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

          dropSession()
          socket.data.authenticated = true
          session = {
            kind: "websocket",
            socket,
            agent: { ...hello.data.agent, transport: "websocket" },
          }
          socket.send(JSON.stringify({ type: "ready" }))
          return
        }

        if (!acceptResponse(raw)) {
          socket.close(1007, "Invalid response")
        }
      },
      close(socket) {
        const authTimeout = authTimeouts.get(socket)
        if (authTimeout !== undefined) {
          clearTimeout(authTimeout)
          authTimeouts.delete(socket)
        }
        if (session?.kind === "websocket" && session.socket === socket) {
          session = undefined
          rejectPending(new BridgeDisconnectedError())
          clearWaiters()
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
      if (session?.kind === "websocket") {
        return { connected: true, agent: session.agent }
      }
      if (httpSessionAlive() && session?.kind === "http") {
        return { connected: true, agent: session.agent }
      }
      return { connected: false }
    },
    async request(method, params, timeoutMs = defaultTimeoutMs) {
      const current = session
      if (current === undefined || (current.kind === "http" && !httpSessionAlive())) {
        throw new BridgeUnavailableError()
      }

      const id = crypto.randomUUID()
      const agentRequest: AgentRequest = { type: "request", id, method, params }
      return await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id)
          reject(new BridgeTimeoutError(id, timeoutMs))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timeout })
        if (current.kind === "websocket") {
          current.socket.send(JSON.stringify(agentRequest))
        } else {
          deliverHttp(agentRequest)
        }
      })
    },
    async stop() {
      dropSession()
      await Promise.race([server.stop(true), Bun.sleep(STOP_GRACE_MS)])
    },
  }
}
