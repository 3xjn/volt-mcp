"""Prime Agent bridge for the Windows-hosted Volt MCP stdio adapter."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from pathlib import Path
from typing import Any, Mapping, Sequence

_INITIALIZE_ID = 1
_REQUEST_ID = 2


def _repository_root() -> Path:
    configured = os.environ.get("VOLT_MCP_PLUGIN_ROOT", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return Path(__file__).resolve().parents[5]


def _windows_bun() -> str:
    configured = os.environ.get("VOLT_MCP_WINDOWS_BUN", "").strip()
    if configured:
        return configured
    executable = shutil.which("bun.exe")
    if executable:
        return executable
    raise RuntimeError(
        "Windows Bun (bun.exe) is unavailable. Install Bun on Windows or set "
        "VOLT_MCP_WINDOWS_BUN to its bun.exe path; Linux Bun cannot reach Windows Volt loopback."
    )


def _messages(method: str, params: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    return [
        {
            "jsonrpc": "2.0",
            "id": _INITIALIZE_ID,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "prime-agent-volt-mcp", "version": "0.1.0"},
            },
        },
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {
            "jsonrpc": "2.0",
            "id": _REQUEST_ID,
            "method": method,
            **({} if params is None else {"params": dict(params)}),
        },
    ]


def _response_for_request(stdout: str, stderr: str, exit_code: int) -> Any:
    responses: list[Mapping[str, Any]] = []
    for line in stdout.splitlines():
        if not line.strip():
            continue
        value = json.loads(line)
        if isinstance(value, Mapping):
            responses.append(value)
    response = next((item for item in responses if item.get("id") == _REQUEST_ID), None)
    if response is None:
        detail = stderr.strip() or f"adapter exited with code {exit_code}"
        raise RuntimeError(f"Volt MCP adapter returned no response: {detail}")
    error = response.get("error")
    if isinstance(error, Mapping):
        raise RuntimeError(f"Volt MCP error: {error.get('message', 'unknown error')}")
    return response.get("result")


async def _exchange(messages: Sequence[Mapping[str, Any]]) -> Any:
    root = _repository_root()
    adapter = root / "scripts" / "mcp.ts"
    if not adapter.is_file():
        raise RuntimeError(
            f"Volt MCP adapter was not found at {adapter}; set VOLT_MCP_PLUGIN_ROOT to the clone root."
        )
    process = await asyncio.create_subprocess_exec(
        _windows_bun(),
        "run",
        "./scripts/mcp.ts",
        cwd=str(root),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    payload = "".join(f"{json.dumps(message, separators=(',', ':'))}\n" for message in messages)
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(payload.encode()), timeout=130)
    except asyncio.TimeoutError as error:
        process.kill()
        await process.wait()
        raise RuntimeError("Volt MCP adapter timed out after 130 seconds") from error
    return _response_for_request(stdout.decode(), stderr.decode(), process.returncode or 0)


def _content(result: Any) -> Any:
    if not isinstance(result, Mapping):
        return result
    structured = result.get("structuredContent")
    if structured is not None:
        return structured
    blocks = result.get("content")
    if not isinstance(blocks, list):
        return result
    values: list[Any] = []
    for block in blocks:
        if not isinstance(block, Mapping) or block.get("type") != "text":
            values.append(block)
            continue
        text = block.get("text")
        if not isinstance(text, str):
            values.append(block)
            continue
        try:
            values.append(json.loads(text))
        except json.JSONDecodeError:
            values.append(text)
    return values[0] if len(values) == 1 else values


async def list_tools() -> list[dict[str, Any]]:
    """Discover the tools and JSON Schemas advertised by the live Volt MCP daemon."""
    result = await _exchange(_messages("tools/list", None))
    if not isinstance(result, Mapping) or not isinstance(result.get("tools"), list):
        raise RuntimeError("Volt MCP returned an invalid tools/list response")
    return list(result["tools"])


async def run(tool: str, arguments: Mapping[str, Any] | None = None) -> Any:
    """Call a Volt MCP tool by name and return parsed structured or text content."""
    result = await _exchange(
        _messages("tools/call", {"name": tool, "arguments": dict(arguments or {})})
    )
    if isinstance(result, Mapping) and result.get("isError") is True:
        raise RuntimeError(f"Volt MCP tool {tool} failed: {_content(result)}")
    return _content(result)


async def roblox_status() -> Any:
    """Report live Roblox registration, pairing, and connection state."""
    return await run("roblox_status")


async def roblox_prepare_pairing() -> Any:
    """Prepare a pairing challenge without showing the Volt dialog."""
    return await run("roblox_prepare_pairing")


async def roblox_present_pairing(challengeId: str) -> Any:
    """Present an already-visible pairing challenge in Volt."""
    return await run("roblox_present_pairing", {"challengeId": challengeId})


def __getattr__(name: str):
    if name.startswith("roblox_"):
        async def call(**arguments: Any) -> Any:
            return await run(name, arguments)
        call.__name__ = name
        call.__doc__ = f"Call the {name} Volt MCP tool. Use list_tools() for its current schema."
        return call
    raise AttributeError(name)
