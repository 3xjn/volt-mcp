---
name: volt-mcp
description: Use Volt MCP from Prime Agent to inspect, search, read, or modify the live Roblox client attached to Volt. Use whenever the user mentions their current Roblox game, live client scripts, Volt runtime state, Roblox decompilation, or asks Prime to call a roblox_* tool.
compatibility: Windows with Volt and Windows Bun; Prime Agent may run in WSL.
---

# Volt MCP for Prime Agent

Import the prepared `volt_mcp` Python module and keep Volt MCP on the Windows host. The module starts
`scripts/mcp.ts` through `bun.exe`, so the adapter, daemon, state, and Volt share Windows loopback even
when Prime runs in WSL.

1. Discover the current server surface with `await volt_mcp.list_tools()` when tool arguments are not
   already known.
2. Start with `await volt_mcp.roblox_status()` when the user refers to the current game or live client.
3. Call named helpers such as `await volt_mcp.roblox_search_scripts(query="...")`, or use
   `await volt_mcp.run("roblox_tool_name", {"argument": "value"})`.
4. Preserve the pairing sequence: prepare, show the complete challenge to the user, then present the
   exact challenge only after the code is visible.
5. Treat mutation and eval tools as state-changing. Explain the intended change and retain mutation IDs
   needed for restoration.

If Windows Bun is not on WSL's inherited PATH, set `VOLT_MCP_WINDOWS_BUN` to its `bun.exe` path. Set
`VOLT_MCP_PLUGIN_ROOT` only when this skill has been copied away from the repository. Never use Linux
Bun: it would place the daemon on WSL loopback where Windows Volt cannot reach it.
