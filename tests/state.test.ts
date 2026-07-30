import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadDaemonState } from "../src/state.js"

const AGENT_TOKEN = "persisted-agent-token-0123456789abcdef0123456789abcdef"

test("creates stable client authorization and hashed agent pairing state", async () => {
  // Given a fresh daemon state path
  const directory = await mkdtemp(join(tmpdir(), "volt-mcp-state-"))
  const path = join(directory, "state.json")

  try {
    // When state is created, paired, and loaded again
    const first = await loadDaemonState(path)
    await first.pairAgent(AGENT_TOKEN)
    const second = await loadDaemonState(path)

    // Then the MCP client token remains stable and the Roblox secret is only stored as a hash
    expect(first.clientToken).toHaveLength(64)
    expect(second.clientToken).toBe(first.clientToken)
    expect(second.verifyAgentCredential(AGENT_TOKEN)).toBe(true)
    expect(second.verifyAgentCredential("wrong-agent-token-0123456789abcdef0123456789abcdef")).toBe(
      false,
    )
    expect(await readFile(path, "utf8")).not.toContain(AGENT_TOKEN)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
