local fs = require("@lune/fs")

local source = fs.readFile("volt-agent.lua")
local chunk, compileError = loadstring(source, "volt-agent.lua")

assert(chunk, compileError)
print("volt-mcp-agent-syntax-contracts-ok")
