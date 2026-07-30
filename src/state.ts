import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"

const persistedStateSchema = z.object({
  version: z.literal(1),
  clientToken: z.string().length(64),
  agentTokenHash: z.string().length(64).optional(),
  runtimeRoot: z.string().min(1).optional(),
})

type PersistedState = z.infer<typeof persistedStateSchema>

export class LocalDaemonState {
  readonly clientToken: string
  readonly path: string
  private agentTokenHash: string | undefined
  private runtimeRootValue: string | undefined

  constructor(path: string, value: PersistedState) {
    this.path = path
    this.clientToken = value.clientToken
    this.agentTokenHash = value.agentTokenHash
    this.runtimeRootValue = value.runtimeRoot
  }

  get runtimeRoot(): string | undefined {
    return this.runtimeRootValue
  }

  hasAgentCredential(): boolean {
    return this.agentTokenHash !== undefined
  }

  verifyAgentCredential(token: string): boolean {
    if (this.agentTokenHash === undefined) {
      return false
    }
    const actual = Buffer.from(hashToken(token), "hex")
    const expected = Buffer.from(this.agentTokenHash, "hex")
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  async pairAgent(token: string): Promise<void> {
    this.agentTokenHash = hashToken(token)
    await this.persist()
  }

  async clearAgentCredential(): Promise<void> {
    this.agentTokenHash = undefined
    await this.persist()
  }

  async setRuntimeRoot(runtimeRoot: string): Promise<void> {
    this.runtimeRootValue = runtimeRoot
    await this.persist()
  }

  async refresh(): Promise<void> {
    const value = persistedStateSchema.parse(JSON.parse(await readFile(this.path, "utf8")))
    if (value.clientToken !== this.clientToken) {
      throw new Error("Volt MCP client authorization changed while the daemon was running")
    }
    this.agentTokenHash = value.agentTokenHash
    this.runtimeRootValue = value.runtimeRoot
  }

  private async persist(): Promise<void> {
    const value: PersistedState = {
      version: 1,
      clientToken: this.clientToken,
      ...(this.agentTokenHash === undefined ? {} : { agentTokenHash: this.agentTokenHash }),
      ...(this.runtimeRootValue === undefined ? {} : { runtimeRoot: this.runtimeRootValue }),
    }
    await writePrivateJson(this.path, value)
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

async function writePrivateJson(path: string, value: PersistedState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  if (process.platform !== "win32") {
    await chmod(temporaryPath, 0o600)
  }
  await rename(temporaryPath, path)
}

export function defaultStatePath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = environment["VOLT_MCP_STATE_PATH"]?.trim()
  if (configured !== undefined && configured.length > 0) {
    return configured
  }
  const localData = environment["LOCALAPPDATA"]?.trim()
  return localData === undefined || localData.length === 0
    ? join(homedir(), ".local", "state", "volt-mcp", "state.json")
    : join(localData, "volt-mcp", "state.json")
}

export async function loadDaemonState(path = defaultStatePath()): Promise<LocalDaemonState> {
  let value: PersistedState
  try {
    value = persistedStateSchema.parse(JSON.parse(await readFile(path, "utf8")))
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error
    }
    value = { version: 1, clientToken: randomBytes(32).toString("hex") }
    await writePrivateJson(path, value)
  }
  return new LocalDaemonState(path, value)
}
