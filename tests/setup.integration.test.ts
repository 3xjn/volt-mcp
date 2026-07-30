import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { installVoltMcp } from "../scripts/setup-core.js"

const stateSchema = z.object({
  version: z.literal(1),
  clientToken: z.string().length(64),
  runtimeRoot: z.string().min(1),
})

test("installs an idempotent runtime and secret-free Volt bootstrap", async () => {
  // Given isolated Volt, runtime, and state locations
  const directory = await mkdtemp(join(tmpdir(), "volt-mcp-setup-"))
  const voltRoot = join(directory, "Volt")
  const runtimeRoot = join(directory, "runtime")
  const statePath = join(directory, "state.json")
  const sourceRoot = import.meta.dir.replace(/[\\/]tests$/, "")

  try {
    // When product-neutral setup is applied twice
    const options = {
      sourceRoot,
      voltRoot,
      runtimeRoot,
      statePath,
      installDependencies: false,
      startDaemon: false,
    }
    await installVoltMcp(options)
    const firstState = stateSchema.parse(JSON.parse(await readFile(statePath, "utf8")))
    await installVoltMcp(options)
    const secondState = stateSchema.parse(JSON.parse(await readFile(statePath, "utf8")))

    // Then the runtime updates, client authorization persists, and autoexec contains no credential
    await expect(stat(join(runtimeRoot, "src", "index.ts"))).resolves.toBeDefined()
    await expect(
      stat(join(voltRoot, "workspace", "volt-mcp", "volt-agent.lua")),
    ).resolves.toBeDefined()
    const loader = await readFile(join(voltRoot, "autoexec", "volt-mcp.lua"), "utf8")
    expect(loader).toContain('readfile("volt-mcp/volt-agent.lua")')
    expect(loader).not.toContain("VOLT_MCP_TOKEN")
    expect(loader).not.toContain("Token =")
    expect(secondState.clientToken).toBe(firstState.clientToken)
    expect(secondState.runtimeRoot).toBe(runtimeRoot)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
