import { randomBytes } from "node:crypto"
import { copyFile, cp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

type SetupState = {
  readonly version: 1
  readonly clientToken: string
  readonly agentTokenHash?: string
  readonly runtimeRoot: string
}

export type InstallOptions = {
  readonly sourceRoot: string
  readonly voltRoot: string
  readonly runtimeRoot: string
  readonly statePath: string
  readonly installDependencies: boolean
  readonly startDaemon: boolean
}

export type SetupStatus = {
  readonly installed: boolean
  readonly daemonAvailable: boolean
  readonly paired: boolean
  readonly runtimeRoot: string
  readonly voltRoot: string
  readonly firstRunAction: string
  readonly bootstrapCommand: string
}

const LOADER = `local source = readfile("volt-mcp/volt-agent.lua")
local chunk, compileError = loadstring(source, "Volt MCP")
assert(chunk, compileError)()
`
const BOOTSTRAP_COMMAND = 'loadstring(readfile("volt-mcp/bootstrap.lua"), "Volt MCP bootstrap")()'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseState(value: unknown): SetupState {
  if (!isObject(value)) {
    throw new Error("Volt MCP state is not a JSON object")
  }
  const clientToken = value["clientToken"]
  const runtimeRoot = value["runtimeRoot"]
  const agentTokenHash = value["agentTokenHash"]
  if (
    value["version"] !== 1 ||
    typeof clientToken !== "string" ||
    clientToken.length !== 64 ||
    typeof runtimeRoot !== "string" ||
    runtimeRoot.length === 0 ||
    !(
      agentTokenHash === undefined ||
      (typeof agentTokenHash === "string" && agentTokenHash.length === 64)
    )
  ) {
    throw new Error("Volt MCP state has an invalid shape")
  }
  return {
    version: 1,
    clientToken,
    runtimeRoot,
    ...(typeof agentTokenHash === "string" ? { agentTokenHash } : {}),
  }
}

async function readState(path: string): Promise<SetupState | undefined> {
  try {
    return parseState(JSON.parse(await readFile(path, "utf8")))
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined
    }
    throw error
  }
}

async function writeState(path: string, state: SetupState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await rename(temporaryPath, path)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false
    }
    throw error
  }
}

async function copyRuntime(options: InstallOptions): Promise<void> {
  await mkdir(options.runtimeRoot, { recursive: true })
  await Promise.all([
    copyFile(join(options.sourceRoot, "package.json"), join(options.runtimeRoot, "package.json")),
    copyFile(join(options.sourceRoot, "bun.lock"), join(options.runtimeRoot, "bun.lock")),
    cp(join(options.sourceRoot, "src"), join(options.runtimeRoot, "src"), {
      recursive: true,
      force: true,
    }),
  ])
  const agentDirectory = join(options.voltRoot, "workspace", "volt-mcp")
  const autoexecDirectory = join(options.voltRoot, "autoexec")
  await Promise.all([
    mkdir(agentDirectory, { recursive: true }),
    mkdir(autoexecDirectory, { recursive: true }),
  ])
  await copyFile(join(options.sourceRoot, "volt-agent.lua"), join(agentDirectory, "volt-agent.lua"))
  await Promise.all([
    writeFile(join(agentDirectory, "bootstrap.lua"), LOADER, "utf8"),
    writeFile(join(autoexecDirectory, "volt-mcp.lua"), LOADER, "utf8"),
  ])
}

async function installRuntimeDependencies(runtimeRoot: string): Promise<void> {
  const child = Bun.spawn({
    cmd: [process.execPath, "install", "--frozen-lockfile", "--production"],
    cwd: runtimeRoot,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) {
    throw new Error(`Bun dependency installation failed with exit code ${exitCode}`)
  }
}

async function daemonAvailable(clientToken: string): Promise<boolean> {
  try {
    const response = await fetch("http://127.0.0.1:32146/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${clientToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "volt-mcp-setup", version: "0.1.0" },
        },
      }),
    })
    return response.ok
  } catch {
    return false
  }
}

async function stopDaemon(clientToken: string): Promise<void> {
  try {
    const response = await fetch("http://127.0.0.1:32146/admin/shutdown", {
      method: "POST",
      headers: { Authorization: `Bearer ${clientToken}` },
    })
    if (response.status !== 202) {
      return
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await Bun.sleep(50)
      if (!(await daemonAvailable(clientToken))) {
        return
      }
    }
  } catch {
    return
  }
}

async function startDaemon(options: InstallOptions, state: SetupState): Promise<boolean> {
  await stopDaemon(state.clientToken)
  const child = Bun.spawn({
    cmd: [process.execPath, "run", "src/index.ts"],
    cwd: options.runtimeRoot,
    env: { ...process.env, VOLT_MCP_STATE_PATH: options.statePath },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  })
  child.unref()
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await Bun.sleep(100)
    if (await daemonAvailable(state.clientToken)) {
      return true
    }
  }
  return false
}

export async function inspectSetup(options: InstallOptions): Promise<SetupStatus> {
  const state = await readState(options.statePath)
  const installed =
    state !== undefined &&
    (await pathExists(join(options.runtimeRoot, "src", "index.ts"))) &&
    (await pathExists(join(options.voltRoot, "autoexec", "volt-mcp.lua")))
  return {
    installed,
    daemonAvailable: state === undefined ? false : await daemonAvailable(state.clientToken),
    paired: state?.agentTokenHash !== undefined,
    runtimeRoot: options.runtimeRoot,
    voltRoot: options.voltRoot,
    firstRunAction: "Rejoin or reinject Roblox once so Volt runs the new autoexec bootstrap.",
    bootstrapCommand: BOOTSTRAP_COMMAND,
  }
}

export async function installVoltMcp(options: InstallOptions): Promise<SetupStatus> {
  const existing = await readState(options.statePath)
  const state: SetupState = {
    version: 1,
    clientToken: existing?.clientToken ?? randomBytes(32).toString("hex"),
    runtimeRoot: options.runtimeRoot,
    ...(existing?.agentTokenHash === undefined ? {} : { agentTokenHash: existing.agentTokenHash }),
  }
  await copyRuntime(options)
  await writeState(options.statePath, state)
  if (options.installDependencies) {
    await installRuntimeDependencies(options.runtimeRoot)
  }
  if (options.startDaemon && !(await startDaemon(options, state))) {
    throw new Error("Volt MCP daemon did not become ready; stop an older daemon and rerun setup")
  }
  return await inspectSetup(options)
}

export async function resetPairing(statePath: string): Promise<void> {
  const state = await readState(statePath)
  if (state === undefined) {
    throw new Error("Volt MCP is not installed")
  }
  await writeState(statePath, {
    version: 1,
    clientToken: state.clientToken,
    runtimeRoot: state.runtimeRoot,
  })
}
