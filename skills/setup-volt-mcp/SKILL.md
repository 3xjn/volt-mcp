---
name: setup-volt-mcp
description: Set up or repair the local Volt MCP runtime and Roblox pairing. Use whenever Volt MCP is installed but its Roblox tools are unavailable, the daemon is missing, Roblox is unpaired, or the user asks to install, configure, start, diagnose, or finish setting up Volt MCP.
---

# Set up Volt MCP

Requires Windows with Volt and Windows Bun (`bun.exe`) installed. The calling agent may run in WSL.

Use the bundled client-neutral setup instead of editing `config.toml`, creating scheduled tasks,
or managing credentials manually. Always launch it with Windows `bun.exe`, including from WSL. Do
not use Linux Bun: the resulting daemon would listen on WSL loopback while Volt connects to Windows
loopback.

1. Resolve the plugin root by walking two directories up from this `SKILL.md`.
2. Run the script in check mode first:

   ```text
   bun.exe run "<plugin-root>\scripts\setup.ts" check
   ```

3. If the returned JSON has `installed: true` and `daemonAvailable: true`, the installed autoexec,
   bootstrap, and agent match this plugin release. Do not reinstall or repeat first-run guidance.
4. If Bun is missing, explain that Bun is the only dependency the script does not install. Help the
   user install Bun, then rerun the check.
5. When setup is incomplete or an installed artifact is stale, run:

   ```text
   bun.exe run "<plugin-root>\scripts\setup.ts" install
   ```

6. Never print, log, read aloud, or quote either persisted credential. The installer reports only
   non-secret status and the safe one-time bootstrap command.
7. Only after `install`, use its returned `firstRunAction` and `bootstrapCommand`. Installing
   autoexec does not execute it in an already-running injected session, so ask the user to rejoin or
   reinject once, or use that returned local bootstrap command in Volt. A healthy `check` omits
   these one-time fields.
8. Once the unpaired Roblox agent is registered, call `roblox_prepare_pairing`. Surface its complete
   structured challenge to the user before continuing. This call must not show a Windows dialog.
9. Only after the user can see the returned code, call `roblox_present_pairing` with that exact
   `challengeId`. Volt then shows its Windows-style **Yes/No** dialog, independent of Roblox's
   in-game UI. Ask the user to compare the codes and choose **Yes** only when they match; **No** is
   the safe action on any mismatch. The code is correlation only, never approval or a credential.
10. Start a fresh MCP session after setup so the real Roblox tools replace setup mode.

The installer is idempotent. It manages:

- `%LOCALAPPDATA%\volt-mcp\runtime` as the stable daemon runtime;
- `%LOCALAPPDATA%\volt-mcp\state.json` as daemon-owned local state;
- `%LOCALAPPDATA%\Volt\workspace\volt-mcp` as the Roblox agent and credential location;
- `%LOCALAPPDATA%\Volt\autoexec\volt-mcp.lua` as the secret-free loader.

Use `--volt-root` only when the user says Volt is installed somewhere other than
`%LOCALAPPDATA%\Volt`. Volt currently supports Windows; do not present the Windows runtime
prerequisite as a Codex-specific restriction.
