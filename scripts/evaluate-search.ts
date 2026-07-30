import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { z } from "zod"
import { loadDaemonState } from "../src/state.js"

const environment = z
  .object({
    VOLT_MCP_ENDPOINT: z.url().default("http://127.0.0.1:32146/mcp"),
  })
  .parse(process.env)
const state = await loadDaemonState()

const textResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
})
const searchResultSchema = z.object({
  matches: z.array(
    z.object({
      path: z.string(),
      score: z.number(),
      matchedTerms: z.record(z.string(), z.array(z.string())),
    }),
  ),
  index: z.object({
    scripts: z.number().int(),
    sources: z.number().int(),
    sourceMode: z.literal("explicit_read"),
    backgroundDecompile: z.literal(false),
  }),
})
const listResultSchema = z.object({
  scripts: z.array(z.object({ path: z.string() })),
})

const cases = [
  {
    query: "camera input from mouse touch and gamepad",
    expectedSuffix: '["CameraModule"]["CameraInput"]',
  },
  {
    query: "keyboard character movement and jump controls",
    expectedSuffix: '["ControlModule"]["Keyboard"]',
  },
  {
    query: "camera obstruction occlusion raycast",
    expectedSuffix: '["CameraModule"]["ZoomController"]["Popper"]',
  },
  {
    query: "vehicle camera rotation smoothing",
    expectedSuffix: '["CameraModule"]["VehicleCamera"]["VehicleCameraCore"]',
  },
] as const

function parseTextPayload(value: unknown): unknown {
  const result = textResultSchema.parse(value)
  return JSON.parse(result.content[0]?.text ?? "")
}

async function search(
  client: Client,
  query: string,
  options: { readonly limit: number; readonly refresh: boolean },
): Promise<z.infer<typeof searchResultSchema>> {
  return searchResultSchema.parse(
    parseTextPayload(
      await client.callTool({
        name: "roblox_search_scripts",
        arguments: {
          query,
          scope: "all",
          limit: options.limit,
          contextLines: 1,
          maxSnippets: 1,
          refresh: options.refresh,
        },
      }),
    ),
  )
}

async function cacheSelectedSource(client: Client, expectedSuffix: string): Promise<string> {
  const inventory = listResultSchema.parse(
    parseTextPayload(
      await client.callTool({
        name: "roblox_list_scripts",
        arguments: { scope: "all", limit: 1_000 },
      }),
    ),
  )
  const script = inventory.scripts.find(({ path }) => path.endsWith(expectedSuffix))
  if (!script) {
    throw new Error(`Could not find evaluation script ending in ${expectedSuffix}`)
  }
  parseTextPayload(
    await client.callTool({
      name: "roblox_read_script",
      arguments: { path: script.path, startLine: 1, lineCount: 1 },
    }),
  )
  return script.path
}

const transport = new StreamableHTTPClientTransport(new URL(environment.VOLT_MCP_ENDPOINT), {
  requestInit: {
    headers: { Authorization: `Bearer ${state.clientToken}` },
  },
})
const client = new Client({ name: "volt-mcp-search-evaluation", version: "0.1.0" })

try {
  await client.connect(transport)
  const explicitlyCached = []
  for (const evaluationCase of cases) {
    explicitlyCached.push(await cacheSelectedSource(client, evaluationCase.expectedSuffix))
  }

  const results = []
  let index: z.infer<typeof searchResultSchema>["index"] | undefined
  for (const evaluationCase of cases) {
    const response = await search(client, evaluationCase.query, {
      limit: 100,
      refresh: false,
    })
    index = response.index
    const searchRank = response.matches.findIndex(({ path }) =>
      path.endsWith(evaluationCase.expectedSuffix),
    )
    const match = searchRank >= 0 ? response.matches[searchRank] : undefined
    results.push({
      query: evaluationCase.query,
      expectedSuffix: evaluationCase.expectedSuffix,
      rank: searchRank >= 0 ? searchRank + 1 : null,
      score: match?.score ?? null,
      matchedTerms: match?.matchedTerms ?? null,
    })
  }
  process.stdout.write(JSON.stringify({ index, explicitlyCached, cases: results }, null, 2))
} finally {
  await client.close()
}
