# Live-client MCP

stdio MCP plus a loopback WebSocket. An agent uses it to inspect a live Roblox
client: instances, scripts, source, and eval.

Both sides share one token. Listeners bind only to `127.0.0.1`. Prefer
`127.0.0.1` over `localhost`.

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

The default URL is `ws://127.0.0.1:32145/live`. The agent probes transports in
order:

1. `WebSocket.connect`, then `websocket.connect`, then `WebSocket.new`, then
   `syn.websocket.connect`. Socket surface is `OnMessage`/`OnClose` `:Connect`,
   `Send`, and `Close`.
2. If WS connect fails, HTTP poll `http://127.0.0.1:32145/live/poll` via
   `request` / `http.request` / `http_request` / `syn.request`.
3. If neither WS nor request works, file-poll `writefile`/`readfile` under
   `live-mcp/` in the executor workspace. Point `LIVE_MCP_FILEPOLL` at that
   directory on the host.

The agent capability-detects globals. It does not branch on
`identifyexecutor()` / `getexecutorname` names. Those are telemetry on hello
only. `loadstring` and `getgenv` are required. `decompile` is not UNC/sUNC: it
is pcall'd when present, then `getscriptbytecode`, then optional
`getscriptclosure` + `debug.getconstants`.

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
| `roblox_list_instances` | An instance plus matches (`name`, `className`, `path`, `childCount`, `isScript`). Optional `path` (default `game`), `scope` (`children` / `all` / `nil`), `query`, `className`, and `limit`. `all` uses `getinstances` plus `getnilinstances`, else `game:GetDescendants()`. |
| `roblox_list_scripts` | Matching scripts (`name`, `className`, `path`). Optional `query`, `scope` (`all` / `running` / `loaded` / `cached`), and `limit`. Uses `getscripts` when present, else filters instances. `getrunningscripts` / `getloadedmodules` are scopes. Every getter is pcall'd. |
| `roblox_read_source` | `{ kind, data }` where `kind` is `luau`, `bytecode`, `constants`, or `empty`. Never requires `decompile`. |
| `roblox_eval` | JSON-safe values returned by an explicit Luau chunk. Marked destructive. |

If no authenticated client is connected, tools fail with that error.

## Development

```powershell
bun run check
```
