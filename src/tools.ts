import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { LiveBridge } from "./bridge.js"
import {
  evalInput,
  inspectClosureInput,
  listScriptsInput,
  mutateClosureInput,
  readScriptInput,
  restoreMutationInput,
  searchScriptsInput,
} from "./tool-inputs.js"

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  }
}

export function createMcpServer(bridge: LiveBridge): McpServer {
  const server = new McpServer({
    name: "volt-mcp",
    version: "0.1.0",
    title: "Volt MCP for Roblox",
    icons: [
      {
        src: "https://images.rbxcdn.com/905bd722ee0a6ceda3caacde54c0b081.png",
        mimeType: "image/png",
        sizes: ["180x180"],
      },
    ],
  })

  server.registerTool(
    "roblox_status",
    {
      title: "Roblox live-client status",
      description:
        "Report Roblox registration, pairing, approval, waiting, and connected states. A live challenge includes its short-lived correlation code, expiry, Roblox session, daemon identity, scope, persistence, and next action. The code correlates MCP and Volt dialog surfaces; it is not authorization or a credential.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => textResult(bridge.status()),
  )

  server.registerTool(
    "roblox_prepare_pairing",
    {
      title: "Prepare Roblox pairing",
      description:
        "Create and immediately return a short-lived pairing challenge for the registered Roblox session without displaying a dialog. This replaces any prior challenge. Surface its correlation code to the user before presenting it.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async () => textResult(bridge.preparePairing()),
  )

  server.registerTool(
    "roblox_present_pairing",
    {
      title: "Present Roblox pairing approval",
      description:
        "Present the current prepared challenge in Volt's Windows Yes/No dialog. Call only after the MCP client has shown the matching correlation code. Wrong, replaced, or expired challenge IDs are rejected.",
      inputSchema: {
        challengeId: z.uuid().describe("Current challengeId returned by roblox_prepare_pairing"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ challengeId }) => textResult(bridge.presentPairing(challengeId)),
  )

  server.registerTool(
    "roblox_list_targets",
    {
      title: "List Roblox Lua-state targets",
      description: "List the default game Lua state plus active Actor and LuaStateProxy selectors.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => textResult(await bridge.request("listTargets", {})),
  )

  server.registerTool(
    "roblox_list_scripts",
    {
      title: "List live Roblox scripts",
      description:
        "List client-visible scripts from the live game so another tool can read one by path. Inactive scripts under other players are excluded unless explicitly requested.",
      inputSchema: listScriptsInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) =>
      textResult(
        await bridge.request("listScripts", {
          query: input.query ?? "",
          scope: input.scope,
          limit: input.limit,
          target: input.target,
          includeOtherPlayers: input.includeOtherPlayers,
        }),
      ),
  )

  server.registerTool(
    "roblox_search_scripts",
    {
      title: "Search indexed Roblox code",
      description:
        "Search the automatic live decompile cache using behavior words or text, returning ranked snippets, stable identities, constants, and API clues. Inactive scripts under other players are excluded unless explicitly requested.",
      inputSchema: searchScriptsInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) =>
      textResult(
        await bridge.request(
          "searchScripts",
          {
            query: input.query,
            target: input.target,
            scope: input.scope,
            limit: input.limit,
            contextLines: input.contextLines,
            maxSnippets: input.maxSnippets,
            refresh: input.refresh,
            includeOtherPlayers: input.includeOtherPlayers,
          },
          120_000,
        ),
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
            target: input.target,
          },
          120_000,
        ),
      ),
  )

  server.registerTool(
    "roblox_inspect_closure",
    {
      title: "Inspect a Roblox script closure",
      description:
        "Return stable script/function identity plus positional constants, upvalues, and nested prototypes for a selected script closure.",
      inputSchema: inspectClosureInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) =>
      textResult(
        await bridge.request("inspectClosure", {
          path: input.path,
          target: input.target,
          prototypePath: input.prototypePath,
          ...(input.closureId === undefined ? {} : { closureId: input.closureId }),
        }),
      ),
  )

  server.registerTool(
    "roblox_mutate_closure",
    {
      title: "Mutate one Roblox closure value",
      description:
        "Compare and replace one primitive constant or root upvalue, retaining its original value for guarded restoration.",
      inputSchema: mutateClosureInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (input) =>
      textResult(
        await bridge.request("mutateClosure", {
          path: input.path,
          closureId: input.closureId,
          target: input.target,
          prototypePath: input.prototypePath,
          kind: input.kind,
          index: input.index,
          expected: input.expected,
          value: input.value,
        }),
      ),
  )

  server.registerTool(
    "roblox_restore_mutation",
    {
      title: "Restore one Roblox closure mutation",
      description:
        "Restore the original value retained for a mutation ID, refusing if the live value changed again.",
      inputSchema: restoreMutationInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (input) =>
      textResult(
        await bridge.request("restoreMutation", {
          mutationId: input.mutationId,
          target: input.target,
        }),
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
        await bridge.request(
          "eval",
          { code: input.code, chunkName: input.chunkName, target: input.target },
          120_000,
        ),
      ),
  )

  return server
}
