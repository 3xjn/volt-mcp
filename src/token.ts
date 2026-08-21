import { randomBytes } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { BridgeStartupError } from "./errors.js"

const TOKEN_BYTES = 32
const TOKEN_MIN_LENGTH = 32
const TOKEN_MAX_LENGTH = 256
const TOKEN_DIR = "roblox-client-mcp"
const TOKEN_FILE = "token"

export type EnvMap = {
  readonly LOCALAPPDATA?: string
  readonly XDG_CONFIG_HOME?: string
  readonly HOME?: string
  readonly USERPROFILE?: string
  readonly ROBLOX_CLIENT_MCP_TOKEN?: string
}

export type TokenPathOptions = {
  readonly env?: EnvMap
  readonly cwd?: string
  readonly platform?: NodeJS.Platform
}

export type ResolvedToken =
  | { readonly token: string; readonly source: "env" }
  | {
      readonly token: string
      readonly source: "file"
      readonly path: string
      readonly created: boolean
    }

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex")
}

export function tokenFilePath(options: TokenPathOptions = {}): string {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const platform = options.platform ?? process.platform
  const localAppData = env.LOCALAPPDATA
  if (platform === "win32" && localAppData !== undefined && localAppData.length > 0) {
    return join(localAppData, TOKEN_DIR, TOKEN_FILE)
  }
  const xdg = env.XDG_CONFIG_HOME
  if (xdg !== undefined && xdg.length > 0) {
    return join(xdg, TOKEN_DIR, TOKEN_FILE)
  }
  const home = env.HOME
  if (home !== undefined && home.length > 0) {
    return join(home, ".config", TOKEN_DIR, TOKEN_FILE)
  }
  const userProfile = env.USERPROFILE
  if (userProfile !== undefined && userProfile.length > 0) {
    return join(userProfile, ".config", TOKEN_DIR, TOKEN_FILE)
  }
  return join(cwd, TOKEN_DIR, TOKEN_FILE)
}

function isUsableToken(value: string): boolean {
  return value.length >= TOKEN_MIN_LENGTH && value.length <= TOKEN_MAX_LENGTH
}

function luaQuoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`
}

export function loaderSnippet(token: string): string {
  return `getgenv().RobloxClientMcp = {
    Token = ${luaQuoted(token)},
}

loadstring(readfile("agent.lua"), "roblox-client-mcp")()`
}

export function formatStartupNotice(resolved: ResolvedToken): string {
  const stored =
    resolved.source === "env"
      ? "from ROBLOX_CLIENT_MCP_TOKEN"
      : `stored at ${resolved.path}${resolved.created ? " (created)" : ""}`
  return [
    `token: ${resolved.token}`,
    stored,
    "",
    "Paste this in the live client:",
    loaderSnippet(resolved.token),
  ].join("\n")
}

export async function resolveToken(options: TokenPathOptions = {}): Promise<ResolvedToken> {
  const env = options.env ?? process.env
  const fromEnv = env.ROBLOX_CLIENT_MCP_TOKEN
  if (fromEnv !== undefined && fromEnv.length > 0) {
    if (!isUsableToken(fromEnv)) {
      throw new BridgeStartupError("ROBLOX_CLIENT_MCP_TOKEN must be 32 to 256 characters")
    }
    return { token: fromEnv, source: "env" }
  }

  const path = tokenFilePath(options)
  try {
    const existing = (await readFile(path, "utf8")).trim()
    if (isUsableToken(existing)) {
      return { token: existing, source: "file", path, created: false }
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code !== "ENOENT") {
      throw new BridgeStartupError(`Could not read token file ${path}: ${error.message}`)
    }
  }

  const token = generateToken()
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${token}\n`, { encoding: "utf8", mode: 0o600 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new BridgeStartupError(`Could not write token file ${path}: ${message}`)
  }
  return { token, source: "file", path, created: true }
}
