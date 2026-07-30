import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const repositoryRoot = new URL("../", import.meta.url)

function read(path: string): string {
  return readFileSync(new URL(path, repositoryRoot), "utf8")
}

test("uses Volt MCP as the standalone public identity", () => {
  const packageJson = JSON.parse(read("package.json")) as { readonly name?: unknown }
  const publicSurface = [
    read("README.md"),
    read("package.json"),
    read("scripts/evaluate-search.ts"),
    read("scripts/mcp.ts"),
    read("scripts/setup-core.ts"),
    read("src/daemon.ts"),
    read("src/http.ts"),
    read("src/index.ts"),
    read("src/tool-inputs.ts"),
    read("src/tools.ts"),
    read("volt-agent.lua"),
  ].join("\n")
  const formerProductName = ["Hydro", "xide"].join("")
  const formerProductLabel = ["Live", "MCP"].join(" ")
  const formerPackageSuffix = ["live", "mcp"].join("-")
  const forbiddenBranding = new RegExp(
    `${formerProductName}|${formerProductName.toLowerCase()}|${formerProductName.toUpperCase()}_MCP|${formerProductLabel}|${formerPackageSuffix}`,
  )

  expect(packageJson.name).toBe("@3xjn/volt-mcp")
  expect(publicSurface).not.toMatch(forbiddenBranding)
  expect(publicSurface).toContain('name: "volt-mcp"')
  expect(publicSurface).toContain('title: "Volt MCP for Roblox"')
  expect(publicSurface).not.toContain("VOLT_MCP_TOKEN")
  expect(publicSurface).toContain("environment.VoltMcp")
  expect(publicSurface).toContain("volt-mcp/volt-agent.lua")
  expect(publicSurface).toContain('type = "pair_request"')
  expect(publicSurface).toContain('request.type == "pair_challenge"')
  expect(publicSurface).toContain('print("Volt MCP successfully loaded")')
  expect(publicSurface).toContain('print("Volt MCP authentication successful")')
})
