# WSL Agent Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep Volt MCP on the Windows host while allowing Prime Agent and other MCP clients running in WSL to use it safely.

**Architecture:** Launch the stdio adapter with Windows Bun (`bun.exe`) so adapter, daemon, state, and Volt share the Windows loopback namespace. Reuse that adapter from a small Prime Python skill rather than exposing authenticated daemon ports beyond loopback.

**Tech Stack:** Bun, TypeScript, MCP JSON-RPC, Python asyncio, Agent Skills.

---

### Task 1: Lock the Windows-host launcher contract

**Files:**
- Modify: `tests/branding.test.ts`
- Modify: `.mcp.json`
- Modify: `scripts/mcp.ts`

1. Assert the plugin invokes `bun.exe`.
2. Make detached daemon startup reuse `process.execPath`.
3. Run the contract and adapter tests.

### Task 2: Add a Prime Agent bridge skill

**Files:**
- Create: `.agents/skills/volt-mcp/SKILL.md`
- Create: `.agents/skills/volt-mcp/pyproject.toml`
- Create: `.agents/skills/volt-mcp/src/volt_mcp/__init__.py`
- Create: `.agents/skills/volt-mcp/tests/test_volt_mcp.py`

1. Write tests for Windows Bun discovery and MCP response decoding.
2. Implement an async stdio client that launches the bundled adapter through `bun.exe`.
3. Expose tool discovery and calls to Prime without widening either loopback listener.
4. Run the Python skill tests.

### Task 3: Document WSL setup for all clients

**Files:**
- Modify: `README.md`
- Modify: `skills/setup-volt-mcp/SKILL.md`

1. Explain why WSL clients must use Windows Bun rather than Linux Bun.
2. Document the generic stdio command and Prime skill configuration.
3. Run the full repository check and a WSL smoke test through `bun.exe`.
