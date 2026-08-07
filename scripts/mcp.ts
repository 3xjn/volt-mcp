type JsonRpcId = number | string | null
type JsonRpcMessage = Readonly<Record<string, unknown>>
type AdapterState = {
  readonly clientToken: string
  readonly runtimeRoot?: string
}

const DEFAULT_ENDPOINT = "http://127.0.0.1:32146/mcp"
const SESSION_HEADER = "mcp-session-id"
const SERVER_INFO = {
  name: "volt-mcp",
  version: "0.1.1",
  title: "Volt MCP for Roblox",
  icons: [
    {
      src: "https://images.rbxcdn.com/905bd722ee0a6ceda3caacde54c0b081.png",
      mimeType: "image/png",
      sizes: ["180x180"],
    },
  ],
}

let mode: "pending" | "setup" | "live" = "pending"
let sessionId: string | undefined
let token: string | undefined
let statePath: string | undefined

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requestId(message: JsonRpcMessage): JsonRpcId | undefined {
  const { id } = message
  return typeof id === "number" || typeof id === "string" || id === null ? id : undefined
}

function writeMessage(message: JsonRpcMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function writeResult(id: JsonRpcId, result: unknown): void {
  writeMessage({ jsonrpc: "2.0", id, result })
}

function writeError(id: JsonRpcId, code: number, message: string): void {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } })
}

function resolveStatePath(): string | undefined {
  const configured = process.env["VOLT_MCP_STATE_PATH"]?.trim()
  if (configured !== undefined && configured.length > 0) {
    return configured
  }
  const localData = process.env["LOCALAPPDATA"]?.trim()
  return localData === undefined || localData.length === 0
    ? undefined
    : `${localData}\\volt-mcp\\state.json`
}

async function readState(): Promise<AdapterState | undefined> {
  statePath = resolveStatePath()
  if (statePath === undefined) {
    return undefined
  }
  try {
    const value: unknown = await Bun.file(statePath).json()
    if (!isObject(value)) {
      return undefined
    }
    const clientToken = value["clientToken"]
    if (typeof clientToken !== "string" || clientToken.length !== 64) {
      return undefined
    }
    const runtimeRoot = value["runtimeRoot"]
    return {
      clientToken,
      ...(typeof runtimeRoot === "string" && runtimeRoot.length > 0 ? { runtimeRoot } : {}),
    }
  } catch {
    return undefined
  }
}

function endpoint(): URL {
  return new URL(process.env["VOLT_MCP_ENDPOINT"] ?? DEFAULT_ENDPOINT)
}

async function relay(message: JsonRpcMessage): Promise<Response> {
  if (token === undefined) {
    throw new Error("Volt MCP client authorization is unavailable")
  }
  return await fetch(endpoint(), {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(sessionId === undefined ? {} : { "Mcp-Session-Id": sessionId }),
    },
    body: JSON.stringify(message),
  })
}

function startDaemon(runtimeRoot: string): void {
  if (statePath === undefined) {
    return
  }
  const child = Bun.spawn({
    cmd: [process.execPath, "run", "src/index.ts"],
    cwd: runtimeRoot,
    env: { ...process.env, VOLT_MCP_STATE_PATH: statePath },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  })
  child.unref()
}

async function connect(
  message: JsonRpcMessage,
  state: AdapterState,
): Promise<Response | undefined> {
  token = state.clientToken
  try {
    const response = await relay(message)
    if (response.ok || state.runtimeRoot === undefined) {
      return response
    }
  } catch {
    if (state.runtimeRoot === undefined) {
      return undefined
    }
  }
  startDaemon(state.runtimeRoot)
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await Bun.sleep(100)
    try {
      const response = await relay(message)
      if (response.ok) {
        return response
      }
    } catch {}
  }
  return undefined
}

async function writeRelayedResponse(response: Response, id: JsonRpcId | undefined): Promise<void> {
  const initializedSession = response.headers.get(SESSION_HEADER)
  if (initializedSession !== null) {
    sessionId = initializedSession
  }
  if (response.status === 202 || response.status === 204) {
    return
  }
  const body = await response.text()
  if (!response.ok) {
    if (id !== undefined) {
      writeError(id, -32_000, `Volt MCP daemon returned HTTP ${response.status}`)
    }
    return
  }
  if (body.length > 0) {
    const payload: unknown = JSON.parse(body)
    if (isObject(payload)) {
      writeMessage(payload)
    }
  }
}

function setupResponse(message: JsonRpcMessage): void {
  const id = requestId(message)
  if (id === undefined) {
    return
  }
  if (message["method"] === "initialize") {
    const params = isObject(message["params"]) ? message["params"] : {}
    const protocolVersion =
      typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : "2025-06-18"
    writeResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions:
        "Volt MCP needs one-time local setup. Use the setup-volt-mcp skill, then start a new MCP session.",
    })
    return
  }
  if (message["method"] === "tools/list") {
    writeResult(id, { tools: [] })
    return
  }
  if (message["method"] === "ping") {
    writeResult(id, {})
    return
  }
  writeError(id, -32_002, "Volt MCP needs one-time local setup")
}

async function handleMessage(message: JsonRpcMessage): Promise<void> {
  const id = requestId(message)
  if (mode === "pending" && message["method"] === "initialize") {
    const state = await readState()
    const response = state === undefined ? undefined : await connect(message, state)
    if (response?.ok) {
      mode = "live"
      await writeRelayedResponse(response, id)
      return
    }
    mode = "setup"
  }
  if (mode === "live") {
    try {
      await writeRelayedResponse(await relay(message), id)
    } catch {
      if (id !== undefined) {
        writeError(id, -32_000, "Volt MCP daemon is unavailable")
      }
    }
    return
  }
  setupResponse(message)
}

async function closeSession(): Promise<void> {
  if (mode !== "live" || sessionId === undefined || token === undefined) {
    return
  }
  try {
    await fetch(endpoint(), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId },
    })
  } catch {
    return
  }
}

const decoder = new TextDecoder()
let buffered = ""
for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true })
  const lines = buffered.split(/\r?\n/)
  buffered = lines.pop() ?? ""
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue
    }
    const parsed: unknown = JSON.parse(line)
    if (isObject(parsed)) {
      await handleMessage(parsed)
    }
  }
}
buffered += decoder.decode()
if (buffered.trim().length > 0) {
  const parsed: unknown = JSON.parse(buffered)
  if (isObject(parsed)) {
    await handleMessage(parsed)
  }
}
await closeSession()

export {}
