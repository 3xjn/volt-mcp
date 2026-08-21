# Live-client MCP

stdio MCP plus a loopback WebSocket. An agent uses it to inspect a live Roblox
client: instances, scripts, source, and eval.

Both sides share one token. The WebSocket binds only to `127.0.0.1`.

## Connect

Generate a token once:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

Load `agent.lua` in the live client after setting the same token:

```lua
getgenv().LiveMcp = {
    Token = "YOUR_TOKEN",
}

loadstring(readfile("agent.lua"), "live-mcp")()
```

A non-default port uses `Url = "ws://127.0.0.1:PORT/live"` in that table. The
agent retries until the MCP process is listening and replaces an older copy if
the loader runs again.

The live client must expose `getgenv`, `WebSocket.connect`, `decompile`,
`getscripts`, `getrunningscripts`, and `getloadedmodules`.

Run the MCP server with that token:

```json
{
  "mcpServers": {
    "live-mcp": {
      "command": "bun",
      "args": ["run", "src/index.ts"],
      "cwd": "/path/to/live-mcp",
      "env": {
        "LIVE_MCP_TOKEN": "YOUR_TOKEN",
        "LIVE_MCP_PORT": "32145"
      }
    }
  }
}
```

```powershell
bun install
```

## Tools

Each tool returns JSON text.

| Tool | Returns |
| --- | --- |
| `roblox_list_instances` | The parent instance plus its children (`name`, `className`, `path`, `childCount`, `isScript`). Optional `path` (default `game`), `query`, `className`, and `limit`. |
| `roblox_list_scripts` | Matching scripts (`name`, `className`, `path`) from the live inventory. Optional `query`, `scope` (`all` / `running` / `loaded` / `cached`), and `limit`. |
| `roblox_read_source` | Paged decompiler output for one script path (`source`, `startLine`, `endLine`, `totalLines`, `truncated`). |
| `roblox_eval` | JSON-safe values returned by an explicit Luau chunk. Marked destructive. |

If no authenticated client is connected, tools fail with that error.

## Development

```powershell
bun run check
```
