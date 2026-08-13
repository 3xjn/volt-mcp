export class BridgeUnavailableError extends Error {
  readonly name = "BridgeUnavailableError"

  constructor() {
    super("No authenticated Volt client is connected")
  }
}

export class BridgeClientSelectionError extends Error {
  readonly name = "BridgeClientSelectionError"

  constructor() {
    super(
      "Multiple authenticated Volt clients are connected; pass a client returned by roblox_list_clients",
    )
  }
}

export class BridgeClientNotFoundError extends Error {
  readonly name = "BridgeClientNotFoundError"

  constructor(readonly client: string) {
    super(`Volt client ${client} is not connected; call roblox_list_clients for current clients`)
  }
}

export class BridgeTimeoutError extends Error {
  readonly name = "BridgeTimeoutError"

  constructor(
    readonly requestId: string,
    readonly timeoutMs: number,
  ) {
    super(`Volt request ${requestId} timed out after ${timeoutMs}ms`)
  }
}

export class AgentRequestError extends Error {
  readonly name = "AgentRequestError"

  constructor(
    readonly requestId: string,
    message: string,
  ) {
    super(message)
  }
}

export class BridgeDisconnectedError extends Error {
  readonly name = "BridgeDisconnectedError"

  constructor() {
    super("The Volt client disconnected before the request completed")
  }
}

export class BridgeStartupError extends Error {
  readonly name = "BridgeStartupError"
}
