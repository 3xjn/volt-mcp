# ⚡ Volt MCP

**Live Roblox code search, runtime inspection, and controlled mutation for MCP-capable agents through
Volt.**

Volt MCP gives an agent a structured view into the Roblox client you already have attached to Volt:

- 🔎 search live script metadata and explicitly read source by path, text, constants, APIs, or behavior;
- 📖 read decompiled `LocalScript` and `ModuleScript` source in pages;
- 🧭 inspect game, Actor, and Lua-state targets plus live closure state;
- 🛠️ make explicit, guarded runtime changes with restoration support.

## Quick start

### Requirements

- **Windows**, **Volt**, and **Bun** must already be installed.
- Setup does not silently download or run either third-party runtime.
- Start a **new Codex task** after installing or updating the plugin so Codex reloads its tools.

Install the public Codex plugin:

```powershell
codex plugin marketplace add 3xjn/volt-mcp
codex plugin add volt-mcp@volt-mcp
```

To update an existing Codex installation to the latest marketplace release:

```powershell
codex plugin marketplace upgrade volt-mcp
codex plugin remove volt-mcp@volt-mcp
codex plugin add volt-mcp@volt-mcp
```

Start a new Codex task after reinstalling. Setup compares the installed autoexec loader, workspace
bootstrap, and Roblox agent with the plugin release and automatically rewrites stale copies.

No manual `config.toml` edit is required. In a new task, choose **Set up Volt MCP on this PC**, or
run the same client-neutral setup directly:

```powershell
bun.exe run scripts/setup.ts install
```

Setup installs or updates the stable runtime at `%LOCALAPPDATA%\volt-mcp\runtime`, creates
daemon-owned state at `%LOCALAPPDATA%\volt-mcp\state.json`, writes a secret-free loader to
`%LOCALAPPDATA%\Volt\autoexec\volt-mcp.lua`, installs the locked production dependencies, and starts
the local daemon. It is safe to rerun for updates or repair.

Volt path discovery defaults to `%LOCALAPPDATA%\Volt`. For a custom location:

```powershell
bun.exe run scripts/setup.ts install --volt-root C:\path\to\Volt
```

### Agents running in WSL

Keep the entire Volt MCP runtime on the Windows host. WSL and Windows have different loopback
namespaces in common WSL2 configurations, so launching this project with Linux Bun can leave Volt
unable to reach the bridge. Use **Windows Bun** (`bun.exe`) from WSL instead:

```bash
bun.exe run scripts/setup.ts install
```

The bundled MCP configuration already uses `bun.exe`. For a stdio MCP client that supports a `cwd`
extension, set the clone as its working directory and keep the script argument relative:

```json
{
  "command": "bun.exe",
  "args": ["run", "./scripts/mcp.ts"],
  "cwd": "/mnt/c/path/to/volt-mcp"
}
```

If the client does not support `cwd`, pass the script as an absolute **Windows-form** argument:

```json
{
  "command": "bun.exe",
  "args": ["run", "C:\\path\\to\\volt-mcp\\scripts\\mcp.ts"]
}
```

Keep the clone on a Windows-mounted path such as `/mnt/c/...` so `bun.exe` can access it. WSL does
not translate `/mnt/c/...` strings passed as arguments to Windows executables, so use `wslpath -w`
when generating the second form. If `bun.exe` is not inherited on WSL's `PATH`, use its absolute
`/mnt/c/.../bun.exe` path as `command`. Do not substitute Linux Bun.

#### Prime Agent

This repository includes a Python-backed Prime skill at `.agents/skills/volt-mcp`. Prime discovers
it automatically when started in this repository. To use it from other working directories, add the
skill directory to `~/.prime/agent/settings.json` and reload Prime:

```json
{
  "skills": ["/mnt/c/path/to/volt-mcp/.agents/skills"]
}
```

