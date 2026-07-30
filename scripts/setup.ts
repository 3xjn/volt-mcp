import { join, resolve } from "node:path"
import { type InstallOptions, inspectSetup, installVoltMcp, resetPairing } from "./setup-core.js"

type Command = "check" | "install" | "reset-pairing"

function commandFrom(value: string | undefined): Command {
  if (value === undefined || value === "check") {
    return "check"
  }
  if (value === "install" || value === "reset-pairing") {
    return value
  }
  throw new Error("Usage: setup.ts <check|install|reset-pairing> [--volt-root PATH]")
}

function valueAfter(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name)
  return index === -1 ? undefined : arguments_.at(index + 1)
}

function requiredLocalData(): string {
  const localData = process.env["LOCALAPPDATA"]?.trim()
  if (localData === undefined || localData.length === 0) {
    throw new Error(
      "Volt currently supports Windows; LOCALAPPDATA is required unless setup paths are explicit",
    )
  }
  return localData
}

function options(arguments_: readonly string[]): InstallOptions {
  const localData = requiredLocalData()
  const sourceRoot = resolve(import.meta.dir, "..")
  return {
    sourceRoot,
    voltRoot: resolve(valueAfter(arguments_, "--volt-root") ?? join(localData, "Volt")),
    runtimeRoot: resolve(
      valueAfter(arguments_, "--runtime-root") ?? join(localData, "volt-mcp", "runtime"),
    ),
    statePath: resolve(
      valueAfter(arguments_, "--state-path") ?? join(localData, "volt-mcp", "state.json"),
    ),
    installDependencies: true,
    startDaemon: !arguments_.includes("--no-start"),
  }
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2)
  const command = commandFrom(arguments_.at(0))
  const setupOptions = options(arguments_)
  if (command === "reset-pairing") {
    await resetPairing(setupOptions.statePath)
    process.stdout.write(`${JSON.stringify({ pairingReset: true })}\n`)
    return
  }
  const result =
    command === "install" ? await installVoltMcp(setupOptions) : await inspectSetup(setupOptions)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
