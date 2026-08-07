from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, MagicMock, patch

MODULE_PATH = Path(__file__).parents[1] / "src" / "volt_mcp" / "__init__.py"
SPEC = importlib.util.spec_from_file_location("volt_mcp_under_test", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
volt_mcp = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(volt_mcp)


class VoltMcpSkillTests(unittest.TestCase):
    def test_prefers_explicit_windows_bun(self) -> None:
        with patch.dict(os.environ, {"VOLT_MCP_WINDOWS_BUN": "/custom/bun.exe"}):
            self.assertEqual(volt_mcp._windows_bun(), "/custom/bun.exe")

    def test_missing_windows_bun_explains_host_boundary(self) -> None:
        with patch.dict(os.environ, {"VOLT_MCP_WINDOWS_BUN": ""}, clear=False), patch.object(
            volt_mcp.shutil, "which", return_value=None
        ):
            with self.assertRaisesRegex(RuntimeError, "Linux Bun cannot reach Windows Volt loopback"):
                volt_mcp._windows_bun()

    def test_extracts_requested_json_rpc_response(self) -> None:
        stdout = "\n".join(
            [
                json.dumps({"jsonrpc": "2.0", "id": 1, "result": {}}),
                json.dumps({"jsonrpc": "2.0", "id": 2, "result": {"tools": []}}),
            ]
        )
        self.assertEqual(
            volt_mcp._response_for_request(stdout, "", 0),
            {"tools": []},
        )

    def test_parses_single_json_text_content(self) -> None:
        result = {"content": [{"type": "text", "text": '{"state":"connected"}'}]}
        self.assertEqual(volt_mcp._content(result), {"state": "connected"})

    def test_dynamic_roblox_helper_relays_arguments(self) -> None:
        async def exercise() -> None:
            async def fake_run(tool: str, arguments=None):
                return {"tool": tool, "arguments": arguments}

            with patch.object(volt_mcp, "run", fake_run):
                result = await volt_mcp.roblox_search_scripts(query="Players")
            self.assertEqual(
                result,
                {"tool": "roblox_search_scripts", "arguments": {"query": "Players"}},
            )

        asyncio.run(exercise())

    def test_exchange_launches_relative_adapter_with_windows_bun(self) -> None:
        async def exercise() -> None:
            with TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "scripts").mkdir()
                (root / "scripts" / "mcp.ts").write_text("// adapter")
                stdout = b'{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n'
                process = MagicMock(returncode=0)
                process.communicate = AsyncMock(return_value=(stdout, b""))
                spawn = AsyncMock(return_value=process)

                with patch.object(volt_mcp, "_repository_root", return_value=root), patch.object(
                    volt_mcp, "_windows_bun", return_value="C:/Bun/bun.exe"
                ), patch.object(volt_mcp.asyncio, "create_subprocess_exec", spawn):
                    result = await volt_mcp._exchange(volt_mcp._messages("tools/list", None))

                self.assertEqual(result, {"tools": []})
                spawn.assert_awaited_once_with(
                    "C:/Bun/bun.exe",
                    "run",
                    "./scripts/mcp.ts",
                    cwd=str(root),
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                payload = process.communicate.await_args.args[0].decode()
                self.assertIn('"method":"initialize"', payload)
                self.assertIn('"method":"tools/list"', payload)

        asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
