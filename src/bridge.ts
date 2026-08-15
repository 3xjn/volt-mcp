import type { ServerWebSocket } from "bun"
import {
  AgentRequestError,
  BridgeClientNotFoundError,
  BridgeClientSelectionError,
  BridgeDisconnectedError,
  BridgeStartupError,
  BridgeTimeoutError,
  BridgeUnavailableError,
} from "./errors.js"
import { createPairingController, type PairingSocketData } from "./pairing.js"
import {
  type AgentInfo,
  type AgentRequest,
  type RequestMethod,
  responseMessageSchema,
} from "./protocol.js"
import type { LocalDaemonState } from "./state.js"

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024
const STOP_GRACE_MS = 100

type PendingRequest = {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: Error) => void
  readonly timeout: ReturnType<typeof setTimeout>
}

export type ConnectedClient = {
  readonly client: string
  readonly connectedAt: string
  readonly agent: AgentInfo
}

type ClientConnection = {
  readonly details: ConnectedClient
  readonly socket: ServerWebSocket<PairingSocketData>
  readonly pending: Map<string, PendingRequest>
}

export type BridgeStatus =
  | {
      readonly state: "unpaired"
      readonly paired: false
      readonly connected: false
    }
  | {
      readonly state: "ready_to_pair"
      readonly paired: false
      readonly connected: false
      readonly pendingRobloxSession: AgentInfo
    }
  | {
      readonly state: "challenge_ready" | "awaiting_user_approval"
      readonly paired: false
      readonly connected: false
      readonly challenge: PairingChallengeView
    }
  | {
      readonly state: "pairing_declined" | "pairing_expired"
      readonly paired: false
      readonly connected: false
      readonly pendingRobloxSession: AgentInfo
      readonly retryable: true
    }
  | { readonly state: "waiting_for_roblox"; readonly paired: true; readonly connected: false }
  | {
      readonly state: "connected"
      readonly paired: true
      readonly connected: true
      readonly agent: AgentInfo
    }
  | {
      readonly state: "connected"
      readonly paired: true
      readonly connected: true
      readonly clients: readonly ConnectedClient[]
    }

export type PairingChallengeView = {
  readonly challengeId: string
  readonly verificationCode: string
  readonly expiresAt: string
  readonly approvalState: "ready_to_present" | "awaiting_user_approval"
  readonly pendingRobloxSession: AgentInfo
  readonly daemon: {
    readonly name: "Volt MCP"
    readonly identity: "local_volt_mcp_daemon"
    readonly endpoint: string
  }
  readonly authorization: {
    readonly codePurpose: "correlation_only"
    readonly approvalAuthority: "volt_messagebox_yes"
    readonly persistence: "until_pairing_reset"
    readonly credentialStoredOnApproval: true
    readonly credentialStoredOnDecline: false
    readonly scope: {
      readonly inspectLiveScripts: true
      readonly inspectRuntimeState: true
      readonly executeClientLuau: true
      readonly modifyClientLuau: true
    }
  }
  readonly nextAction: string
}

export type PairingPresentationResult =
  | {
      readonly accepted: true
      readonly state: "awaiting_user_approval"
      readonly paired: false
      readonly connected: false
      readonly challenge: PairingChallengeView
    }
  | {
      readonly accepted: false
      readonly reason: "challenge_not_current" | "challenge_expired"
    }

export interface LiveBridge {
  readonly port: number
  listClients(): readonly ConnectedClient[]
  request(
    method: RequestMethod,
    params: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
    client?: string,
  ): Promise<unknown>
  status(): BridgeStatus
  preparePairing(): BridgeStatus
  presentPairing(challengeId: string): PairingPresentationResult
  stop(): Promise<void>
}

