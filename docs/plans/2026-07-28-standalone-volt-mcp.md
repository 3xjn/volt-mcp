# Standalone Volt MCP Implementation Plan

> **For Codex:** Implement each task in order and verify the public naming contract before publishing.

**Goal:** Make Volt MCP a standalone repository and remove former host-project branding from its current surface.

**Architecture:** Keep the existing local WebSocket bridge, persistent Streamable HTTP MCP server, target-aware Roblox tools, and Volt auto-execute agent. Only repository ownership, public naming, configuration, startup feedback, and standalone paths change.

**Tech Stack:** Bun, TypeScript, Model Context Protocol SDK, Zod, Luau, Volt.

---

### Task 1: Lock the standalone public contract

**Files:**
- Create: `tests/branding.test.ts`

1. Assert the package, MCP server, environment variables, loader globals, repository URL, and startup messages use Volt MCP names.
2. Confirm the contract fails against the extracted host-project-branded tree.

### Task 2: Rename the current product surface

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `src/index.ts`
- Modify: `src/daemon.ts`
- Modify: `src/http.ts`
- Modify: `src/tool-inputs.ts`
- Modify: `src/tools.ts`
- Rename the evaluator script to `scripts/evaluate-search.ts`
- Modify: `tests/*.test.ts`
- Modify: `volt-agent.lua`

1. Rename product identifiers to `Volt MCP` / `volt-mcp`.
2. Rename configuration to `VOLT_MCP_*` and `getgenv().VoltMcp`.
3. Point the documented local loader at `volt-mcp/local/volt-agent.lua`.
4. Print concise load and authentication success messages from the Volt agent.

### Task 3: Verify and publish

**Files:**
- Modify: `bun.lock`

1. Regenerate the lockfile after the package rename.
2. Run type checks, formatting checks, unit and integration tests, and Luau syntax validation.
3. Start the standalone daemon, connect the running Volt client, and exercise status/tool discovery.
4. Commit and push `master` to `3xjn/volt-mcp`.
5. Close the superseded host-project draft pull request after the standalone repository is proven.
