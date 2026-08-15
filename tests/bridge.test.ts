import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type LiveBridge, startBridge } from "../src/bridge.js"
import {
  BridgeClientNotFoundError,
  BridgeClientSelectionError,
  BridgeDisconnectedError,
  BridgeTimeoutError,
  BridgeUnavailableError,
} from "../src/errors.js"
import { type AgentInfo, requestMessageSchema, responseMessageSchema } from "../src/protocol.js"
import { type LocalDaemonState, loadDaemonState } from "../src/state.js"

const AGENT_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef"
const AGENT: AgentInfo = {
  agentVersion: "test",
  gameId: 42,
  placeId: 123,
  jobId: "job",
  playerName: "Builder",
  userId: 456,
}
const SECOND_AGENT: AgentInfo = {
  ...AGENT,
  playerName: "SecondBuilder",
  userId: 789,
}

let bridge: LiveBridge | undefined
let socket: WebSocket | undefined
let secondarySocket: WebSocket | undefined
let state: LocalDaemonState | undefined
let temporaryDirectory: string | undefined

class TestHarnessError extends Error {
  readonly name = "TestHarnessError"
}

function waitForOpen(client: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    client.addEventListener("open", () => resolve(), { once: true })
    client.addEventListener(
      "error",
      () => reject(new TestHarnessError("WebSocket failed to open")),
      { once: true },
    )
  })
}

function waitForMessage(client: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    client.addEventListener(
      "message",
      (event) => {
        if (typeof event.data !== "string") {
          reject(new TestHarnessError("Expected a text frame"))
          return
        }
        try {
          resolve(JSON.parse(event.data))
        } catch (error) {
          if (error instanceof SyntaxError) {
            reject(error)
            return
          }
          throw error
        }
      },
      { once: true },
    )
  })
}

async function openAgent(): Promise<WebSocket> {
  if (bridge === undefined) {
    throw new TestHarnessError("Bridge was not started")
  }
  const client = new WebSocket(`ws://127.0.0.1:${bridge.port}/volt`)
  await waitForOpen(client)
  return client
}

async function createState(): Promise<LocalDaemonState> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "volt-mcp-bridge-"))
  state = await loadDaemonState(join(temporaryDirectory, "state.json"))
  return state
}

async function registerAgent(client: WebSocket): Promise<void> {
  client.send(JSON.stringify({ type: "pair_request", agent: AGENT }))
  for (let attempts = 0; attempts < 20; attempts += 1) {
    if (bridge?.status().state === "ready_to_pair") {
      return
    }
    await Bun.sleep(5)
  }
  throw new TestHarnessError("Agent registration did not become visible")
}

async function authenticateAgent(client: WebSocket, agent: AgentInfo): Promise<void> {
  const ready = waitForMessage(client)
  client.send(JSON.stringify({ type: "hello", token: AGENT_TOKEN, agent }))
  expect(await ready).toEqual({ type: "ready" })
}

async function waitForClientCount(expected: number): Promise<void> {
  for (let attempts = 0; attempts < 40; attempts += 1) {
    if (bridge?.listClients().length === expected) {
      return
    }
    await Bun.sleep(5)
  }
  throw new TestHarnessError(`Connected client count did not become ${expected}`)
}

async function expectNoMessage(client: WebSocket, durationMs = 20): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onMessage = () => {
      clearTimeout(timeout)
      client.removeEventListener("message", onMessage)
      reject(new TestHarnessError("Received an unexpected WebSocket message"))
    }
    const timeout = setTimeout(() => {
      client.removeEventListener("message", onMessage)
      resolve()
    }, durationMs)
    client.addEventListener("message", onMessage)
  })
}

afterEach(async () => {
  await bridge?.stop()
  socket?.close()
  secondarySocket?.close()
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
  socket = undefined
  secondarySocket = undefined
  bridge = undefined
  state = undefined
  temporaryDirectory = undefined
})

