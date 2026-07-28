import { z } from "zod"

const instancePath = z.string().min(1).max(4_096).describe("Canonical game/workspace instance path")

export const scriptScopeInput = z
  .enum(["all", "running", "loaded", "cached"])
  .default("all")
  .describe("Which Volt script inventory to inspect")

export const targetInput = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("game") }),
    z.object({
      kind: z.literal("actor"),
      path: instancePath.describe("Canonical path of the target Actor"),
    }),
    z.object({
      kind: z.literal("state"),
      id: z.number().int().nonnegative().describe("Volt LuaStateProxy ID"),
    }),
  ])
  .default({ kind: "game" })

export const listScriptsInput = z.object({
  query: z.string().max(200).optional().describe("Case-insensitive path/name filter"),
  scope: scriptScopeInput,
  limit: z.number().int().min(1).max(1_000).default(200),
  target: targetInput,
})

export const searchScriptsInput = z.object({
  query: z.string().min(1).max(200).describe("Words or source text to find"),
  scope: scriptScopeInput,
  limit: z.number().int().min(1).max(100).default(20),
  contextLines: z.number().int().min(0).max(10).default(2),
  maxSnippets: z.number().int().min(1).max(10).default(3),
  refresh: z.boolean().default(false).describe("Force a fresh inventory and decompile pass"),
  target: targetInput,
})

export const readScriptInput = z.object({
  path: instancePath,
  startLine: z.number().int().min(1).default(1),
  lineCount: z.number().int().min(1).max(5_000).default(1_000),
  target: targetInput,
})

export const inspectClosureInput = z.object({
  path: instancePath,
  closureId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("Runtime closure ID returned by an earlier script inspection"),
  prototypePath: z
    .array(z.number().int().min(1).max(10_000))
    .max(16)
    .default([])
    .describe("One-based nested prototype indices from the script closure"),
  target: targetInput,
})

const primitiveValueInput = z.union([z.string().max(10_000), z.number().finite(), z.boolean()])

export const mutateClosureInput = z.object({
  path: instancePath,
  closureId: z
    .string()
    .min(1)
    .max(128)
    .describe("Runtime closure ID returned by an earlier script inspection"),
  prototypePath: z.array(z.number().int().min(1).max(10_000)).max(16).default([]),
  kind: z.enum(["constant", "upvalue"]),
  index: z.number().int().min(1).max(100_000),
  expected: primitiveValueInput.describe("Current primitive value required before mutation"),
  value: primitiveValueInput.describe("Replacement primitive value of the same Luau type"),
  target: targetInput,
})

export const restoreMutationInput = z.object({
  mutationId: z.string().min(1).max(128),
  target: targetInput,
})

export const evalInput = z.object({
  code: z.string().min(1).max(100_000).describe("Luau chunk to execute in the Volt environment"),
  chunkName: z.string().min(1).max(100).default("Volt MCP"),
  target: targetInput,
})
