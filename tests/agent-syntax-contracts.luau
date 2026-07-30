local fs = require("@lune/fs")

local source = fs.readFile("volt-agent.lua")
local chunk, compileError = loadstring(source, "volt-agent.lua")

-- Given the installed autoexec agent owns the Roblox side of pairing
assert(chunk, compileError)
-- Then it must request approval through Volt's yielding native messagebox
assert(source:find('type = "pair_request"', 1, true))
assert(source:find('request.type == "pair_challenge"', 1, true))
assert(source:find('type(messagebox) == "function"', 1, true))
assert(source:find("pcall(messagebox, body, caption, 4 + 32)", 1, true))
assert(source:find("approved = succeeded and result == 6", 1, true))
assert(source:find("task.spawn(function()", 1, true))
assert(source:find("activePairing == pairing", 1, true))
assert(source:find("DateTime.now().UnixTimestampMillis < pairing.expiresAt", 1, true))
assert(source:find("gameId = game.GameId", 1, true))
assert(source:find('request.type == "pair_stale"', 1, true))
assert(source:find("Daemon: ", 1, true))
assert(source:find("Endpoint: ", 1, true))
assert(source:find("execute or modify client-side Luau", 1, true))
assert(source:find("No stores nothing.", 1, true))
assert(source:find("It is not authorization or a credential.", 1, true))
assert(source:find("Choose No on any mismatch.", 1, true))
assert(source:find('writefile("volt-mcp/credential.json"', 1, true))
assert(not source:find("configuration.Token", 1, true))
assert(not source:find('Instance.new("ScreenGui")', 1, true))
assert(not source:find("gethui", 1, true))

-- Joining or idling must never invoke Volt's native decompiler. Native faults
-- cannot be contained by Luau pcall, so decompilation is reserved for an
-- explicit read of one selected script.
local maintenanceStart = assert(source:find("local function startIndexMaintenance()", 1, true))
local maintenanceEnd = assert(source:find("local function send(payload)", maintenanceStart, true))
local maintenanceSource = source:sub(maintenanceStart, maintenanceEnd - 1)
assert(not maintenanceSource:find("indexNextQueuedSource", 1, true))
assert(not maintenanceSource:find("getIndexedSource", 1, true))
assert(not maintenanceSource:find("decompile", 1, true))

local searchStart = assert(source:find("function handlers.searchScripts(params)", 1, true))
local searchEnd = assert(source:find("function handlers.readScript(params)", searchStart, true))
local searchSource = source:sub(searchStart, searchEnd - 1)
assert(searchSource:find("getIndexedSource(entry, false)", 1, true))
assert(not searchSource:find("getIndexedSource(entry, true)", 1, true))

local readStart = searchEnd
local readEnd = assert(source:find("function handlers.inspectClosure(params)", readStart, true))
local readSource = source:sub(readStart, readEnd - 1)
assert(readSource:find("getIndexedSource(entry, true)", 1, true))
local _, nativeDecompileCalls = source:gsub("pcall%(decompile", "")
assert(nativeDecompileCalls == 1)

print("volt-mcp-agent-syntax-contracts-ok")
