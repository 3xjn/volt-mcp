import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { LiveBridge } from "./bridge.js"

const listScriptsInput = z.object({
  query: z.string().max(200).optional().describe("Case-insensitive path/name filter"),
  scope: z
    .enum(["all", "running", "loaded", "cached"])
    .default("all")
    .describe("Which Volt script inventory to inspect"),
  limit: z.number().int().min(1).max(1_000).default(200),
})

const readScriptInput = z.object({
  path: z.string().min(1).max(4_096).describe("Canonical game/workspace instance path"),
  startLine: z.number().int().min(1).default(1),
  lineCount: z.number().int().min(1).max(5_000).default(1_000),
})

const evalInput = z.object({
  code: z.string().min(1).max(100_000).describe("Luau chunk to execute in the Volt environment"),
  chunkName: z.string().min(1).max(100).default("Hydroxide MCP"),
})

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  }
}

export function createMcpServer(bridge: LiveBridge): McpServer {
  const server = new McpServer({
    name: "hydroxide-live",
    version: "0.1.0",
  })

  server.registerTool(
    "roblox_status",
    {
      title: "Roblox live-client status",
      description: "Check whether an authenticated Volt client is connected.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => textResult(bridge.status()),
  )

  server.registerTool(
    "roblox_list_scripts",
    {
      title: "List live Roblox scripts",
      description:
        "List client-visible scripts from the live game so another tool can read one by path.",
      inputSchema: listScriptsInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) =>
      textResult(
        await bridge.request("listScripts", {
          query: input.query ?? "",
          scope: input.scope,
          limit: input.limit,
        }),
      ),
  )

  server.registerTool(
    "roblox_read_script",
    {
      title: "Read a live Roblox script",
      description:
        "Resolve a live LocalScript or ModuleScript path and return paged Volt decompiler output.",
      inputSchema: readScriptInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) =>
      textResult(
        await bridge.request(
          "readScript",
          {
            path: input.path,
            startLine: input.startLine,
            lineCount: input.lineCount,
          },
          120_000,
        ),
      ),
  )

  server.registerTool(
    "roblox_eval",
    {
      title: "Evaluate Luau in the live Roblox client",
      description:
        "Execute an explicit Luau chunk through Volt and return its JSON-safe returned values.",
      inputSchema: evalInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) =>
      textResult(
        await bridge.request("eval", { code: input.code, chunkName: input.chunkName }, 120_000),
      ),
  )

  return server
}
