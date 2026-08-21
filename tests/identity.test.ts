import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const repositoryRoot = new URL("../", import.meta.url)

function read(path: string): string {
  return readFileSync(new URL(path, repositoryRoot), "utf8")
}

test("uses a generic live-client identity", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    readonly name?: unknown
    readonly scripts?: Readonly<Record<string, unknown>>
  }
  const publicSurface = [
    read("README.md"),
    read("package.json"),
    read("src/bridge.ts"),
    read("src/errors.ts"),
    read("src/index.ts"),
    read("src/protocol.ts"),
    read("src/tools.ts"),
    read("agent.lua"),
  ].join("\n")

  expect(packageJson.name).toBe("@3xjn/live-mcp")
  expect(packageJson.scripts).toEqual({
    start: "bun run src/index.ts",
    typecheck: "tsc --noEmit",
    lint: "biome check .",
    test: "bun test",
    check: "bun run typecheck && bun run lint && bun test",
  })
  expect(publicSurface).toContain('name: "live-mcp"')
  expect(publicSurface).toContain("LIVE_MCP_TOKEN")
  expect(publicSurface).toContain("LIVE_MCP_PORT")
  expect(publicSurface).toContain("ws://127.0.0.1:")
  expect(publicSurface).toContain("/live")
  expect(publicSurface).toContain("environment.LiveMcp")
  expect(publicSurface).toContain("function handlers.listInstances")
  expect(publicSurface).toContain("function handlers.listScripts")
  expect(publicSurface).toContain("function handlers.readSource")
  expect(publicSurface).toContain("function handlers.eval")
  expect(publicSurface).not.toMatch(/Volt|volt-mcp|VOLT_MCP/)
  expect(publicSurface).not.toMatch(/Hydroxide|hydroxide|HYDROXIDE/)
  expect(publicSurface).not.toContain("pair_request")
  expect(publicSurface).not.toContain("pair_challenge")
  expect(publicSurface).not.toContain("searchScripts")
  expect(publicSurface).not.toContain("mutationId")
  expect(publicSurface).not.toContain("roblox_list_clients")
})

test("keeps the client agent to the inspect loop", () => {
  const source = read("agent.lua")
  expect(source).toContain('type = "hello"')
  expect(source).toContain("WebSocket.connect")
  expect(source).toContain("decompile(instance)")
  expect(source).not.toContain("messagebox")
  expect(source).not.toContain("searchScripts")
  expect(source).not.toContain("mutateClosure")
  expect(source).not.toContain("restoreMutation")
  expect(source).not.toContain("inspectClosure")
  expect(source).not.toContain("listTargets")
})
