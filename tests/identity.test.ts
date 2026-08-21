import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const repositoryRoot = new URL("../", import.meta.url)

function read(path: string): string {
  return readFileSync(new URL(path, repositoryRoot), "utf8")
}

test("uses a roblox-client-mcp identity", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    readonly name?: unknown
    readonly description?: unknown
    readonly repository?: { readonly type?: unknown; readonly url?: unknown }
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

  expect(packageJson.name).toBe("@3xjn/roblox-client-mcp")
  expect(packageJson.description).toBe(
    "Generic stdio MCP for inspecting a live Roblox client (not Studio)",
  )
  expect(packageJson.repository).toEqual({
    type: "git",
    url: "git+https://github.com/3xjn/roblox-client-mcp.git",
  })
  expect(packageJson.scripts).toEqual({
    start: "bun run src/index.ts",
    typecheck: "tsc --noEmit",
    lint: "biome check .",
    test: "bun test",
    check: "bun run typecheck && bun run lint && bun test",
  })
  expect(publicSurface).toContain('name: "roblox-client-mcp"')
  expect(publicSurface).toContain("ROBLOX_CLIENT_MCP_TOKEN")
  expect(publicSurface).toContain("ROBLOX_CLIENT_MCP_PORT")
  expect(publicSurface).toContain("ROBLOX_CLIENT_MCP_FILEPOLL")
  expect(publicSurface).toContain("ws://127.0.0.1:")
  expect(publicSurface).toContain("/live")
  expect(publicSurface).toContain("/live/poll")
  expect(publicSurface).toContain("environment.RobloxClientMcp")
  expect(publicSurface).toContain("function handlers.listInstances")
  expect(publicSurface).toContain("function handlers.listScripts")
  expect(publicSurface).toContain("function handlers.readSource")
  expect(publicSurface).toContain("function handlers.eval")
  expect(publicSurface).not.toMatch(/Volt|volt-mcp|VOLT_MCP/)
  expect(publicSurface).not.toMatch(/LiveMcp|LIVE_MCP/)
  expect(publicSurface).not.toContain("live-mcp")
  expect(publicSurface).not.toMatch(/Hydroxide|hydroxide|HYDROXIDE/)
  expect(publicSurface).not.toContain("pair_request")
  expect(publicSurface).not.toContain("pair_challenge")
  expect(publicSurface).not.toContain("searchScripts")
  expect(publicSurface).not.toContain("mutationId")
  expect(publicSurface).not.toContain("roblox_list_clients")
  expect(publicSurface).not.toContain("roblox_inspect_closure")
  expect(publicSurface).not.toContain("volt-agent")
  expect(publicSurface).not.toContain("inspectClosure")
  expect(publicSurface).not.toContain("mutateClosure")
  expect(publicSurface).not.toContain("restoreMutation")
  expect(publicSurface).not.toContain("rankedSearch")
  expect(publicSurface).not.toContain("code search")
})

test("keeps the client agent to a portable inspect loop", () => {
  const source = read("agent.lua")
  expect(source).toContain('type = "hello"')
  expect(source).toContain('nestedFunction("WebSocket", "connect")')
  expect(source).toContain('nestedFunction("websocket", "connect")')
  expect(source).toContain('nestedFunction("WebSocket", "new")')
  expect(source).toContain('nestedFunction("syn", "websocket", "connect")')
  expect(source).toContain('envFunction("request")')
  expect(source).toContain('nestedFunction("http", "request")')
  expect(source).toContain('envFunction("http_request")')
  expect(source).toContain('nestedFunction("syn", "request")')
  expect(source).toContain('envFunction("writefile")')
  expect(source).toContain('envFunction("readfile")')
  expect(source).toContain('envFunction("getinstances")')
  expect(source).toContain('envFunction("getnilinstances")')
  expect(source).toContain("game:GetDescendants()")
  expect(source).toContain('envFunction("getscripts")')
  expect(source).toContain('envFunction("getscriptbytecode")')
  expect(source).toContain('envFunction("decompile")')
  expect(source).toContain('envFunction("getscriptclosure")')
  expect(source).toContain('kind = "luau"')
  expect(source).toContain('kind = "bytecode"')
  expect(source).toContain('kind = "constants"')
  expect(source).toContain('kind = "empty"')
  expect(source).toContain("://127.0.0.1")
  expect(source).toContain('assert(compile, "loadstring is required")')
  expect(source).toContain("identifyexecutor")
  expect(source).toContain("/poll")
  expect(source).toContain("to-host.json")
  expect(source).toContain("to-agent.json")
  expect(source).toContain('type = "poll"')
  expect(source).not.toContain("identifyexecutor()")
  expect(source).not.toContain("IsClosed")
  expect(source).not.toContain("messagebox")
  expect(source).not.toContain("searchScripts")
  expect(source).not.toContain("mutateClosure")
  expect(source).not.toContain("restoreMutation")
  expect(source).not.toContain("inspectClosure")
  expect(source).not.toContain("listTargets")
  expect(source).not.toMatch(/if .+ == ["']Synapse/)
  expect(source).not.toMatch(/identifyexecutor\(\)/)
})
