# roblox-client-mcp

stdio MCP for a live Roblox **client** (not Studio). Package
`@3xjn/roblox-client-mcp`.

You inspect a running client: instances, scripts, source, and eval. The
bridge is loopback only — bind and connect on `127.0.0.1`, not
`localhost`. Both sides share one token.

## Connect

Three steps: token, MCP, client.

### 1. Token and install

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

`ROBLOX_CLIENT_MCP_TOKEN` must be at least 32 characters.
`ROBLOX_CLIENT_MCP_PORT` defaults to `32145`. Optional
`ROBLOX_CLIENT_MCP_FILEPOLL` is a host directory for the file-poll
fallback.

```powershell
bun install
```

### 2. Start the MCP

Cursor can spawn it. Example `mcp.json` (Windows cwd):

```json
{
  "mcpServers": {
    "roblox-client-mcp": {
      "command": "bun",
      "args": ["run", "src/index.ts"],
      "cwd": "C:\\Users\\you\\roblox-client-mcp",
      "env": {
        "ROBLOX_CLIENT_MCP_TOKEN": "YOUR_TOKEN",
        "ROBLOX_CLIENT_MCP_PORT": "32145"
      }
    }
  }
}
```

Or run it yourself: `bun run src/index.ts` (`bun start` is the same). Don't
do both, or the port is already taken.

### 3. Load the agent

Copy `agent.lua` into the executor workspace. In the live client, set the
same token, then load it:

```lua
getgenv().RobloxClientMcp = {
    Token = "YOUR_TOKEN",
}

loadstring(readfile("agent.lua"), "roblox-client-mcp")()
```

Default URL is `ws://127.0.0.1:32145/live`. The agent capability-detects
what the executor actually exposes. It requires `loadstring` and
`getgenv`. It does not switch on `identifyexecutor`.

It tries WebSocket first, then HTTP poll at `/live/poll`, then file-poll
with `writefile`/`readfile` under `roblox-client-mcp/` in the executor
workspace. If you land on file-poll, point `ROBLOX_CLIENT_MCP_FILEPOLL` at
that directory on the host.

## Tools

Each tool returns JSON text. Tools fail if no authenticated client is
connected.

| Tool | Returns |
| --- | --- |
| `roblox_list_instances` | An instance plus matches (`name`, `className`, `path`, `childCount`, `isScript`). Optional `path` (default `game`), `scope` (`children` / `all` / `nil`), `query`, `className`, and `limit`. |
| `roblox_list_scripts` | Matching scripts (`name`, `className`, `path`). Optional `query`, `scope` (`all` / `running` / `loaded` / `cached`), and `limit`. |
| `roblox_read_source` | `{ kind, data }`. Tries decompile, then bytecode, then constants, else empty (`luau` / `bytecode` / `constants` / `empty`). |
| `roblox_eval` | JSON-safe values from an explicit Luau chunk. Destructive. |

## Development

```powershell
bun run check
```
