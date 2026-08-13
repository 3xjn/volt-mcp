<p align="center">
  <p align="center">
    <img width="150" height="150" src="assets/volt-mcp-icon.png" alt="Volt MCP logo">
  </p>
  <h1 align="center"><b>Volt MCP</b></h1>
  <p align="center">
    Give your AI agent eyes and hands inside a live Roblox client.
    <br />
    <a href="#-quick-start"><strong>Get connected →</strong></a>
  </p>
</p>

<div align="center">

![Windows](https://img.shields.io/badge/Windows-0078D4?style=for-the-badge&logo=windows11&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-fbf0df?style=for-the-badge&logo=bun&logoColor=14151a)
![MCP](https://img.shields.io/badge/MCP-e6ff55?style=for-the-badge&logoColor=14151a)

</div>

**Volt MCP** connects MCP-capable agents to the Roblox client already attached to
[Volt](https://docs.voltbz.net/). Search live scripts, read decompiled source on demand, inspect
runtime state, and make guarded changes without turning your client into a black box.

- 🔎 **Find the right script** by path, source text, constants, APIs, or behavior
- 📖 **Read source deliberately** — nothing decompiles in the background
- 🧭 **Inspect deeper** across game, Actor, Lua-state, and closure targets
- 🛠️ **Change carefully** with compare-and-set mutations and guarded restoration

## ⚡ Quick start

### Requirements

[Windows](https://www.microsoft.com/windows), [Volt](https://voltbz.net/), and
[Bun](https://bun.sh/) must already be installed. Volt MCP never silently downloads either runtime.

### Install for Codex

```powershell
codex plugin marketplace add 3xjn/volt-mcp
codex plugin add volt-mcp@volt-mcp
```

Start a **new Codex task**, then choose **Set up Volt MCP on this PC**. You can also run setup
manually:

```powershell
bun.exe run scripts/setup.ts install
```

Setup is safe to rerun for updates or repair. It installs the local runtime, writes Volt's autoexec
loader, installs locked dependencies, and starts the daemon.

> [!TIP]
> Rejoin or reinject Roblox once after first setup so Volt can run the new autoexec loader.

### Pair once

1. Ask your agent to connect to Roblox.
2. It prepares a six-digit challenge, then opens Volt's matching **Yes/No** dialog.
3. Confirm only when both codes match.

Approval is stored locally for future sessions. To start over:

```powershell
bun.exe run scripts/setup.ts reset-pairing
```

## 🧰 Tools

| Intent | Tools |
| --- | --- |
| **Connect** | `roblox_status`, `roblox_list_clients`, `roblox_prepare_pairing`, `roblox_present_pairing` |
| **Discover** | `roblox_list_targets`, `roblox_list_scripts`, `roblox_search_scripts` |
| **Read** | `roblox_read_script`, `roblox_inspect_closure` |
| **Change** | `roblox_mutate_closure`, `roblox_restore_mutation`, `roblox_eval` |

`roblox_status` is always the recovery surface. It tells the agent whether Roblox is ready to pair,
waiting for approval, disconnected, or fully connected.

When several paired Volt clients are live, `roblox_list_clients` returns a daemon-issued `client`
UUID with each Roblox job and player. Pass that UUID to the other runtime tools. The selector is
optional while exactly one client is connected and required when two or more are connected; `target`
continues to select the game, Actor, or Lua state inside that client.

## 🛡️ Safety by design

- Both listeners are loopback-only: `ws://127.0.0.1:32145/volt` and
  `http://127.0.0.1:32146/mcp`.
- Reading source is an explicit native operation; search never decompiles scripts behind your back.
- Pairing shows the session, daemon, scope, persistence, and matching code before approval.
- Narrow edits require the expected live value, verify the write, and return a restoration ID.
- `roblox_eval` is intentionally marked destructive — broad power should look broad.
- The daemon stores a SHA-256 hash of the Roblox credential, not the credential itself.

> [!IMPORTANT]
> The six-digit code identifies the pairing attempt; it is not a credential. Authorization happens
> only when you choose **Yes** in Volt's dialog.

## 🔌 Other clients

<details>
<summary><b>Run an MCP client from WSL</b></summary>

Keep the runtime on Windows and use **Windows Bun** (`bun.exe`). WSL2 and Windows commonly have
separate loopback namespaces, so Linux Bun cannot host a bridge that Volt can reach.

```bash
bun.exe run scripts/setup.ts install
```

For clients that support `cwd`:

```json
{
  "command": "bun.exe",
  "args": ["run", "./scripts/mcp.ts"],
  "cwd": "/mnt/c/path/to/volt-mcp"
}
```

Otherwise, pass an absolute Windows-form script path:

```json
{
  "command": "bun.exe",
  "args": ["run", "C:\\path\\to\\volt-mcp\\scripts\\mcp.ts"]
}
```

Keep the clone under `/mnt/c/...`; use `wslpath -w` when generating Windows-form arguments. Do not
substitute Linux Bun.

</details>

<details>
<summary><b>Use the bundled Prime Agent skill</b></summary>

Prime discovers `.agents/skills/volt-mcp` automatically inside this repository. To use it from any
working directory, add the skill root to `~/.prime/agent/settings.json`, then reload Prime:

```json
{
  "skills": ["/mnt/c/path/to/volt-mcp/.agents/skills"]
}
```

Prime can then call `await volt_mcp.roblox_status()` and the other advertised `roblox_*` methods.
Set `VOLT_MCP_WINDOWS_BUN` only when `bun.exe` is not inherited on WSL's `PATH`.

</details>

<details>
<summary><b>Use a custom Volt install</b></summary>

Volt is discovered at `%LOCALAPPDATA%\Volt` by default:

```powershell
bun.exe run scripts/setup.ts install --volt-root C:\path\to\Volt
```

</details>

## 🧠 How search works

Volt MCP keeps a lightweight inventory of client-visible script metadata. Only
`roblox_read_script` invokes Volt's native decompiler, one canonical path at a time. Explicitly read
source enters an 8 MiB / 128-entry cache, where later searches can rank paths, literals, API clues,
and behavior hints without surprise decompilation.

Decompiler output is approximate: literals, constants, calls, and hierarchy tend to survive;
comments, local names, source locations, and reconstructed control flow may not. Obfuscation makes
those signals weaker.

## 🛠️ Development

```powershell
bun run check
```

- `bun run smoke` checks advertised tools and client status.
- `bun run evaluate:search` runs the connected-client retrieval benchmark.
- `VOLT_MCP_ENDPOINT` selects a non-default daemon URL; authorization still comes from local state.
