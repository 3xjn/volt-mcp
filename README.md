# Hydroxide Live MCP

This bridge lets Codex inspect the Roblox client currently attached to Volt. It uses:

- a project-local stdio MCP server;
- a WebSocket server bound only to `127.0.0.1`;
- an authenticated Volt auto-execute agent;
- Volt's documented script inventory and decompiler functions.

It does not load the Hydroxide UI and does not use RakNet.

## 1. Choose a shared token

Generate a token once:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

Keep it local. Do not commit it.

## 2. Add the Volt auto-execute loader

Save this as a Volt auto-execute script, replacing `YOUR_TOKEN`:

```lua
getgenv().HydroxideMcp = {
    Token = "YOUR_TOKEN",
}

loadstring(
    game:HttpGetAsync(
        "https://raw.githubusercontent.com/3xjn/hydroxide/dev/tools/live-mcp/volt-agent.lua"
    ),
    "Hydroxide Live MCP"
)()
```

For a non-default port, add `Url = "ws://127.0.0.1:PORT/volt"` to the table.

The agent survives character respawns because it is attached to the client, not the character. It retries when the local MCP server is not running and replaces an older copy when auto-execute runs again.

## 3. Configure Codex

Install the bridge dependencies once:

```powershell
cd C:\git\hydroxide\tools\live-mcp
bun install
```

Add this project-scoped configuration to `C:\git\hydroxide\.codex\config.toml`, using the same token:

```toml
[mcp_servers.hydroxide_live]
command = "bun"
args = ["run", "src/index.ts"]
cwd = "C:\\git\\hydroxide\\tools\\live-mcp"

[mcp_servers.hydroxide_live.env]
HYDROXIDE_MCP_TOKEN = "YOUR_TOKEN"
HYDROXIDE_MCP_PORT = "32145"
```

Codex reads project-scoped MCP configuration after the project is trusted. A new Codex task is required after adding or changing an MCP server.

## Tools

- `roblox_status` shows the connected place and player.
- `roblox_list_scripts` discovers cached, running, or loaded client scripts.
- `roblox_read_script` resolves a canonical instance path and returns paged decompiler output.
- `roblox_eval` executes an explicit Luau chunk and returns JSON-safe values.

`roblox_eval` is intentionally marked destructive because arbitrary Luau can mutate the live client. The other tools are read-only.

## Development

```powershell
bun run check
```
