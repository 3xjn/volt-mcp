import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { inspectSetup, installVoltMcp } from "../scripts/setup-core.js"

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

test("reports stale Volt loaders and agent artifacts as needing repair", async () => {
  // Given an isolated current installation
  const directory = await mkdtemp(join(tmpdir(), "volt-mcp-stale-"))
  const options = {
    sourceRoot: import.meta.dir.replace(/[\\/]tests$/, ""),
    voltRoot: join(directory, "Volt"),
    runtimeRoot: join(directory, "runtime"),
    statePath: join(directory, "state.json"),
    installDependencies: false,
    startDaemon: false,
  }
  const artifacts = [
    join(options.voltRoot, "autoexec", "volt-mcp.lua"),
    join(options.voltRoot, "workspace", "volt-mcp", "bootstrap.lua"),
    join(options.voltRoot, "workspace", "volt-mcp", "volt-agent.lua"),
  ]

  try {
    await installVoltMcp(options)

    for (const artifact of artifacts) {
      // When one shipped artifact is stale
      await writeFile(artifact, "-- stale Volt MCP artifact\n", "utf8")

      // Then check requests repair, and reinstall restores a current installation
      expect((await inspectSetup(options)).installed).toBe(false)
      expect((await installVoltMcp(options)).installed).toBe(true)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("returns first-run guidance only from install", async () => {
  // Given an isolated setup target
  const directory = await mkdtemp(join(tmpdir(), "volt-mcp-guidance-"))
  const options = {
    sourceRoot: import.meta.dir.replace(/[\\/]tests$/, ""),
    voltRoot: join(directory, "Volt"),
    runtimeRoot: join(directory, "runtime"),
    statePath: join(directory, "state.json"),
    installDependencies: false,
    startDaemon: false,
  }

  try {
    // When setup installs and a later healthy check inspects the same files
    const installStatus = await installVoltMcp(options)
    const checkStatus = await inspectSetup(options)

    // Then install carries the one-time action, while check remains quiet
    expect(installStatus.firstRunAction).toBe(
      "Rejoin or reinject Roblox once so Volt runs the new autoexec bootstrap.",
    )
    expect(installStatus.bootstrapCommand).toBe(
      'loadstring(readfile("volt-mcp/bootstrap.lua"), "Volt MCP bootstrap")()',
    )
    expect(checkStatus.firstRunAction).toBeUndefined()
    expect(checkStatus.bootstrapCommand).toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