describe("live bridge", () => {
  test("rejects requests without an authenticated Volt client", async () => {
    // Given no Roblox agent has paired
    const daemonState = await createState()
    bridge = startBridge({ state: daemonState, port: 0 })

    // Then the MCP surface stays available and reports an unpaired Roblox state
    expect(bridge.status()).toEqual({ state: "unpaired", paired: false, connected: false })
    await expect(bridge.request("status", {})).rejects.toBeInstanceOf(BridgeUnavailableError)
  })

  test("prepares through MCP before presenting a correlated approval", async () => {
    // Given an unpaired agent has registered without triggering a prompt
    const daemonState = await createState()
    bridge = startBridge({
      state: daemonState,
      port: 0,
      verificationCode: () => "314159",
      agentToken: () => AGENT_TOKEN,
    })
    socket = await openAgent()
    await registerAgent(socket)
    await expectNoMessage(socket)
    expect(bridge.status()).toEqual({
      state: "ready_to_pair",
      paired: false,
      connected: false,
      pendingRobloxSession: AGENT,
    })

    // When the MCP client prepares the challenge
    const prepared = bridge.preparePairing()
    if (prepared.state !== "challenge_ready") {
      throw new TestHarnessError("Expected a prepared challenge")
    }
    expect(prepared).toMatchObject({
      state: "challenge_ready",
      paired: false,
      connected: false,
      challenge: {
        verificationCode: "314159",
        approvalState: "ready_to_present",
        pendingRobloxSession: AGENT,
        daemon: {
          name: "Volt MCP",
          endpoint: `ws://127.0.0.1:${bridge.port}/volt`,
        },
        authorization: {
          codePurpose: "correlation_only",
          approvalAuthority: "volt_messagebox_yes",
          persistence: "until_pairing_reset",
        },
      },
    })
    expect(prepared.challenge.challengeId).toBeString()
    expect(prepared.challenge.expiresAt).toBeString()
    expect(prepared.challenge.nextAction).toBeString()
    await expectNoMessage(socket)
    expect(bridge.status()).toEqual(prepared)

    // And only an explicit present call sends the challenge to Roblox
    const challengeReceived = waitForMessage(socket)
    expect(bridge.presentPairing(prepared.challenge.challengeId)).toMatchObject({
      accepted: true,
      state: "awaiting_user_approval",
    })
    expect(await challengeReceived).toMatchObject({
      type: "pair_challenge",
      challengeId: prepared.challenge.challengeId,
      code: "314159",
      expiresAt: prepared.challenge.expiresAt,
      agent: AGENT,
    })

    // When Roblox approves the matching short-lived challenge
    const completed = waitForMessage(socket)
    socket.send(
      JSON.stringify({
        type: "pair_decision",
        challengeId: prepared.challenge.challengeId,
        approved: true,
      }),
    )
    expect(await completed).toEqual({ type: "pair_complete", token: AGENT_TOKEN })
    const ready = waitForMessage(socket)
    socket.send(JSON.stringify({ type: "hello", token: AGENT_TOKEN, agent: AGENT }))

    // Then the persistent agent credential authenticates requests
    expect(await ready).toEqual({ type: "ready" })
    expect(bridge.status()).toEqual({
      state: "connected",
      paired: true,
      connected: true,
      agent: AGENT,
    })

    const requestReceived = waitForMessage(socket)
    const pendingResult = bridge.request("status", {})
    const request = requestMessageSchema.parse(await requestReceived)
    socket.send(
      JSON.stringify(
        responseMessageSchema.parse({
          type: "response",
          id: request.id,
          ok: true,
          result: { healthy: true },
        }),
      ),
    )

    await expect(pendingResult).resolves.toEqual({ healthy: true })
    expect(daemonState.verifyAgentCredential(AGENT_TOKEN)).toBe(true)
  })

  test("times out a request that the agent does not answer", async () => {
    // Given a previously paired Roblox agent reconnects
    const daemonState = await createState()
    await daemonState.pairAgent(AGENT_TOKEN)
    bridge = startBridge({ state: daemonState, port: 0 })
    socket = await openAgent()
    const ready = waitForMessage(socket)
    socket.send(JSON.stringify({ type: "hello", token: AGENT_TOKEN, agent: AGENT }))
    await ready

    // When it does not answer a request, then the request times out
    await expect(bridge.request("status", {}, 10)).rejects.toBeInstanceOf(BridgeTimeoutError)
  })

  test("keeps same-job clients connected and scopes routing and cleanup by client", async () => {
    // Given two paired Volt clients are connected to the same Roblox job
    const daemonState = await createState()
    await daemonState.pairAgent(AGENT_TOKEN)
    bridge = startBridge({ state: daemonState, port: 0 })
    socket = await openAgent()
    await authenticateAgent(socket, AGENT)
    secondarySocket = await openAgent()
    await authenticateAgent(secondarySocket, SECOND_AGENT)

    const clients = bridge.listClients()
    const firstClient = clients.find(({ agent }) => agent.userId === AGENT.userId)
    const secondClient = clients.find(({ agent }) => agent.userId === SECOND_AGENT.userId)
    if (firstClient === undefined || secondClient === undefined) {
      throw new TestHarnessError("Expected both connected clients")
    }

    // Then each socket remains live and receives a stable, distinct daemon-issued ID
    expect(socket.readyState).toBe(WebSocket.OPEN)
    expect(secondarySocket.readyState).toBe(WebSocket.OPEN)
    expect(firstClient.client).not.toBe(secondClient.client)
    expect(bridge.listClients()).toEqual(clients)
    expect(bridge.status()).toEqual({
      state: "connected",
      paired: true,
      connected: true,
      clients,
    })
    await expect(bridge.request("status", {})).rejects.toBeInstanceOf(BridgeClientSelectionError)
    await expect(
      bridge.request("status", {}, undefined, crypto.randomUUID()),
    ).rejects.toBeInstanceOf(BridgeClientNotFoundError)

    // When requests are addressed explicitly, each reaches only its selected socket
    const firstRequestReceived = waitForMessage(socket)
    const firstPending = bridge.request("status", { marker: "first" }, 5_000, firstClient.client)
    const firstOutcome = firstPending.then(
      () => new TestHarnessError("Disconnected request unexpectedly resolved"),
      (error: unknown) => error,
    )
    const firstRequest = requestMessageSchema.parse(await firstRequestReceived)
    expect(firstRequest.params).toEqual({ marker: "first" })
    await expectNoMessage(secondarySocket)

    const secondRequestReceived = waitForMessage(secondarySocket)
    const secondPending = bridge.request("status", { marker: "second" }, 5_000, secondClient.client)
    const secondRequest = requestMessageSchema.parse(await secondRequestReceived)
    expect(secondRequest.params).toEqual({ marker: "second" })

    // And invalidating one client rejects only its own request through the disconnect path
    socket.send(JSON.stringify({ type: "invalid" }))
    await waitForClientCount(1)
    expect(await firstOutcome).toBeInstanceOf(BridgeDisconnectedError)

    secondarySocket.send(
      JSON.stringify({
        type: "response",
        id: secondRequest.id,
        ok: true,
        result: { client: "second" },
      }),
    )
    await expect(secondPending).resolves.toEqual({ client: "second" })
    expect(secondarySocket.readyState).toBe(WebSocket.OPEN)
    expect(bridge.listClients()).toEqual([secondClient])
  })

  test("denies pairing without persisting a credential", async () => {
    // Given MCP prepares and presents a valid pairing challenge
    const daemonState = await createState()
    bridge = startBridge({ state: daemonState, port: 0, verificationCode: () => "271828" })
    socket = await openAgent()
    await registerAgent(socket)
    const prepared = bridge.preparePairing()
    if (prepared.state !== "challenge_ready") {
      throw new TestHarnessError("Expected a prepared challenge")
    }
    const challengeReceived = waitForMessage(socket)
    bridge.presentPairing(prepared.challenge.challengeId)
    await challengeReceived

    // When the user denies it
    const denied = waitForMessage(socket)
    socket.send(
      JSON.stringify({
        type: "pair_decision",
        challengeId: prepared.challenge.challengeId,
        approved: false,
      }),
    )

    // Then no persistent credential is created
    expect(await denied).toEqual({ type: "pair_denied" })
    await Bun.sleep(20)
    expect(bridge.status()).toEqual({
      state: "pairing_declined",
      paired: false,
      connected: false,
      pendingRobloxSession: AGENT,
      retryable: true,
    })
    expect(daemonState.hasAgentCredential()).toBe(false)
  })

  test("expires an unanswered pairing challenge", async () => {
    // Given a challenge with a short test lifetime
    const daemonState = await createState()
    bridge = startBridge({
      state: daemonState,
      port: 0,
      pairingTimeoutMs: 200,
      verificationCode: () => "161803",
    })
    socket = await openAgent()
    await registerAgent(socket)
    const prepared = bridge.preparePairing()
    if (prepared.state !== "challenge_ready") {
      throw new TestHarnessError("Expected a prepared challenge")
    }
    const challengeReceived = waitForMessage(socket)
    bridge.presentPairing(prepared.challenge.challengeId)
    await challengeReceived

    // When no approval arrives before expiry, then the challenge clears without pairing
    const expired = await waitForMessage(socket)
    expect(expired).toEqual({ type: "pair_expired" })
    await Bun.sleep(20)
    expect(daemonState.hasAgentCredential()).toBe(false)
    expect(bridge.status()).toEqual({
      state: "pairing_expired",
      paired: false,
      connected: false,
      pendingRobloxSession: AGENT,
      retryable: true,
    })
  })

  test("rejects wrong, replaced, and expired challenge results", async () => {
    // Given challenge A was presented and then replaced by challenge B
    const daemonState = await createState()
    const codes = ["111111", "222222", "333333"]
    bridge = startBridge({
      state: daemonState,
      port: 0,
      pairingTimeoutMs: 20,
      verificationCode: () => codes.shift() ?? "999999",
    })
    socket = await openAgent()
    await registerAgent(socket)
    const challengeA = bridge.preparePairing()
    if (challengeA.state !== "challenge_ready") {
      throw new TestHarnessError("Expected challenge A")
    }
    const firstPrompt = waitForMessage(socket)
    bridge.presentPairing(challengeA.challenge.challengeId)
    await firstPrompt
    const challengeB = bridge.preparePairing()
    if (challengeB.state !== "challenge_ready") {
      throw new TestHarnessError("Expected challenge B")
    }

    // Wrong and replaced identifiers do not display or authorize anything
    expect(bridge.presentPairing(crypto.randomUUID())).toEqual({
      accepted: false,
      reason: "challenge_not_current",
    })
    const staleDecision = waitForMessage(socket)
    socket.send(
      JSON.stringify({
        type: "pair_decision",
        challengeId: challengeA.challenge.challengeId,
        approved: true,
      }),
    )
    expect(await staleDecision).toEqual({ type: "pair_stale" })
    expect(daemonState.hasAgentCredential()).toBe(false)
    expect(bridge.status()).toEqual(challengeB)

    // Once B expires, continuation and a late Yes remain rejected
    await Bun.sleep(25)
    expect(bridge.presentPairing(challengeB.challenge.challengeId)).toEqual({
      accepted: false,
      reason: "challenge_expired",
    })
    expect(daemonState.hasAgentCredential()).toBe(false)
    expect(bridge.status().state).toBe("pairing_expired")
  })

  test("persists pairing and reports waiting until Roblox reconnects", async () => {
    // Given a credential was paired and persisted without storing its plaintext
    const daemonState = await createState()
    await daemonState.pairAgent(AGENT_TOKEN)
    const statePath = join(temporaryDirectory ?? "", "state.json")
    const persisted = await readFile(statePath, "utf8")
    expect(persisted).not.toContain(AGENT_TOKEN)

    // When a new daemon instance loads that state before Roblox opens
    state = await loadDaemonState(statePath)
    bridge = startBridge({ state, port: 0 })

    // Then MCP reports the paired-but-waiting state and accepts the persisted reconnect
    expect(bridge.status()).toEqual({
      state: "waiting_for_roblox",
      paired: true,
      connected: false,
    })
    socket = await openAgent()
    const ready = waitForMessage(socket)
    socket.send(JSON.stringify({ type: "hello", token: AGENT_TOKEN, agent: AGENT }))
    expect(await ready).toEqual({ type: "ready" })
  })

  test("does not accept an incorrect persistent credential", async () => {
    // Given a paired daemon
    const daemonState = await createState()
    await daemonState.pairAgent(AGENT_TOKEN)
    bridge = startBridge({ state: daemonState, port: 0 })
    socket = await openAgent()

    // When a different credential is presented, then authentication fails
    socket.send(JSON.stringify({ type: "hello", token: "fedcba".repeat(8), agent: AGENT }))
    await Bun.sleep(20)
    expect(bridge.status()).toEqual({
      state: "waiting_for_roblox",
      paired: true,
      connected: false,
    })
    expect(socket.readyState).not.toBe(WebSocket.OPEN)
  })
})
