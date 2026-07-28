import { z } from "zod"

export const REQUEST_METHODS = [
  "status",
  "listTargets",
  "listScripts",
  "searchScripts",
  "readScript",
  "inspectClosure",
  "mutateClosure",
  "restoreMutation",
  "eval",
] as const

export const agentInfoSchema = z.object({
  agentVersion: z.string().min(1).max(32),
  placeId: z.number().int().nonnegative(),
  jobId: z.string().max(128),
  playerName: z.string().max(64),
  userId: z.number().int().nonnegative(),
})

export type AgentInfo = z.infer<typeof agentInfoSchema>

export const helloMessageSchema = z.object({
  type: z.literal("hello"),
  token: z.string().min(32).max(256),
  agent: agentInfoSchema,
})

export const responseMessageSchema = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("response"),
    id: z.string().min(1).max(64),
    ok: z.literal(true),
    result: z.json(),
  }),
  z.object({
    type: z.literal("response"),
    id: z.string().min(1).max(64),
    ok: z.literal(false),
    error: z.string().min(1).max(4096),
  }),
])

export type RequestMethod = (typeof REQUEST_METHODS)[number]

export const requestMessageSchema = z.object({
  type: z.literal("request"),
  id: z.string().min(1).max(64),
  method: z.enum(REQUEST_METHODS),
  params: z.record(z.string(), z.unknown()),
})

export type AgentRequest = z.infer<typeof requestMessageSchema>
export type AgentResponse = z.infer<typeof responseMessageSchema>
