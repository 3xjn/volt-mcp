# Volt MCP

Agent-facing Roblox code search and runtime inspection for Volt.

Volt MCP lets Codex inspect the Roblox client currently attached to Volt. It uses:

- one persistent, user-local Streamable HTTP MCP server;
- a WebSocket server bound only to `127.0.0.1`;
- an authenticated Volt auto-execute agent;
- Volt's documented script inventory and decompiler functions.

## 1. Choose a shared token

Generate a token once:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

Keep it local. Do not commit it.

## 2. Add the Volt auto-execute loader

Save this as a Volt auto-execute script, replacing `YOUR_TOKEN`:

```luau
getgenv().VoltMcp = {
    Token = "YOUR_TOKEN",
}

local source = readfile("volt-mcp/local/volt-agent.lua")
local chunk, compileError = loadstring(source, "Volt MCP")
assert(chunk, compileError)()
```

For a non-default port, add `Url = "ws://127.0.0.1:PORT/volt"` to the table.

The agent survives character respawns because it is attached to the client, not the character. It
retries when the local MCP server is not running and replaces an older copy when auto-execute runs
again. Volt's console reports `Volt MCP successfully loaded` after initialization and
`Volt MCP authentication successful` whenever the local bridge accepts the connection.

## 3. Start the persistent bridge

Install the bridge dependencies once:

```powershell
cd C:\git\volt-mcp
bun install
```

Store the same token in the Windows user environment:

```powershell
[Environment]::SetEnvironmentVariable("VOLT_MCP_TOKEN", "YOUR_TOKEN", "User")
```

Create a user logon task that runs `bun run src/index.ts` directly from this directory. One daemon
then owns both local listeners for the entire Windows session:

- `ws://127.0.0.1:32145/volt` for the Volt agent;
- `http://127.0.0.1:32146/mcp` for every Codex thread.

Only one daemon should run. Codex threads no longer start their own copy or compete for Volt's
fixed port.

## 4. Configure Codex

Add this user-level configuration to `C:\Users\<you>\.codex\config.toml`:

```toml
[mcp_servers.volt_mcp]
url = "http://127.0.0.1:32146/mcp"
bearer_token_env_var = "VOLT_MCP_TOKEN"
required = true
startup_timeout_sec = 10
tool_timeout_sec = 120
enabled_tools = [
  "roblox_status",
  "roblox_list_targets",
  "roblox_list_scripts",
  "roblox_search_scripts",
  "roblox_read_script",
  "roblox_inspect_closure",
  "roblox_mutate_closure",
  "roblox_restore_mutation",
  "roblox_eval",
]
default_tools_approval_mode = "approve"
```

`required = true` turns a missing daemon into a visible startup failure instead of silently omitting
the tools. A new Codex task is required after adding or changing an MCP server.

## Tools

- `roblox_status` shows the connected place and player.
- `roblox_list_targets` lists the game state and active Actor/Lua-state selectors.
- `roblox_list_scripts` discovers cached, running, or loaded client scripts. By default it excludes
  inactive scripts under players other than the local player.
- `roblox_search_scripts` searches indexed paths and decompiled text with ranked line snippets,
  using the same default exclusion.
- `roblox_read_script` resolves a canonical instance path and returns paged decompiler output.
- `roblox_inspect_closure` returns constants, upvalues, nested prototypes, and stable IDs for
  running closures associated with a script.
- `roblox_mutate_closure` compare-and-sets one same-type primitive constant or upvalue on a
  discovered running closure and returns a restore ID.
- `roblox_restore_mutation` restores that retained original value unless something else changed
  the live value in the meantime.
- `roblox_eval` executes an explicit Luau chunk and returns JSON-safe values.

Omitting `target` selects `{ "kind": "game" }`. Actor-aware calls can instead use
`{ "kind": "actor", "path": "workspace[...]" }` or a state selector returned by
`roblox_list_targets`. Actor/state eval uses Volt's Lua-state proxy and a private communication
channel; script tools validate that the selected script belongs to the requested state.

The script index performs an initial inventory scan, watches script-instance and Actor-state
changes, and rescans every 15 seconds as a fallback. Decompiled sources are indexed automatically
in a throttled background queue, with running and loaded scripts first. Source text uses an
8 MiB/128-entry resident cache; compact source identities and clues survive eviction so the corpus
can keep becoming searchable without retaining every decompiled file in the Roblox client. A
search with `refresh: true` rescans inventory and retries prior decompile errors, but never
synchronously decompiles the whole corpus. Search results report queue progress and cache limits
under `index`. No external indexer, user-maintained corpus, or manual indexing step is required.

Scripts below another `Player` are excluded from listing, indexing, and search by default because
their ordinary `PlayerScripts`, `PlayerGui`, and `Backpack` LocalScripts do not execute in the local
client. Scripts that Volt reports through `getrunningscripts()` or `getloadedmodules()` always remain
included. Pass `includeOtherPlayers: true` to list or search when investigating replicated
containers; responses report both the applied setting and the number of excluded scripts. Direct
read and inspection by canonical path remain unrestricted.

Search ranking combines canonical script-path matches, exact decompiled-text matches, source string
literals, stable API/member-call clues, and a small explicit map from behavior words such as
`smoothing` or `occlusion` to likely Roblox APIs. Results include the applied query expansion,
line-numbered snippets, SHA-256 identities for decompiled source and bytecode when available,
extracted source clues, and string/number constants read from bytecode for the ten highest-ranked
matches. Line snippets are available while a matching source is resident; stable clues remain
searchable after source eviction. Decompiled local and upvalue names are not treated as stable
semantic signals.

Inspection identifies a function by script bytecode hash, runtime closure ID, nested-prototype
indices, and debug line location. Constants and runtime upvalues are returned by numeric position;
runtime closure summaries include positional upvalue previews. Mutation uses that same closure plus
numeric slot mapping, verifies the expected value before writing, verifies the result afterward,
and retains the original value for guarded restore.

Decompiler output is still an approximation. Literal strings, numeric constants, API calls, and
script hierarchy usually survive ordinary decompilation well, while comments, meaningful locals,
some source locations, and reconstructed control flow may not. Obfuscation can additionally hide or
encode constants and flatten calls, so behavior queries can return weak or misleading ranks even
when exact path or runtime inspection still works.

For a narrow reversible edit, first inspect the script without `closureId`, choose one of the
returned `runtimeClosures`, inspect that ID, then mutate it with both `expected` and `value`.
Always pass the returned `mutationId` to `roblox_restore_mutation` after verification. Mutation
accepts only booleans, finite numbers, and strings, and the replacement type must match the live
value. Complex or intentionally broad changes remain possible through `roblox_eval`, which is
marked destructive.

## Development

```powershell
bun run check
```

`bun run smoke` connects as a fresh MCP client, lists the advertised tools, and checks the attached
Volt client status.

With a connected client, `bun run evaluate:search` runs a reusable retrieval check against
four behavior-labeled modules from Roblox's source-available PlayerModule: camera input, keyboard
movement, camera obstruction, and vehicle-camera smoothing. It reports each expected module's rank
within the decompiled corpus. `VOLT_MCP_ENDPOINT` can select a non-default bridge URL; the bridge
token still comes from `VOLT_MCP_TOKEN`.