Then Prime can use `await volt_mcp.list_tools()`, `await volt_mcp.roblox_status()`, and the other
advertised `roblox_*` methods. The skill talks to the bundled stdio adapter through `bun.exe`; it
does not expose either loopback listener to WSL or copy credentials into configuration. If needed,
set `VOLT_MCP_WINDOWS_BUN` to the absolute path of Windows `bun.exe`.

### First run

Setup writes autoexec for the next injected session. It cannot make an already-running injected
session execute a new file, so **rejoin or reinject Roblox once** after first setup. If Volt exposes
a console in the current session, this optional one-time bootstrap loads the same installed agent:

```luau
loadstring(readfile("volt-mcp/bootstrap.lua"), "Volt MCP bootstrap")()
```

## Pairing contract

The Roblox agent connects only to `ws://127.0.0.1:32145/volt` and registers its session without
opening a dialog. Pairing is deliberately two-phase so the MCP-side code is visible first:

1. Call **`roblox_prepare_pairing`**. It immediately returns a structured challenge with
   `challengeId`, six-digit `verificationCode`, `expiresAt`, the pending Roblox session, local
   daemon identity and endpoint, granted scope, persistence, and `nextAction`. **No Windows dialog
   exists yet.**
2. Show that result to the user.
3. Call **`roblox_present_pairing`** with the returned `challengeId`.
4. Volt's documented, yielding Windows
   [**Yes/No** messagebox](https://docs.voltbz.net/docs/miscellaneous/messagebox) opens with the same
   code, session, daemon, scope, and persistence details.

Choose **Yes only when the codes match**. Choose **No on any mismatch**.

> [!IMPORTANT]
> The six-digit code only correlates the pending MCP result with the pending Windows dialog. It is
> not authorization and it is not a credential. Approval is exclusively the user's **Yes** action.

Yes persists a long random credential locally for future Volt sessions. No, expiry, replacement,
disconnect, an unavailable messagebox, or any unexpected result stores nothing and leaves pairing
retryable.

## Trust boundary

- The Volt agent bridge is loopback-only at `ws://127.0.0.1:32145/volt`; the local MCP daemon listens
  at `http://127.0.0.1:32146/mcp`.
- Approval grants MCP clients authorized to that daemon the ability to inspect live scripts and
  runtime state, and to execute or modify client-side Luau.
- The daemon stores only a SHA-256 hash of the Roblox credential in
  `%LOCALAPPDATA%\volt-mcp\state.json`.
- The Roblox-side credential stays in Volt's workspace at `volt-mcp/credential.json`.
- A separate local MCP-client credential lives in the daemon state file. The bundled stdio adapter
  reads it directly; editors do not need a token environment variable.

Reset persisted Roblox pairing with:

```powershell
bun.exe run scripts/setup.ts reset-pairing
```

After resetting, restart or reconnect the active Volt session so its saved workspace credential is
rejected and removed. Resetting does not remove the separate local MCP-client credential.

## Runtime status

`roblox_status` is always the recovery surface:

| State | Meaning |
| --- | --- |
| `unpaired` | No saved pairing and no unpaired Roblox session is registered. |
| `ready_to_pair` | Roblox registered silently and is ready for challenge preparation. |
| `challenge_ready` | MCP prepared a challenge; no Windows dialog has been shown. |
| `awaiting_user_approval` | The matching Windows Yes/No dialog is waiting for a decision. |
| `pairing_declined` | The user declined; nothing was stored and a retry is allowed. |
| `pairing_expired` | The challenge expired; late results cannot authorize and a retry is allowed. |
| `waiting_for_roblox` | Pairing is saved, but the Roblox agent is not currently connected. |
| `connected` | The paired Roblox agent is online and tools can reach it. |

The stdio adapter starts the installed daemon when needed and never waits for Roblox. Before setup,
it initializes in a safe setup mode without placeholder Roblox tools; start a fresh Codex task after
setup to load the live tool list.

## Tools by intent

### Connect and pair

| Tool | Purpose |
| --- | --- |
| `roblox_status` | Read registration, pairing, waiting, and connection state. |
| `roblox_prepare_pairing` | Create and return a challenge without displaying a dialog. |
| `roblox_present_pairing` | Present the current challenge in Volt's Windows Yes/No messagebox. |

### Discover and read

| Tool | Purpose |
| --- | --- |
| `roblox_list_targets` | List the game state and active Actor/Lua-state selectors. |
| `roblox_list_scripts` | List cached, running, or loaded client scripts. |
| `roblox_search_scripts` | Search live paths plus source cached by explicit reads. Never decompiles in the background. |
| `roblox_read_script` | **Explicit native operation:** decompile one canonical script path and return paged output. |

### Inspect and change

| Tool | Purpose |
| --- | --- |
| `roblox_inspect_closure` | Inspect stable closure identity, constants, upvalues, and prototypes. |
| `roblox_mutate_closure` | **State-changing:** compare-and-set one primitive constant or upvalue. |
| `roblox_restore_mutation` | **State-changing:** guarded restoration using a retained mutation ID. |
| `roblox_eval` | **Destructive:** execute an explicit Luau chunk in the live client. |

## How it works

<details>
<summary><strong>Targets and script visibility</strong></summary>

Omitting `target` selects `{ "kind": "game" }`. Actor-aware calls can use
`{ "kind": "actor", "path": "workspace[...]" }` or a state selector from
`roblox_list_targets`. Actor/state eval uses Volt's Lua-state proxy and a private communication
channel; script tools validate that the selected script belongs to the requested state.

Scripts below another `Player` are excluded from listing, indexing, and search by default because
their ordinary `PlayerScripts`, `PlayerGui`, and `Backpack` LocalScripts do not execute in the local
client. Scripts reported by `getrunningscripts()` or `getloadedmodules()` remain included. Pass
`includeOtherPlayers: true` when replicated containers matter. Direct read and inspection by
canonical path remain unrestricted.

</details>

<details>
<summary><strong>Indexing and search</strong></summary>

The script index is demand-driven. Listing or searching scans client-visible script metadata, while
script-instance and Actor-state changes mark that inventory stale. Volt MCP does not call Volt's
native decompiler on join, while idle, or during a search. `refresh: true` only forces a fresh
metadata inventory scan.

`roblox_read_script` is the single explicit source-decompilation boundary: it decompiles the selected
canonical path and places that source in an 8 MiB/128-entry resident cache. Later searches can rank
and quote cached source. The `index` result reports `sourceMode: "explicit_read"` and
`backgroundDecompile: false`.

Ranking combines canonical path matches, exact decompiled-text matches, source string literals,
stable API/member-call clues, and a small behavior-to-API map. Results can include query expansion,
line-numbered snippets, SHA-256 source and bytecode identities, extracted clues, and constants from
the ten highest-ranked matches. Decompiled local and upvalue names are not treated as stable
semantic signals.

</details>

<details>
<summary><strong>Decompiler and mutation caveats</strong></summary>

Decompiler output is an approximation, and the native decompiler runs inside Volt rather than a
memory-safe Volt MCP process. It is invoked only when an MCP client explicitly requests
`roblox_read_script` for one path, never as join-time or idle maintenance. Literal strings, numeric
constants, API calls, and script hierarchy usually survive ordinary decompilation; comments,
meaningful locals, some source locations, and reconstructed control flow may not. Obfuscation can
further weaken search results.

Inspection identifies a function by script bytecode hash, runtime closure ID, nested-prototype
indices, and debug line. For a narrow reversible edit, inspect the script, choose a returned runtime
closure, inspect that ID, then mutate it with both `expected` and `value`. Mutation accepts only
booleans, finite numbers, and strings of the same live type. It verifies before and after writing,
retains the original value, and returns a `mutationId` for guarded restoration.

`roblox_eval` remains the intentionally broad, destructive escape hatch.

</details>

## Development

```powershell
bun run check
```

- `bun run smoke` lists advertised tools and checks the attached client status.
- `bun run evaluate:search` runs the connected-client retrieval benchmark.
- `VOLT_MCP_ENDPOINT` selects a non-default daemon URL; authorization still comes from local state.
