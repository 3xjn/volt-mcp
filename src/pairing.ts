import type { ServerWebSocket } from "bun"
import {
  type AgentInfo,
  helloMessageSchema,
  pairDecisionMessageSchema,
  pairRequestMessageSchema,
} from "./protocol.js"
import type { LocalDaemonState } from "./state.js"

const AUTH_TIMEOUT_MS = 5_000
const DEFAULT_PAIRING_TIMEOUT_MS = 60_000

type PairingChallenge = {
  readonly challengeId: string
  readonly verificationCode: string
  readonly expiresAt: string
  readonly approvalState: "ready_to_present" | "awaiting_user_approval"
  readonly agent: AgentInfo
}

export type PairingSocketData = {
  authenticated: boolean
  pairing: PairingChallenge | undefined
}

export type PairingControllerOptions = {
  readonly state: LocalDaemonState
  readonly pairingTimeoutMs?: number
  readonly verificationCode?: () => string
  readonly agentToken?: () => string
}

export type PairingSnapshot = {
  readonly pendingAgent: AgentInfo | undefined
  readonly challenge: PairingChallenge | undefined
  readonly outcome:
    | {
        readonly state: "declined" | "expired"
        readonly challengeId: string
        readonly agent: AgentInfo
      }
    | undefined
}

export type PairingPresentation =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: "challenge_not_current" | "challenge_expired" }

export interface PairingController {
  open(socket: ServerWebSocket<PairingSocketData>): void
  handle(
    socket: ServerWebSocket<PairingSocketData>,
    raw: unknown,
    authenticate: (agent: AgentInfo) => void,
  ): Promise<void>
  close(socket: ServerWebSocket<PairingSocketData>): void
  prepare(): PairingChallenge | undefined
  present(challengeId: string, daemonEndpoint: string): PairingPresentation
  snapshot(): PairingSnapshot
  stop(): void
}

