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
    complete: z.boolean(),
    scripts: z.number().int(),
    sources: z.number().int(),
    queuedSources: z.number().int(),
  }),
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

const transport = new StreamableHTTPClientTransport(new URL(environment.VOLT_MCP_ENDPOINT), {
  requestInit: {
    headers: { Authorization: `Bearer ${state.clientToken}` },
  },
})
const client = new Client({ name: "volt-mcp-search-evaluation", version: "0.1.0" })

try {
  await client.connect(transport)
  const deadline = Date.now() + 180_000
  let index = (
    await search(client, "__volt_mcp_index_progress__", {
      limit: 1,
      refresh: true,
    })
  ).index
  while (!index.complete && Date.now() < deadline) {
    await Bun.sleep(1_000)
    index = (
      await search(client, "__volt_mcp_index_progress__", {
        limit: 1,
        refresh: false,
      })
    ).index
  }
  if (!index.complete) {
    throw new Error(
      `Search index did not complete within 180 seconds (${index.sources}/${index.scripts}, ${index.queuedSources} queued)`,
    )
  }

  const results = []
  for (const evaluationCase of cases) {
    const response = await search(client, evaluationCase.query, {
      limit: 100,
      refresh: false,
    })
    const index = response.matches.findIndex(({ path }) =>
      path.endsWith(evaluationCase.expectedSuffix),
    )
    const match = index >= 0 ? response.matches[index] : undefined
    results.push({
      query: evaluationCase.query,
      expectedSuffix: evaluationCase.expectedSuffix,
      rank: index >= 0 ? index + 1 : null,
      score: match?.score ?? null,
      matchedTerms: match?.matchedTerms ?? null,
    })
  }
  process.stdout.write(JSON.stringify({ index, cases: results }, null, 2))
} finally {
  await client.close()
}
