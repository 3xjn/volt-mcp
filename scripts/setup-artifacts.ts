import { readFile } from "node:fs/promises"
import { join } from "node:path"

export const LOADER = `local source = readfile("volt-mcp/volt-agent.lua")
local chunk, compileError = loadstring(source, "Volt MCP")
assert(chunk, compileError)()
`

export const BOOTSTRAP_COMMAND =
  'loadstring(readfile("volt-mcp/bootstrap.lua"), "Volt MCP bootstrap")()'

async function contentsMatch(expectedPath: string, installedPath: string): Promise<boolean> {
  try {
    const [expected, installed] = await Promise.all([
      readFile(expectedPath),
      readFile(installedPath),
    ])
    return expected.equals(installed)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false
    }
    throw error
  }
}

async function textMatches(path: string, expected: string): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")) === expected
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false
    }
    throw error
  }
}

export async function artifactsCurrent(options: {
  readonly sourceRoot: string
  readonly voltRoot: string
  readonly runtimeRoot: string
}): Promise<boolean> {
  return (
    await Promise.all([
      contentsMatch(
        join(options.sourceRoot, "src", "index.ts"),
        join(options.runtimeRoot, "src", "index.ts"),
      ),
      textMatches(join(options.voltRoot, "autoexec", "volt-mcp.lua"), LOADER),
      textMatches(join(options.voltRoot, "workspace", "volt-mcp", "bootstrap.lua"), LOADER),
      contentsMatch(
        join(options.sourceRoot, "volt-agent.lua"),
        join(options.voltRoot, "workspace", "volt-mcp", "volt-agent.lua"),
      ),
    ])
  ).every(Boolean)
}