export type BridgeOptions = {
  readonly state: LocalDaemonState
  readonly port: number
  readonly requestTimeoutMs?: number
  readonly pairingTimeoutMs?: number
  readonly verificationCode?: () => string
  readonly agentToken?: () => string
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
  const pairing = createPairingController(options)
  const clientsById = new Map<string, ClientConnection>()
  const clientsBySocket = new Map<ServerWebSocket<PairingSocketData>, ClientConnection>()

  function rejectPending(connection: ClientConnection, error: Error): void {
    for (const request of connection.pending.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    connection.pending.clear()
  }

  function disconnectClient(
    socket: ServerWebSocket<PairingSocketData>,
    error = new BridgeDisconnectedError(),
  ): void {
    const connection = clientsBySocket.get(socket)
    if (connection === undefined) {
      return
    }
    clientsBySocket.delete(socket)
    clientsById.delete(connection.details.client)
    rejectPending(connection, error)
  }

  function authenticate(socket: ServerWebSocket<PairingSocketData>, agent: AgentInfo): void {
    if (!clientsBySocket.has(socket)) {
      const details: ConnectedClient = {
        client: crypto.randomUUID(),
        connectedAt: new Date().toISOString(),
        agent,
      }
      const connection: ClientConnection = { details, socket, pending: new Map() }
      clientsById.set(details.client, connection)
      clientsBySocket.set(socket, connection)
    }
    socket.send(JSON.stringify({ type: "ready" }))
  }

  const server = Bun.serve<PairingSocketData>({
    hostname: "127.0.0.1",
    port: options.port,
    fetch(request, bunServer) {
      if (new URL(request.url).pathname !== "/volt") {
        return new Response("Not found", { status: 404 })
      }
      const upgraded = bunServer.upgrade(request, {
        data: { authenticated: false, pairing: undefined },
      })
      return upgraded ? undefined : new Response("WebSocket upgrade required", { status: 426 })
    },
    websocket: {
      idleTimeout: 0,
      maxPayloadLength: MAX_PAYLOAD_BYTES,
      open: pairing.open,
      async message(socket, message) {
        if (typeof message !== "string") {
          disconnectClient(socket)
          socket.close(1003, "Text frames only")
          return
        }
        const raw = parseJson(message)
        if (!socket.data.authenticated) {
          await pairing.handle(socket, raw, (agent) => authenticate(socket, agent))
          return
        }
        const response = responseMessageSchema.safeParse(raw)
        if (!response.success) {
          disconnectClient(socket)
          socket.close(1007, "Invalid response")
          return
        }
        const connection = clientsBySocket.get(socket)
        if (connection === undefined) {
          socket.close(1008, "Client session unavailable")
          return
        }
        const request = connection.pending.get(response.data.id)
        if (request === undefined) {
          return
        }
        clearTimeout(request.timeout)
        connection.pending.delete(response.data.id)
        if (response.data.ok) {
          request.resolve(response.data.result)
        } else {
          request.reject(new AgentRequestError(response.data.id, response.data.error))
        }
      },
      close(socket) {
        pairing.close(socket)
        disconnectClient(socket)
      },
    },
  })
  const boundPort = server.port
  if (boundPort === undefined) {
    throw new BridgeStartupError("Bun did not report the live bridge port")
  }
  const daemonEndpoint = `ws://127.0.0.1:${boundPort}/volt`

  function challengeView(
    challenge: NonNullable<ReturnType<typeof pairing.snapshot>["challenge"]>,
  ): PairingChallengeView {
    const awaitingApproval = challenge.approvalState === "awaiting_user_approval"
    return {
      challengeId: challenge.challengeId,
      verificationCode: challenge.verificationCode,
      expiresAt: challenge.expiresAt,
      approvalState: challenge.approvalState,
      pendingRobloxSession: challenge.agent,
      daemon: {
        name: "Volt MCP",
        identity: "local_volt_mcp_daemon",
        endpoint: daemonEndpoint,
      },
      authorization: {
        codePurpose: "correlation_only",
        approvalAuthority: "volt_messagebox_yes",
        persistence: "until_pairing_reset",
        credentialStoredOnApproval: true,
        credentialStoredOnDecline: false,
        scope: {
          inspectLiveScripts: true,
          inspectRuntimeState: true,
          executeClientLuau: true,
          modifyClientLuau: true,
        },
      },
      nextAction: awaitingApproval
        ? "Compare this code with the Windows “Volt MCP Pairing” dialog. Choose Yes only when they match; choose No on any mismatch. The code only correlates the two pending surfaces and is not authorization or a credential."
        : "Surface this code to the user, compare it with the Windows “Volt MCP Pairing” dialog, then call roblox_present_pairing with this challengeId. The code only correlates the two pending surfaces and is not authorization or a credential.",
    }
  }

  function listClients(): readonly ConnectedClient[] {
    return Array.from(clientsById.values(), ({ details }) => details)
  }

  function selectClient(client?: string): ClientConnection {
    if (client !== undefined) {
      const selected = clientsById.get(client)
      if (selected === undefined) {
        throw new BridgeClientNotFoundError(client)
      }
      return selected
    }
    const clients = Array.from(clientsById.values())
    const selected = clients[0]
    if (selected === undefined) {
      throw new BridgeUnavailableError()
    }
    if (clients.length > 1) {
      throw new BridgeClientSelectionError()
    }
    return selected
  }

  function status(): BridgeStatus {
    const clients = listClients()
    const onlyClient = clients[0]
    if (onlyClient !== undefined && clients.length === 1) {
      return { state: "connected", paired: true, connected: true, agent: onlyClient.agent }
    }
    if (clients.length > 1) {
      return { state: "connected", paired: true, connected: true, clients }
    }
    if (options.state.hasAgentCredential()) {
      return { state: "waiting_for_roblox", paired: true, connected: false }
    }
    const snapshot = pairing.snapshot()
    if (snapshot.challenge !== undefined) {
      return {
        state:
          snapshot.challenge.approvalState === "awaiting_user_approval"
            ? "awaiting_user_approval"
            : "challenge_ready",
        paired: false,
        connected: false,
        challenge: challengeView(snapshot.challenge),
      }
    }
    if (snapshot.outcome !== undefined) {
      return {
        state: snapshot.outcome.state === "declined" ? "pairing_declined" : "pairing_expired",
        paired: false,
        connected: false,
        pendingRobloxSession: snapshot.outcome.agent,
        retryable: true,
      }
    }
    return snapshot.pendingAgent === undefined
      ? { state: "unpaired", paired: false, connected: false }
      : {
          state: "ready_to_pair",
          paired: false,
          connected: false,
          pendingRobloxSession: snapshot.pendingAgent,
        }
  }

  return {
    port: boundPort,
    listClients,
    status,
    preparePairing() {
      pairing.prepare()
      return status()
    },
    presentPairing(challengeId) {
      const presentation = pairing.present(challengeId, daemonEndpoint)
      if (!presentation.accepted) {
        return presentation
      }
      const presentedStatus = status()
      if (presentedStatus.state !== "awaiting_user_approval") {
        return { accepted: false, reason: "challenge_not_current" }
      }
      return {
        accepted: true,
        state: "awaiting_user_approval",
        paired: false,
        connected: false,
        challenge: presentedStatus.challenge,
      }
    },
    async request(method, params, timeoutMs = defaultTimeoutMs, client) {
      const connection = selectClient(client)
      const id = crypto.randomUUID()
      const request: AgentRequest = { type: "request", id, method, params }
      return await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          connection.pending.delete(id)
          reject(new BridgeTimeoutError(id, timeoutMs))
        }, timeoutMs)
        connection.pending.set(id, { resolve, reject, timeout })
        connection.socket.send(JSON.stringify(request))
      })
    },
    async stop() {
      for (const connection of clientsById.values()) {
        rejectPending(connection, new BridgeDisconnectedError())
      }
      pairing.stop()
      await Promise.race([server.stop(true), Bun.sleep(STOP_GRACE_MS)])
      clientsById.clear()
      clientsBySocket.clear()
    },
  }
}