export function createPairingController(options: PairingControllerOptions): PairingController {
  const pairingTimeoutMs = options.pairingTimeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS
  const authTimeouts = new Map<ServerWebSocket<PairingSocketData>, ReturnType<typeof setTimeout>>()
  let pendingSocket: ServerWebSocket<PairingSocketData> | undefined
  let pendingAgent: AgentInfo | undefined
  let visiblePairing: PairingChallenge | undefined
  let pairingTimeout: ReturnType<typeof setTimeout> | undefined
  let outcome: PairingSnapshot["outcome"]

  function clearAuthTimeout(socket: ServerWebSocket<PairingSocketData>): void {
    const timeout = authTimeouts.get(socket)
    if (timeout !== undefined) {
      clearTimeout(timeout)
      authTimeouts.delete(socket)
    }
  }

  function clearChallenge(): void {
    if (pairingTimeout !== undefined) {
      clearTimeout(pairingTimeout)
      pairingTimeout = undefined
    }
    if (pendingSocket !== undefined) {
      pendingSocket.data.pairing = undefined
    }
    visiblePairing = undefined
  }

  function clearTimers(socket: ServerWebSocket<PairingSocketData>): void {
    clearAuthTimeout(socket)
    if (pendingSocket === socket) {
      clearChallenge()
      pendingSocket = undefined
      pendingAgent = undefined
      outcome = undefined
    }
  }

  function expireChallenge(challenge: PairingChallenge): void {
    const current = visiblePairing
    if (current?.challengeId !== challenge.challengeId) {
      return
    }
    const wasPresented = current.approvalState === "awaiting_user_approval"
    outcome = { state: "expired", challengeId: current.challengeId, agent: current.agent }
    clearChallenge()
    if (wasPresented && pendingSocket !== undefined) {
      pendingSocket.send(JSON.stringify({ type: "pair_expired" }))
    }
  }

  function prepare(): PairingChallenge | undefined {
    const socket = pendingSocket
    const agent = pendingAgent
    if (options.state.hasAgentCredential() || socket === undefined || agent === undefined) {
      return undefined
    }
    clearChallenge()
    outcome = undefined
    const randomCode = (crypto.getRandomValues(new Uint32Array(1)).at(0) ?? 0)
      .toString()
      .padStart(6, "0")
      .slice(-6)
    const challenge = {
      challengeId: crypto.randomUUID(),
      verificationCode: options.verificationCode?.() ?? randomCode,
      expiresAt: new Date(Date.now() + pairingTimeoutMs).toISOString(),
      approvalState: "ready_to_present" as const,
      agent,
    }
    visiblePairing = challenge
    pairingTimeout = setTimeout(() => expireChallenge(challenge), pairingTimeoutMs)
    return challenge
  }

  function present(challengeId: string, daemonEndpoint: string): PairingPresentation {
    const challenge = visiblePairing
    if (challenge === undefined || challenge.challengeId !== challengeId) {
      return {
        accepted: false,
        reason:
          outcome?.state === "expired" && outcome.challengeId === challengeId
            ? "challenge_expired"
            : "challenge_not_current",
      }
    }
    if (Date.parse(challenge.expiresAt) <= Date.now()) {
      expireChallenge(challenge)
      return { accepted: false, reason: "challenge_expired" }
    }
    if (challenge.approvalState === "awaiting_user_approval") {
      return { accepted: true }
    }
    const socket = pendingSocket
    if (socket === undefined) {
      clearChallenge()
      return { accepted: false, reason: "challenge_not_current" }
    }
    const presented = { ...challenge, approvalState: "awaiting_user_approval" as const }
    visiblePairing = presented
    socket.data.pairing = presented
    socket.send(
      JSON.stringify({
        type: "pair_challenge",
        challengeId: presented.challengeId,
        code: presented.verificationCode,
        expiresAt: presented.expiresAt,
        agent: presented.agent,
        daemon: { name: "Volt MCP", endpoint: daemonEndpoint },
      }),
    )
    return { accepted: true }
  }

  return {
    open(socket) {
      authTimeouts.set(
        socket,
        setTimeout(() => socket.close(1008, "Authentication timed out"), AUTH_TIMEOUT_MS),
      )
    },
    async handle(socket, raw, authenticate) {
      await options.state.refresh()
      const hello = helloMessageSchema.safeParse(raw)
      if (hello.success && options.state.verifyAgentCredential(hello.data.token)) {
        clearTimers(socket)
        socket.data.authenticated = true
        authenticate(hello.data.agent)
        return
      }
      if (hello.success) {
        socket.send(JSON.stringify({ type: "credential_rejected" }))
        socket.close(1008, "Credential rejected")
        return
      }
      const pairRequest = pairRequestMessageSchema.safeParse(raw)
      if (pairRequest.success) {
        if (options.state.hasAgentCredential()) {
          socket.send(JSON.stringify({ type: "pair_unavailable" }))
          socket.close(1008, "Volt MCP is already paired")
          return
        }
        clearAuthTimeout(socket)
        if (pendingSocket !== undefined && pendingSocket !== socket) {
          clearChallenge()
          pendingSocket.close(1012, "Replaced by a newer Volt client")
        }
        pendingSocket = socket
        pendingAgent = pairRequest.data.agent
        outcome = undefined
        return
      }
      const decision = pairDecisionMessageSchema.safeParse(raw)
      const pairing = socket.data.pairing
      if (
        !decision.success ||
        pairing === undefined ||
        decision.data.challengeId !== pairing.challengeId ||
        visiblePairing?.challengeId !== pairing.challengeId ||
        visiblePairing.approvalState !== "awaiting_user_approval" ||
        pendingSocket !== socket
      ) {
        if (decision.success) {
          socket.send(JSON.stringify({ type: "pair_stale" }))
          return
        }
        socket.close(1008, "Authentication failed")
        return
      }
      if (Date.parse(pairing.expiresAt) <= Date.now()) {
        expireChallenge(pairing)
        return
      }
      clearChallenge()
      if (!decision.data.approved) {
        outcome = { state: "declined", challengeId: pairing.challengeId, agent: pairing.agent }
        socket.send(JSON.stringify({ type: "pair_denied" }))
        return
      }
      const token =
        options.agentToken?.() ??
        crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "")
      await options.state.pairAgent(token)
      socket.send(JSON.stringify({ type: "pair_complete", token }))
    },
    close: clearTimers,
    prepare,
    present,
    snapshot() {
      return { pendingAgent, challenge: visiblePairing, outcome }
    },
    stop() {
      for (const timeout of authTimeouts.values()) {
        clearTimeout(timeout)
      }
      authTimeouts.clear()
      clearChallenge()
      pendingSocket = undefined
      pendingAgent = undefined
      visiblePairing = undefined
      outcome = undefined
    },
  }
}
