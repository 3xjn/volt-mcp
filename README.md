# Live-client MCP

stdio MCP plus a loopback WebSocket. An agent uses it to inspect a live Roblox
client: instances, scripts, source, and eval.

Both sides share one token. Listeners bind only to `127.0.0.1`.

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

The default URL is `ws://127.0.0.1:32145/live`. The agent prefers
`WebSocket.connect` (UNC / sUNC). If that function is missing, it polls
`http://127.0.0.1:32145/live/poll` with `request` (`http_request` /
`http.request` aliases). It retries until the MCP process is listening and
replaces an older copy if the loader runs again.

The agent capability-detects globals. It does not branch on
`identifyexecutor()` names. `loadstring` and `getgenv` are required.
`decompile` is used when present; otherwise `getscriptbytecode` is returned.
`decompile` is a vendor extra, not UNC/sUNC.

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
| `roblox_list_instances` | An instance plus matches (`name`, `className`, `path`, `childCount`, `isScript`). Optional `path` (default `game`), `scope` (`children` / `all` / `nil`), `query`, `className`, and `limit`. `all` uses `getinstances` or `game:GetDescendants()`. `nil` uses `getnilinstances`. |
| `roblox_list_scripts` | Matching scripts (`name`, `className`, `path`). Optional `query`, `scope` (`all` / `running` / `loaded` / `cached`), and `limit`. Uses `getscripts` / `getloadedmodules` / `getrunningscripts`, or filters instances by class. |
| `roblox_read_source` | `encoding=source` paged text when `decompile` exists; otherwise `encoding=bytecode` (`bytecodeFormat=hex`). |
| `roblox_eval` | JSON-safe values returned by an explicit Luau chunk. Marked destructive. |

If no authenticated client is connected, tools fail with that error.

## Development

```powershell
bun run check
```
