export class BridgeUnavailableError extends Error {
  readonly name = "BridgeUnavailableError"

  constructor() {
    super("No authenticated Volt client is connected")
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
