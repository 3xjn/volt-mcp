-- allow: SIZE_OK — Volt auto-execute requires one standalone client payload.
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local environment = assert(getgenv, "Volt getgenv is required")()
local configuration = environment.VoltMcp or {}
local endpoint = configuration.Url or "ws://127.0.0.1:32145/volt"
local token

assert(type(endpoint) == "string", "VoltMcp.Url must be a string")

local credentialRead, credentialSource = pcall(readfile, "volt-mcp/credential.json")
if credentialRead and type(credentialSource) == "string" then
    local decoded, credential = pcall(HttpService.JSONDecode, HttpService, credentialSource)
    if decoded and type(credential) == "table" and type(credential.token) == "string" and #credential.token >= 32 then
        token = credential.token
    end
end

if environment.VoltMcpAgent then
    environment.VoltMcpAgent.Stop()
end

local function skipWhitespace(source, position)
    local _, last = source:find("^%s*", position)
    return (last or position - 1) + 1
end

local function parseQuoted(source, position)
    local quote = source:sub(position, position)
    if quote ~= '"' and quote ~= "'" then
        return nil, position, "Expected a quoted instance name"
    end

    local escaped = false
    local cursor = position + 1
    while cursor <= #source do
        local character = source:sub(cursor, cursor)
        if escaped then
            escaped = false
        elseif character == "\\" then
            escaped = true
        elseif character == quote then
            local literal = source:sub(position, cursor)
            local chunk, compileError = loadstring("return " .. literal, "instance path segment")
            if not chunk then
                return nil, cursor, compileError
            end
            local succeeded, value = pcall(chunk)
            if not succeeded or type(value) ~= "string" then
                return nil, cursor, tostring(value)
            end
            return value, cursor + 1
        end
        cursor += 1
    end

    return nil, cursor, "Unterminated quoted instance name"
end

local function resolvePath(source)
    if type(source) ~= "string" then
        return nil, "Instance path must be a string"
    end

    source = source:match("^%s*(.-)%s*$")
    local current
    local position
    if source:sub(1, 4) == "game" then
        current = game
        position = 5
    elseif source:sub(1, 9) == "workspace" then
        current = workspace
        position = 10
    else
        return nil, 'Instance paths must begin with "game" or "workspace"'
    end

    while position <= #source do
        position = skipWhitespace(source, position)
        if position > #source then
            break
        end

        if source:sub(position, position + 11) == ":GetService(" then
            if current ~= game then
                return nil, "GetService is only valid on game"
            end
            position = skipWhitespace(source, position + 12)
            local name, nextPosition, parseError = parseQuoted(source, position)
            if not name then
                return nil, parseError
            end
            position = skipWhitespace(source, nextPosition)
            if source:sub(position, position) ~= ")" then
                return nil, "Expected ) after GetService"
            end
            local succeeded, service = pcall(game.GetService, game, name)
            if not succeeded then
                return nil, tostring(service)
            end
            current = service
            position += 1
        elseif source:sub(position, position) == "." then
            local name = source:match("^([%a_][%w_]*)", position + 1)
            if not name then
                return nil, "Expected a member name after ."
            end
            local child = current:FindFirstChild(name)
            if not child then
                return nil, ('Could not resolve "%s"'):format(name)
            end
            current = child
            position += #name + 1
        elseif source:sub(position, position) == "[" then
            position = skipWhitespace(source, position + 1)
            local name, nextPosition, parseError = parseQuoted(source, position)
            if not name then
                return nil, parseError
            end
            position = skipWhitespace(source, nextPosition)
            if source:sub(position, position) ~= "]" then
                return nil, "Expected ] after instance name"
            end
            local child = current:FindFirstChild(name)
            if not child then
                return nil, ('Could not resolve "%s"'):format(name)
            end
            current = child
            position += 1
        else
            return nil, ("Unexpected path syntax at character %d"):format(position)
        end
    end

    return current
end

local function getInstancePath(instance)
    if instance == game then
        return "game"
    end
    if instance == workspace then
        return "workspace"
    end
    if not instance.Parent then
        return ("<nil>[%q]"):format(instance.Name)
    end

    local segments = {}
    local current = instance
    while current.Parent and current.Parent ~= game and current ~= workspace do
        table.insert(segments, 1, ("[%q]"):format(current.Name))
        current = current.Parent
    end

    local root
    if current == workspace then
        root = "workspace"
    elseif current.Parent == game then
        root = ("game:GetService(%q)"):format(current.ClassName)
    else
        root = "game"
    end
    return root .. table.concat(segments)
end

local function serialize(value, depth, seen)
    local valueType = typeof(value)
    if value == nil then
        return { type = "nil" }
    end
    if valueType == "boolean" or valueType == "string" then
        return value
    end
    if valueType == "number" then
        if value ~= value or value == math.huge or value == -math.huge then
            return { type = "number", value = tostring(value) }
        end
        return value
    end
    if valueType == "Instance" then
        return {
            type = "Instance",
            className = value.ClassName,
            name = value.Name,
            path = getInstancePath(value),
        }
    end
    if valueType ~= "table" then
        return { type = valueType, value = tostring(value) }
    end
    if depth >= 6 then
        return { type = "table", truncated = true, reason = "depth" }
    end
    if seen[value] then
        return { type = "table", circular = true }
    end

    seen[value] = true
    local entries = {}
    local count = 0
    local truncated = false
    for key, child in next, value do
        count += 1
        if count > 200 then
            truncated = true
            break
        end
        table.insert(entries, {
            key = serialize(key, depth + 1, seen),
            value = serialize(child, depth + 1, seen),
        })
    end
    seen[value] = nil
    return { type = "table", entries = entries, truncated = truncated }
end

local function collectScripts(scope, includeOtherPlayers)
    local scripts = {}
    local seen = {}
    local activeScripts = {}
    local excludedOtherPlayerScripts = 0

    local function readInventory(getter)
        local succeeded, values = pcall(getter)
        if not succeeded or type(values) ~= "table" then
            return {}
        end
        local inventory = {}
        for _, instance in ipairs(values) do
            if typeof(instance) == "Instance" and instance:IsA("LuaSourceContainer") then
                table.insert(inventory, instance)
            end
        end
        return inventory
    end

    local runningScripts = readInventory(getrunningscripts)
    local loadedModules = readInventory(getloadedmodules)
    for _, instance in ipairs(runningScripts) do
        activeScripts[instance] = true
    end
    for _, instance in ipairs(loadedModules) do
        activeScripts[instance] = true
    end

    local function append(values)
        for _, instance in ipairs(values) do
            if not seen[instance] then
                local otherPlayer = instance:FindFirstAncestorOfClass("Player")
                if
                    activeScripts[instance]
                    or includeOtherPlayers
                    or not (otherPlayer ~= nil and otherPlayer ~= Players.LocalPlayer)
                then
                    seen[instance] = true
                    table.insert(scripts, instance)
                else
                    excludedOtherPlayerScripts += 1
                end
            end
        end
    end

    if scope == "all" or scope == "running" then
        append(runningScripts)
    end
    if scope == "all" or scope == "loaded" then
        append(loadedModules)
    end
    if scope == "all" or scope == "cached" then
        append(readInventory(getscripts))
    end
    return scripts, excludedOtherPlayerScripts
end

local scriptIndex = {}
local indexDirty = true
local indexGeneration = 0
local lastIndexScan = 0
local indexIncludesOtherPlayers = false
local indexExcludedOtherPlayerScripts = 0
local cachedSourceBytes = 0
local cachedSourceCount = 0
local descendantAddedConnection
local descendantRemovingConnection
local actorStateConnection
local mutations = {}
local scriptClosures = setmetatable({}, { __mode = "kv" })
local runtimeClosureIds = setmetatable({}, { __mode = "k" })
local runtimeClosures = setmetatable({}, { __mode = "v" })

local INDEX_REFRESH_SECONDS = 15
local MAX_INDEX_SOURCE_BYTES = 8 * 1024 * 1024
local MAX_INDEX_SOURCE_ENTRIES = 128
local MAX_SEARCH_BYTECODE_ENRICHMENTS = 10
local MAX_CONSTANTS = 1000
local MAX_PROTOTYPES = 500
local MAX_RUNTIME_CLOSURES = 500
local MAX_UPVALUES = 500
local MAX_MUTATIONS = 100

local function getStateId(state)
    local succeeded, stateId = pcall(function()
        return state.Id
    end)
    if not succeeded or type(stateId) ~= "number" then
        return nil
    end
    return stateId
end

local function getInstanceStateId(instance)
    local succeeded, state = pcall(getluastate, instance)
    if not succeeded then
        return nil
    end
    return getStateId(state)
end

local function resolveTarget(selector)
    selector = selector or { kind = "game" }
    local kind = selector.kind or "game"
    if kind == "game" then
        local succeeded, state = pcall(getgamestate)
        if not succeeded then
            succeeded, state = pcall(getluastate)
        end
        if not succeeded then
            error("Could not resolve the default game Lua state: " .. tostring(state))
        end
        return {
            kind = "game",
            selector = { kind = "game" },
            state = state,
            stateId = assert(getStateId(state), "Game Lua state has no numeric ID"),
            isActorState = false,
        }
    end

    if kind == "actor" then
        local actor, resolveError = resolvePath(selector.path)
        if not actor then
            error(resolveError)
        end
        if not actor:IsA("Actor") then
            error(("Target path resolves to %s, not an Actor"):format(actor.ClassName))
        end
        local succeeded, state = pcall(getluastate, actor)
        if not succeeded then
            error("Could not resolve the Actor Lua state: " .. tostring(state))
        end
        return {
            kind = "actor",
            selector = { kind = "actor", path = getInstancePath(actor) },
            state = state,
            stateId = assert(getStateId(state), "Actor Lua state has no numeric ID"),
            isActorState = true,
            actor = actor,
        }
    end

    if kind == "state" then
        local requestedId = tonumber(selector.id)
        if not requestedId then
            error("Lua state targets require a numeric ID")
        end
        local succeeded, states = pcall(getactorstates)
        if not succeeded or type(states) ~= "table" then
            error("Could not enumerate Lua states: " .. tostring(states))
        end
        for _, state in ipairs(states) do
            if getStateId(state) == requestedId then
                local actorState = false
                pcall(function()
                    actorState = state.IsActorState == true
                end)
                return {
                    kind = "state",
                    selector = { kind = "state", id = requestedId },
                    state = state,
                    stateId = requestedId,
                    isActorState = actorState,
                }
            end
        end
        error(("Lua state %d is not active"):format(requestedId))
    end

    error("Invalid target kind: " .. tostring(kind))
end

local function describeTarget(target)
    return {
        selector = target.selector,
        stateId = target.stateId,
        isActorState = target.isActorState,
    }
end

local function ensureTargetOwnsScript(target, instance)
    local stateId = getInstanceStateId(instance)
    if stateId == nil and target.kind == "game" then
        return
    end
    if stateId ~= target.stateId then
        error(
            ("Script belongs to Lua state %s, not target state %d"):format(
                tostring(stateId),
                target.stateId
            )
        )
    end
end

local function splitLines(source)
    local lines = {}
    for line in (source .. "\n"):gmatch("(.-)\n") do
        table.insert(lines, line)
    end
    return lines
end

local function hashString(value)
    local succeeded, digest = pcall(crypt.hash, value, "sha256")
    if succeeded and type(digest) == "string" then
        return digest
    end
    return nil
end

local function appendUnique(values, seen, value, limit)
    if value == "" or seen[value] or #values >= limit then
        return
    end
    seen[value] = true
    table.insert(values, value)
end

local function extractSourceClues(source)
    local strings = {}
    local numbers = {}
    local apiMembers = {}
    local seenStrings = {}
    local seenNumbers = {}
    local seenApiMembers = {}

    for value in source:gmatch('"([^"\n]-)"') do
        if #value <= 160 then
            appendUnique(strings, seenStrings, value, 32)
        end
    end
    for value in source:gmatch("'([^'\n]-)'") do
        if #value <= 160 then
            appendUnique(strings, seenStrings, value, 32)
        end
    end
    for value in source:gmatch("%f[%d][+-]?%d+%.?%d*%f[^%w_.]") do
        appendUnique(numbers, seenNumbers, value, 24)
    end
    for service in source:gmatch("GetService%s*%(%s*[\"']([^\"']+)[\"']%s*%)") do
        appendUnique(apiMembers, seenApiMembers, "service:" .. service, 48)
    end
    for member in source:gmatch("[:%.]([%a_][%w_]*)") do
        appendUnique(apiMembers, seenApiMembers, member, 48)
    end

    return {
        sourceStrings = strings,
        sourceNumbers = numbers,
        apiMembers = apiMembers,
    }
end

local function ensureEntryBytecodeIdentity(entry)
    if entry.bytecodeAttempted then
        return
    end
    entry.bytecodeAttempted = true
    local succeeded, bytecode = pcall(getscriptbytecode, entry.instance)
    if succeeded and type(bytecode) == "string" then
        entry.bytecodeSize = #bytecode
        entry.bytecodeSha256 = hashString(bytecode)
    else
        entry.bytecodeError = tostring(bytecode)
    end
end

local function describeEntryIdentity(entry, includeBytecode)
    if includeBytecode ~= false then
        ensureEntryBytecodeIdentity(entry)
    end
    return {
        path = entry.path,
        stateId = entry.stateId,
        decompiledSourceSha256 = entry.sourceSha256,
        bytecodeSha256 = entry.bytecodeSha256,
        bytecodeSize = entry.bytecodeSize,
        bytecodeError = entry.bytecodeError,
    }
end

local function dropCachedSource(entry)
    if entry and entry.source then
        cachedSourceBytes = math.max(0, cachedSourceBytes - #entry.source)
        cachedSourceCount = math.max(0, cachedSourceCount - 1)
        entry.source = nil
        entry.lastSourceAccess = nil
    end
end

local function evictOldestSource(excludedEntry)
    local oldestEntry
    local oldestAccess = math.huge
    for _, candidate in next, scriptIndex do
        if
            candidate ~= excludedEntry
            and candidate.source
            and (candidate.lastSourceAccess or 0) < oldestAccess
        then
            oldestEntry = candidate
            oldestAccess = candidate.lastSourceAccess or 0
        end
    end
    if oldestEntry then
        dropCachedSource(oldestEntry)
        return true
    end
    return false
end

local function cacheIndexedSource(entry, source)
    if #source > MAX_INDEX_SOURCE_BYTES then
        return
    end
    while
        cachedSourceCount >= MAX_INDEX_SOURCE_ENTRIES
        or cachedSourceBytes + #source > MAX_INDEX_SOURCE_BYTES
    do
        if not evictOldestSource(entry) then
            return
        end
    end
    entry.source = source
    entry.lastSourceAccess = os.clock()
    cachedSourceBytes += #source
    cachedSourceCount += 1
end

local function updateIndexEntry(instance)
    local entry = scriptIndex[instance]
    if not entry then
        entry = { instance = instance }
        scriptIndex[instance] = entry
    end
    entry.name = instance.Name
    entry.className = instance.ClassName
    entry.path = getInstancePath(instance)
    entry.stateId = getInstanceStateId(instance)
    return entry
end

local function getIndexedSource(entry, allowDecompile)
    if entry.source then
        entry.lastSourceAccess = os.clock()
        return entry.source
    end
    if entry.sourceError then
        return nil, entry.sourceError
    end
    if not allowDecompile then
        return nil, "Source is not resident in the bounded cache"
    end

    local succeeded, source = pcall(decompile, entry.instance)
    if not succeeded or type(source) ~= "string" then
        entry.sourceError = tostring(source)
        return nil, entry.sourceError
    end
    entry.sourceSha256 = hashString(source)
    entry.clues = extractSourceClues(source)
    entry.sourceIndexed = true
    cacheIndexedSource(entry, source)
    return source
end

local function refreshScriptIndex(retryErrors, includeOtherPlayers)
    local present = {}
    local scripts, excludedOtherPlayerScripts = collectScripts("all", includeOtherPlayers)
    for _, instance in ipairs(scripts) do
        if not present[instance] then
            present[instance] = true
            local entry = updateIndexEntry(instance)
            if retryErrors then
                entry.sourceError = nil
            end
        end
    end
    for instance in next, scriptIndex do
        if not present[instance] then
            local entry = scriptIndex[instance]
            dropCachedSource(entry)
            scriptIndex[instance] = nil
        end
    end
    indexGeneration += 1
    lastIndexScan = os.clock()
    indexIncludesOtherPlayers = includeOtherPlayers == true
    indexExcludedOtherPlayerScripts = excludedOtherPlayerScripts
    indexDirty = false
end

local function ensureScriptIndex(forceScan, includeOtherPlayers)
    includeOtherPlayers = includeOtherPlayers == true
    if
        forceScan
        or indexDirty
        or includeOtherPlayers ~= indexIncludesOtherPlayers
        or os.clock() - lastIndexScan >= INDEX_REFRESH_SECONDS
    then
        refreshScriptIndex(forceScan, includeOtherPlayers)
    end
end

local function indexStats()
    local scripts = 0
    local sources = 0
    local residentSources = 0
    local errors = 0
    for _, entry in next, scriptIndex do
        scripts += 1
        if entry.sourceIndexed then
            sources += 1
        end
        if entry.source then
            residentSources += 1
        end
        if entry.sourceError then
            errors += 1
        end
    end
    return {
        generation = indexGeneration,
        scripts = scripts,
        sources = sources,
        residentSources = residentSources,
        residentSourceBytes = cachedSourceBytes,
        maxResidentSources = MAX_INDEX_SOURCE_ENTRIES,
        maxResidentSourceBytes = MAX_INDEX_SOURCE_BYTES,
        sourceMode = "explicit_read",
        backgroundDecompile = false,
        decompileErrors = errors,
        includeOtherPlayers = indexIncludesOtherPlayers,
        excludedOtherPlayerScripts = indexExcludedOtherPlayerScripts,
        scannedAt = os.time(),
        dirty = indexDirty,
    }
end

local STOP_WORDS = {
    a = true,
    an = true,
    ["and"] = true,
    code = true,
    find = true,
    ["for"] = true,
    ["in"] = true,
    of = true,
    ["or"] = true,
    script = true,
    search = true,
    that = true,
    the = true,
    to = true,
    with = true,
}

local BEHAVIOR_ALIASES = {
    animation = { "animator", "loadanimation", "animationtrack", "play" },
    camera = { "currentcamera", "cameratype", "camerasubject", "fieldofview", "cframe" },
    input = { "userinputservice", "contextactionservice", "inputbegan", "inputchanged" },
    jump = { "jumprequest", "jumpheight", "jumppower", "humanoid" },
    keyboard = { "keycode", "iskeydown", "inputbegan", "contextactionservice" },
    mouse = { "getmousedelta", "mousebehavior", "mouseiconenabled", "inputchanged" },
    movement = { "movedirection", "walkspeed", "humanoid", "move" },
    network = { "fireserver", "invokeserver", "onclientevent", "remoteevent", "remotefunction" },
    obstruction = { "raycast", "raycastparams", "getpartboundsinbox", "getpartsobscuringtarget" },
    occlusion = { "raycast", "raycastparams", "getpartsobscuringtarget", "localtransparencymodifier" },
    remote = { "fireserver", "invokeserver", "onclientevent", "remoteevent", "remotefunction" },
    render = { "renderstepped", "bindtorenderstep", "heartbeat", "prerender" },
    smooth = { "lerp", "smoothdamp", "tweenservice", "spring" },
    smoothing = { "lerp", "smoothdamp", "tweenservice", "spring" },
    touch = { "touchenabled", "touchmoved", "touchpan", "inputchanged" },
    vehicle = { "vehicleseat", "throttle", "steer", "occupant" },
}

local function tokenizeQuery(query)
    local terms = {}
    local seen = {}
    for term in string.lower(query):gmatch("[%w_]+") do
        if not STOP_WORDS[term] and not seen[term] then
            seen[term] = true
            table.insert(terms, term)
        end
    end
    if #terms == 0 then
        local fallback = string.lower(query):match("^%s*(.-)%s*$")
        if fallback ~= "" then
            table.insert(terms, fallback)
        end
    end
    return terms
end

local function expandQueryTerms(terms)
    local expanded = {}
    local mappings = {}
    local seen = {}
    for _, term in ipairs(terms) do
        local aliases = BEHAVIOR_ALIASES[term]
        if aliases then
            table.insert(mappings, { term = term, aliases = aliases })
            for _, alias in ipairs(aliases) do
                if not seen[alias] then
                    seen[alias] = true
                    table.insert(expanded, alias)
                end
            end
        end
    end
    return expanded, mappings
end

local function countOccurrences(source, term)
    local count = 0
    local position = 1
    while count < 20 do
        local first, last = string.find(source, term, position, true)
        if not first then
            break
        end
        count += 1
        position = last + 1
    end
    return count
end

local function makeSnippets(lines, terms, contextLines, maxSnippets)
    local snippets = {}
    local coveredUntil = 0
    for lineNumber, line in ipairs(lines) do
        local lowerLine = string.lower(line)
        local matched = false
        for _, term in ipairs(terms) do
            if string.find(lowerLine, term, 1, true) then
                matched = true
                break
            end
        end
        if matched and lineNumber > coveredUntil then
            local startLine = math.max(1, lineNumber - contextLines)
            local endLine = math.min(#lines, lineNumber + contextLines)
            local numbered = {}
            for index = startLine, endLine do
                table.insert(numbered, ("%d: %s"):format(index, lines[index]))
            end
            table.insert(snippets, {
                startLine = startLine,
                endLine = endLine,
                text = table.concat(numbered, "\n"),
            })
            coveredUntil = endLine
            if #snippets >= maxSnippets then
                break
            end
        end
    end
    return snippets
end

local function scoreEntry(entry, source, terms, expandedTerms, exactQuery)
    local lowerPath = string.lower(entry.path)
    local lowerSource = string.lower(source or "")
    local clues = entry.clues or { sourceStrings = {}, sourceNumbers = {}, apiMembers = {} }
    local lowerConstants = string.lower(table.concat(clues.sourceStrings, "\n"))
    local lowerApiMembers = string.lower(table.concat(clues.apiMembers, "\n"))
    local pathMatches = {}
    local sourceMatches = {}
    local constantMatches = {}
    local apiMatches = {}
    local expandedMatches = {}
    local score = 0
    local matchedTermCount = 0
    local expandedMatchCount = 0
    for _, term in ipairs(terms) do
        local pathMatch = string.find(lowerPath, term, 1, true) ~= nil
        local occurrences = countOccurrences(lowerSource, term)
        local constantMatch = string.find(lowerConstants, term, 1, true) ~= nil
        local apiMatch = string.find(lowerApiMembers, term, 1, true) ~= nil
        if pathMatch then
            table.insert(pathMatches, term)
            score += 100
        end
        if occurrences > 0 then
            table.insert(sourceMatches, term)
            score += 10 + occurrences
        end
        if constantMatch then
            table.insert(constantMatches, term)
            score += 30
        end
        if apiMatch then
            table.insert(apiMatches, term)
            score += 50
        end
        if pathMatch or occurrences > 0 or constantMatch or apiMatch then
            matchedTermCount += 1
        end
    end
    for _, term in ipairs(expandedTerms) do
        local apiMatch = string.find(lowerApiMembers, term, 1, true) ~= nil
        local sourceMatch = string.find(lowerSource, term, 1, true) ~= nil
        if apiMatch or sourceMatch then
            table.insert(expandedMatches, term)
            score += apiMatch and 12 or 4
            expandedMatchCount += 1
        end
    end
    if matchedTermCount == 0 and expandedMatchCount == 0 then
        return nil
    end
    if matchedTermCount == #terms then
        score += 250
    end
    if string.find(lowerPath, exactQuery, 1, true) then
        score += 500
    end
    if string.find(lowerSource, exactQuery, 1, true) then
        score += 100
    end
    return score, {
        path = pathMatches,
        source = sourceMatches,
        sourceStrings = constantMatches,
        apiMembers = apiMatches,
        expanded = expandedMatches,
    }
end

local function isPrimitive(value)
    local valueType = type(value)
    return valueType == "boolean" or valueType == "number" or valueType == "string"
end

local function samePrimitive(left, right)
    return type(left) == type(right) and left == right
end

local function debugMetadata(subject)
    local succeeded, info = pcall(debug.getinfo, subject)
    if not succeeded or type(info) ~= "table" then
        error("Could not inspect closure metadata: " .. tostring(info))
    end
    return {
        name = info.name or "",
        source = info.source or "",
        shortSource = info.short_src or "",
        what = info.what or "",
        currentLine = info.currentline,
        lineDefined = info.linedefined,
        lastLineDefined = info.lastlinedefined,
        parameterCount = info.numparams,
        upvalueCount = info.nups,
        isVararg = info.is_vararg == true or info.is_vararg == 1,
    }
end

local function getRuntimeClosureId(closure)
    local closureId = runtimeClosureIds[closure]
    if not closureId then
        closureId = HttpService:GenerateGUID(false)
        runtimeClosureIds[closure] = closureId
        runtimeClosures[closureId] = closure
    end
    return closureId
end

local function closureBelongsToScript(closure, instance)
    local succeeded, closureEnvironment = pcall(getfenv, closure)
    return succeeded
        and type(closureEnvironment) == "table"
        and rawget(closureEnvironment, "script") == instance
end

local function summarizeRuntimeClosure(closure)
    local constantsSucceeded, constants = pcall(debug.getconstants, closure)
    local protosSucceeded, protos = pcall(debug.getprotos, closure)
    local constantPreview = {}
    if constantsSucceeded and type(constants) == "table" then
        for index = 1, math.min(#constants, 12) do
            local valueSucceeded, value = pcall(debug.getconstant, closure, index)
            if valueSucceeded and isPrimitive(value) then
                table.insert(constantPreview, { index = index, kind = type(value), value = value })
            end
        end
    end
    local upvaluePreview = {}
    local info = debugMetadata(closure)
    local upvalueCount = tonumber(info.upvalueCount) or 0
    for index = 1, math.min(upvalueCount, 12) do
        local valueSucceeded, value = pcall(debug.getupvalue, closure, index)
        if valueSucceeded then
            table.insert(upvaluePreview, {
                index = index,
                kind = type(value),
                value = serialize(value, 0, {}),
            })
        end
    end
    return {
        closureId = getRuntimeClosureId(closure),
        functionLocation = {
            source = info.source,
            shortSource = info.shortSource,
            currentLine = info.currentLine,
            lineDefined = info.lineDefined,
            lastLineDefined = info.lastLineDefined,
        },
        info = info,
        constantCount = constantsSucceeded and #constants or nil,
        upvalueCount = upvalueCount,
        prototypeCount = protosSucceeded and #protos or nil,
        primitiveConstantPreview = constantPreview,
        positionalUpvaluePreview = upvaluePreview,
    }
end

local function collectBytecodeConstants(entry)
    if entry.bytecodeCluesAttempted then
        return entry.bytecodeConstants
    end
    entry.bytecodeCluesAttempted = true
    local strings = {}
    local numbers = {}
    local seenStrings = {}
    local seenNumbers = {}
    local closureSucceeded, closure = pcall(getscriptclosure, entry.instance)
    if closureSucceeded and type(closure) == "function" then
        local pending = { closure }
        local visited = 0
        while #pending > 0 and visited < 200 and (#strings < 32 or #numbers < 24) do
            local subject = table.remove(pending)
            visited += 1
            local constantsSucceeded, constants = pcall(debug.getconstants, subject)
            if constantsSucceeded and type(constants) == "table" then
                for index = 1, #constants do
                    local valueSucceeded, value = pcall(debug.getconstant, subject, index)
                    if valueSucceeded then
                        if type(value) == "string" then
                            appendUnique(strings, seenStrings, value, 32)
                        elseif type(value) == "number" then
                            appendUnique(numbers, seenNumbers, value, 24)
                        end
                    end
                end
            end
            local protosSucceeded, protos = pcall(debug.getprotos, subject)
            if protosSucceeded and type(protos) == "table" then
                for _, proto in ipairs(protos) do
                    table.insert(pending, proto)
                end
            end
        end
    end
    entry.bytecodeConstants = {
        strings = strings,
        numbers = numbers,
    }
    return entry.bytecodeConstants
end

local function describeEntryClues(entry, includeBytecodeConstants)
    local clues = entry.clues
        or {
            sourceStrings = {},
            sourceNumbers = {},
            apiMembers = {},
        }
    return {
        sourceStrings = clues.sourceStrings,
        sourceNumbers = clues.sourceNumbers,
        apiMembers = clues.apiMembers,
        bytecodeConstants = includeBytecodeConstants and collectBytecodeConstants(entry) or nil,
    }
end

local function describeScript(instance)
    local entry = updateIndexEntry(instance)
    return {
        name = entry.name,
        className = entry.className,
        path = entry.path,
        identity = describeEntryIdentity(entry),
        clues = describeEntryClues(entry, true),
    }
end

local function previewPrimitiveConstants(subject, limit)
    local preview = {}
    local succeeded, constants = pcall(debug.getconstants, subject)
    if succeeded and type(constants) == "table" then
        for index = 1, math.min(#constants, limit) do
            local valueSucceeded, value = pcall(debug.getconstant, subject, index)
            if valueSucceeded and isPrimitive(value) then
                table.insert(preview, {
                    index = index,
                    kind = type(value),
                    value = value,
                })
            end
        end
    end
    return preview
end

local function collectRuntimeClosures(instance)
    local summaries = {}
    local succeeded, values = pcall(getgc)
    if not succeeded or type(values) ~= "table" then
        return summaries
    end
    for _, value in pairs(values) do
        local lClosureSucceeded, lClosure = pcall(islclosure, value)
        if
            type(value) == "function"
            and lClosureSucceeded
            and lClosure
            and closureBelongsToScript(value, instance)
        then
            local summarySucceeded, summary = pcall(summarizeRuntimeClosure, value)
            if summarySucceeded then
                table.insert(summaries, summary)
                if #summaries >= MAX_RUNTIME_CLOSURES then
                    break
                end
            end
        end
    end
    table.sort(summaries, function(left, right)
        local leftName = string.lower(left.info.name)
        local rightName = string.lower(right.info.name)
        if leftName == rightName then
            return left.closureId < right.closureId
        end
        return leftName < rightName
    end)
    return summaries
end

local function resolveClosure(params, allowMissingScriptClosure)
    local target = resolveTarget(params.target)
    local instance, resolveError = resolvePath(params.path)
    if not instance then
        error(resolveError)
    end
    if not instance:IsA("LuaSourceContainer") then
        error(("Path resolves to %s, not a script"):format(instance.ClassName))
    end
    ensureTargetOwnsScript(target, instance)

    local closure
    local sourceKind
    local closureId = params.closureId
    if closureId then
        closure = runtimeClosures[closureId]
        if type(closure) ~= "function" then
            error("Runtime closure ID is unknown or no longer live; inspect the script again")
        end
        if not closureBelongsToScript(closure, instance) then
            error("Runtime closure ID belongs to a different script")
        end
        sourceKind = "runtime"
    else
        closure = scriptClosures[instance]
        if not closure then
            local succeeded, result = pcall(getscriptclosure, instance)
            if not succeeded or type(result) ~= "function" then
                if allowMissingScriptClosure then
                    return
                        target,
                        instance,
                        nil,
                        nil,
                        params.prototypePath or {},
                        "script",
                        nil,
                        tostring(result)
                end
                error("Could not get the script closure: " .. tostring(result))
            end
            closure = result
            scriptClosures[instance] = closure
        end
        sourceKind = "script"
    end

    local subject = closure
    local prototypePath = params.prototypePath or {}
    for depth, index in ipairs(prototypePath) do
        local protoSucceeded, proto = pcall(debug.getproto, subject, index)
        if not protoSucceeded then
            error(
                ("Could not resolve prototype index %d at depth %d: %s"):format(
                    index,
                    depth,
                    tostring(proto)
                )
            )
        end
        subject = proto
    end
    return target, instance, closure, subject, prototypePath, sourceKind, closureId, nil
end

local function getMutationValue(record)
    if record.kind == "constant" then
        return debug.getconstant(record.subject, record.index)
    end
    return debug.getupvalue(record.subject, record.index)
end

local function setMutationValue(record, value)
    if record.kind == "constant" then
        debug.setconstant(record.subject, record.index, value)
    else
        debug.setupvalue(record.subject, record.index, value)
    end
end

local handlers = {}

function handlers.status()
    local player = Players.LocalPlayer
    return {
        placeId = game.PlaceId,
        jobId = game.JobId,
        playerName = player and player.Name or "",
        userId = player and player.UserId or 0,
    }
end

function handlers.listTargets()
    local gameTarget = resolveTarget({ kind = "game" })
    local targets = {
        {
            selector = gameTarget.selector,
            stateId = gameTarget.stateId,
            isActorState = false,
            actors = {},
        },
    }
    local seenStates = { [gameTarget.stateId] = true }
    local succeeded, states = pcall(getactorstates)
    if succeeded and type(states) == "table" then
        for _, state in ipairs(states) do
            local stateId = getStateId(state)
            if stateId and not seenStates[stateId] then
                seenStates[stateId] = true
                local actorPaths = {}
                local actorsSucceeded, actors = pcall(state.GetActors, state)
                if actorsSucceeded and type(actors) == "table" then
                    for _, actor in ipairs(actors) do
                        if typeof(actor) == "Instance" then
                            table.insert(actorPaths, getInstancePath(actor))
                        end
                    end
                end
                table.sort(actorPaths)
                table.insert(targets, {
                    selector = { kind = "state", id = stateId },
                    stateId = stateId,
                    isActorState = true,
                    actors = actorPaths,
                })
                for _, actorPath in ipairs(actorPaths) do
                    table.insert(targets, {
                        selector = { kind = "actor", path = actorPath },
                        stateId = stateId,
                        isActorState = true,
                        actors = { actorPath },
                    })
                end
            end
        end
    end
    return { targets = targets, total = #targets }
end

function handlers.listScripts(params)
    local includeOtherPlayers = params.includeOtherPlayers == true
    ensureScriptIndex(false, includeOtherPlayers)
    local target = resolveTarget(params.target)
    local scope = params.scope or "all"
    if scope ~= "all" and scope ~= "running" and scope ~= "loaded" and scope ~= "cached" then
        error("Invalid script scope")
    end

    local query = string.lower(params.query or "")
    local limit = math.clamp(tonumber(params.limit) or 200, 1, 1000)
    local matches = {}
    local scripts, excludedOtherPlayerScripts = collectScripts(scope, includeOtherPlayers)
    for _, instance in ipairs(scripts) do
        local entry = updateIndexEntry(instance)
        if
            (entry.stateId == target.stateId or (entry.stateId == nil and target.kind == "game"))
            and (query == "" or string.find(string.lower(entry.path), query, 1, true))
        then
            table.insert(matches, {
                name = entry.name,
                className = entry.className,
                path = entry.path,
            })
        end
    end
    table.sort(matches, function(left, right)
        return string.lower(left.path) < string.lower(right.path)
    end)

    local total = #matches
    while #matches > limit do
        table.remove(matches)
    end
    return {
        scripts = matches,
        total = total,
        returned = #matches,
        scope = scope,
        query = query,
        includeOtherPlayers = includeOtherPlayers,
        excludedOtherPlayerScripts = excludedOtherPlayerScripts,
        target = describeTarget(target),
    }
end

function handlers.searchScripts(params)
    local includeOtherPlayers = params.includeOtherPlayers == true
    ensureScriptIndex(params.refresh == true, includeOtherPlayers)
    local target = resolveTarget(params.target)
    local scope = params.scope or "all"
    if scope ~= "all" and scope ~= "running" and scope ~= "loaded" and scope ~= "cached" then
        error("Invalid script scope")
    end

    local query = tostring(params.query or "")
    local exactQuery = string.lower(query):match("^%s*(.-)%s*$")
    local terms = tokenizeQuery(query)
    local expandedTerms, queryExpansion = expandQueryTerms(terms)
    local snippetTerms = table.clone(terms)
    for _, term in ipairs(expandedTerms) do
        table.insert(snippetTerms, term)
    end
    if #terms == 0 then
        error("Search query must contain text")
    end
    local limit = math.clamp(tonumber(params.limit) or 20, 1, 100)
    local contextLines = math.clamp(tonumber(params.contextLines) or 2, 0, 10)
    local maxSnippets = math.clamp(tonumber(params.maxSnippets) or 3, 1, 10)
    local matches = {}

    local scripts, excludedOtherPlayerScripts = collectScripts(scope, includeOtherPlayers)
    for _, instance in ipairs(scripts) do
        local entry = updateIndexEntry(instance)
        if entry.stateId == target.stateId or (entry.stateId == nil and target.kind == "game") then
            local source = getIndexedSource(entry, false)
            local score, matchedTerms =
                scoreEntry(entry, source, terms, expandedTerms, exactQuery)
            if score then
                table.insert(matches, {
                    name = entry.name,
                    className = entry.className,
                    path = entry.path,
                    score = score,
                    matchedTerms = matchedTerms,
                    clues = describeEntryClues(entry, false),
                    _entry = entry,
                    snippets = source
                            and makeSnippets(
                                splitLines(source),
                                snippetTerms,
                                contextLines,
                                maxSnippets
                            )
                        or {},
                    decompileError = entry.sourceError,
                })
            end
        end
    end

    table.sort(matches, function(left, right)
        if left.score == right.score then
            return string.lower(left.path) < string.lower(right.path)
        end
        return left.score > right.score
    end)
    local total = #matches
    while #matches > limit do
        table.remove(matches)
    end
    for index, match in ipairs(matches) do
        local includeBytecode = index <= MAX_SEARCH_BYTECODE_ENRICHMENTS
        match.identity = describeEntryIdentity(match._entry, includeBytecode)
        if includeBytecode then
            match.clues.bytecodeConstants = collectBytecodeConstants(match._entry)
        end
        match._entry = nil
    end
    return {
        query = query,
        terms = terms,
        queryExpansion = queryExpansion,
        scope = scope,
        target = describeTarget(target),
        matches = matches,
        total = total,
        returned = #matches,
        includeOtherPlayers = includeOtherPlayers,
        excludedOtherPlayerScripts = excludedOtherPlayerScripts,
        index = indexStats(),
    }
end

function handlers.readScript(params)
    ensureScriptIndex(false)
    local target = resolveTarget(params.target)
    local instance, resolveError = resolvePath(params.path)
    if not instance then
        error(resolveError)
    end
    if not instance:IsA("LuaSourceContainer") then
        error(("Path resolves to %s, not a script"):format(instance.ClassName))
    end
    ensureTargetOwnsScript(target, instance)

    local entry = updateIndexEntry(instance)
    local source, sourceError = getIndexedSource(entry, true)
    if not source then
        error("Could not decompile script: " .. tostring(sourceError))
    end

    local lines = splitLines(source)
    local startLine = math.clamp(tonumber(params.startLine) or 1, 1, math.max(#lines, 1))
    local lineCount = math.clamp(tonumber(params.lineCount) or 1000, 1, 5000)
    local endLine = math.min(startLine + lineCount - 1, #lines)
    local page = {}
    for index = startLine, endLine do
        table.insert(page, lines[index])
    end

    return {
        path = getInstancePath(instance),
        className = instance.ClassName,
        identity = describeEntryIdentity(entry),
        clues = describeEntryClues(entry, true),
        source = table.concat(page, "\n"),
        startLine = startLine,
        endLine = endLine,
        totalLines = #lines,
        truncated = endLine < #lines,
        target = describeTarget(target),
    }
end

function handlers.inspectClosure(params)
    local target, instance, _closure, subject, prototypePath, sourceKind, closureId, closureError =
        resolveClosure(params, true)
    local runtimeClosureSummaries = closureId and {} or collectRuntimeClosures(instance)
    local scriptDescription = describeScript(instance)
    if not subject then
        return {
            target = describeTarget(target),
            script = scriptDescription,
            closure = { sourceKind = sourceKind, error = closureError },
            runtimeClosures = runtimeClosureSummaries,
        }
    end
    local metadata = debugMetadata(subject)

    local constantsSucceeded, constantValues = pcall(debug.getconstants, subject)
    if not constantsSucceeded or type(constantValues) ~= "table" then
        error("Could not inspect constants: " .. tostring(constantValues))
    end
    local constants = {}
    local constantCount = #constantValues
    for index = 1, math.min(constantCount, MAX_CONSTANTS) do
        local succeeded, value = pcall(debug.getconstant, subject, index)
        if succeeded then
            table.insert(constants, {
                index = index,
                kind = type(value),
                value = serialize(value, 0, {}),
            })
        end
    end

    local upvalues = {}
    local upvaluesAvailable = type(subject) == "function"
    local upvalueCount = tonumber(metadata.upvalueCount) or 0
    if upvaluesAvailable then
        for index = 1, math.min(upvalueCount, MAX_UPVALUES) do
        local succeeded, value = pcall(debug.getupvalue, subject, index)
        if succeeded then
            table.insert(upvalues, {
                index = index,
                kind = type(value),
                value = serialize(value, 0, {}),
            })
        end
        end
    end

    local protosSucceeded, protoValues = pcall(debug.getprotos, subject)
    if not protosSucceeded or type(protoValues) ~= "table" then
        error("Could not inspect nested prototypes: " .. tostring(protoValues))
    end
    local prototypes = {}
    local prototypeCount = #protoValues
    for index = 1, math.min(prototypeCount, MAX_PROTOTYPES) do
        local proto = protoValues[index]
        local protoConstantsSucceeded, protoConstants = pcall(debug.getconstants, proto)
        local protoChildrenSucceeded, protoChildren = pcall(debug.getprotos, proto)
        local protoInfo = debugMetadata(proto)
        table.insert(prototypes, {
            index = index,
            functionLocation = {
                source = protoInfo.source,
                shortSource = protoInfo.shortSource,
                currentLine = protoInfo.currentLine,
                lineDefined = protoInfo.lineDefined,
                lastLineDefined = protoInfo.lastLineDefined,
            },
            info = protoInfo,
            constantCount = protoConstantsSucceeded and #protoConstants or nil,
            prototypeCount = protoChildrenSucceeded and #protoChildren or nil,
            primitiveConstantPreview = previewPrimitiveConstants(proto, 12),
        })
    end

    local functionLocation = {
        source = metadata.source,
        shortSource = metadata.shortSource,
        currentLine = metadata.currentLine,
        lineDefined = metadata.lineDefined,
        lastLineDefined = metadata.lastLineDefined,
    }
    return {
        target = describeTarget(target),
        script = scriptDescription,
        closure = {
            closureId = closureId,
            prototypePath = prototypePath,
            sourceKind = sourceKind,
            subjectType = type(subject) == "function" and "closure" or "prototype",
            identity = {
                scriptBytecodeSha256 = scriptDescription.identity.bytecodeSha256,
                closureId = closureId,
                prototypePath = prototypePath,
                functionLocation = functionLocation,
            },
            functionLocation = functionLocation,
            info = metadata,
            constants = constants,
            constantCount = constantCount,
            constantsTruncated = constantCount > #constants,
            upvalues = upvalues,
            upvalueCount = upvalueCount,
            upvaluesAvailable = upvaluesAvailable,
            prototypes = prototypes,
            prototypeCount = prototypeCount,
            prototypesTruncated = prototypeCount > #prototypes,
        },
        runtimeClosures = runtimeClosureSummaries,
    }
end

function handlers.mutateClosure(params)
    local mutationCount = 0
    for _ in next, mutations do
        mutationCount += 1
    end
    if mutationCount >= MAX_MUTATIONS then
        error("Restore an existing mutation before creating another")
    end

    if not params.closureId then
        error("Mutation requires a runtime closure ID from roblox_inspect_closure")
    end
    local target, instance, _closure, subject, prototypePath, _sourceKind, closureId =
        resolveClosure(params)
    local kind = params.kind
    if kind ~= "constant" and kind ~= "upvalue" then
        error("Mutation kind must be constant or upvalue")
    end
    if kind == "upvalue" and type(subject) ~= "function" then
        error("Inactive nested prototypes do not expose upvalue values")
    end

    local index = tonumber(params.index)
    if not index or index < 1 or index % 1 ~= 0 then
        error("Mutation index must be a positive integer")
    end
    local record = {
        kind = kind,
        subject = subject,
        index = index,
    }
    local currentSucceeded, current = pcall(getMutationValue, record)
    if not currentSucceeded then
        error("Could not read the selected value: " .. tostring(current))
    end
    if not isPrimitive(current) then
        error("Only primitive boolean, number, and string values can be mutated")
    end
    if not samePrimitive(current, params.expected) then
        error(
            ("Current value %s (%s) does not match expected %s (%s)"):format(
                tostring(current),
                type(current),
                tostring(params.expected),
                type(params.expected)
            )
        )
    end
    if type(params.value) ~= type(current) then
        error("Replacement value must have the same primitive type as the current value")
    end

    record.original = current
    record.mutated = params.value
    local setSucceeded, setError = pcall(setMutationValue, record, params.value)
    if not setSucceeded then
        error("Could not mutate the selected value: " .. tostring(setError))
    end
    local verifySucceeded, after = pcall(getMutationValue, record)
    if not verifySucceeded or not samePrimitive(after, params.value) then
        pcall(setMutationValue, record, current)
        error("Mutation did not verify and was rolled back")
    end

    local mutationId = HttpService:GenerateGUID(false)
    record.targetStateId = target.stateId
    record.targetSelector = target.selector
    record.path = getInstancePath(instance)
    record.scriptIdentity = describeScript(instance).identity
    record.prototypePath = prototypePath
    record.closureId = closureId
    mutations[mutationId] = record
    return {
        mutationId = mutationId,
        target = describeTarget(target),
        path = record.path,
        scriptIdentity = record.scriptIdentity,
        closureId = closureId,
        prototypePath = prototypePath,
        kind = kind,
        index = index,
        slot = { kind = kind, index = index },
        before = current,
        after = after,
        verified = true,
    }
end

function handlers.restoreMutation(params)
    local record = mutations[params.mutationId]
    if not record then
        error("Unknown or already restored mutation ID")
    end
    local target = resolveTarget(params.target)
    if target.stateId ~= record.targetStateId then
        error("Mutation belongs to a different Lua-state target")
    end

    local currentSucceeded, current = pcall(getMutationValue, record)
    if not currentSucceeded then
        error("Could not read the mutated value: " .. tostring(current))
    end
    if not samePrimitive(current, record.mutated) then
        error("Live value changed after the mutation; refusing to overwrite it")
    end
    local restoreSucceeded, restoreError = pcall(setMutationValue, record, record.original)
    if not restoreSucceeded then
        error("Could not restore the original value: " .. tostring(restoreError))
    end
    local verifySucceeded, restored = pcall(getMutationValue, record)
    if not verifySucceeded or not samePrimitive(restored, record.original) then
        error("Original value was written but could not be verified")
    end

    mutations[params.mutationId] = nil
    return {
        mutationId = params.mutationId,
        target = describeTarget(target),
        path = record.path,
        scriptIdentity = record.scriptIdentity,
        closureId = record.closureId,
        prototypePath = record.prototypePath,
        kind = record.kind,
        index = record.index,
        slot = { kind = record.kind, index = record.index },
        before = current,
        after = restored,
        verified = true,
    }
end

local ACTOR_EVAL_SOURCE = [[
local channelId, code, chunkName = ...
local channel = get_comm_channel(channelId)
local chunk, compileError = loadstring(code, chunkName)
if not chunk then
    channel:Fire({ false, tostring(compileError), n = 2 })
    return
end
channel:Fire(table.pack(pcall(chunk)))
]]

function handlers.eval(params)
    local target = resolveTarget(params.target)
    if target.kind ~= "game" then
        local channelId, channel = create_comm_channel()
        local response
        local waiting = false
        local completed = Instance.new("BindableEvent")
        local connection = channel.Event:Connect(function(results)
            if response then
                return
            end
            response = results
            if waiting then
                completed:Fire()
            end
        end)
        task.delay(30, function()
            if response then
                return
            end
            response = { false, "Actor evaluation timed out", n = 2 }
            if waiting then
                completed:Fire()
            end
        end)
        local executed, executeError = pcall(
            target.state.Execute,
            target.state,
            ACTOR_EVAL_SOURCE,
            channelId,
            params.code,
            params.chunkName or "Volt MCP"
        )
        if not executed then
            response = { false, tostring(executeError), n = 2 }
        end
        if not response then
            waiting = true
            completed.Event:Wait()
        end
        connection:Disconnect()
        completed:Destroy()
        if type(response) ~= "table" or type(response.n) ~= "number" then
            error("Actor evaluation returned an invalid response")
        end
        if not response[1] then
            error(response[2])
        end
        local values = {}
        for index = 2, response.n do
            table.insert(values, serialize(response[index], 0, {}))
        end
        return {
            target = describeTarget(target),
            values = values,
            count = response.n - 1,
        }
    end

    local chunk, compileError = loadstring(params.code, params.chunkName or "Volt MCP")
    if not chunk then
        error(compileError)
    end

    local results = table.pack(pcall(chunk))
    if not results[1] then
        error(results[2])
    end
    local values = {}
    for index = 2, results.n do
        table.insert(values, serialize(results[index], 0, {}))
    end
    return { target = describeTarget(target), values = values, count = results.n - 1 }
end

local stopped = false
local socket
local inFlight = 0
local reconnectScheduled = false
local activePairing

local function startIndexMaintenance()
    descendantAddedConnection = game.DescendantAdded:Connect(function(instance)
        if instance:IsA("LuaSourceContainer") or instance:IsA("Actor") then
            indexDirty = true
        end
    end)
    descendantRemovingConnection = game.DescendantRemoving:Connect(function(instance)
        if instance:IsA("LuaSourceContainer") or instance:IsA("Actor") then
            indexDirty = true
        end
    end)
    pcall(function()
        actorStateConnection = on_actor_state_created:Connect(function()
            indexDirty = true
        end)
    end)
end

local function send(payload)
    if socket and not socket.IsClosed then
        socket:Send(HttpService:JSONEncode(payload))
    end
end

local function invalidatePairing()
    if activePairing then
        activePairing.valid = false
        activePairing = nil
    end
end

local function showPairingPrompt(connection, challenge)
    invalidatePairing()
    local parsedExpiry, expiry = pcall(DateTime.fromIsoDate, challenge.expiresAt)
    if
        not parsedExpiry
        or not expiry
        or expiry.UnixTimestampMillis <= DateTime.now().UnixTimestampMillis
    then
        send({
            type = "pair_decision",
            challengeId = challenge.challengeId,
            approved = false,
        })
        return
    end

    local pairing = {
        challengeId = challenge.challengeId,
        connection = connection,
        expiresAt = expiry.UnixTimestampMillis,
        valid = true,
    }
    activePairing = pairing

    local remainingSeconds = math.max(
        0,
        (pairing.expiresAt - DateTime.now().UnixTimestampMillis) / 1000
    )
    task.delay(remainingSeconds, function()
        if activePairing == pairing then
            invalidatePairing()
        end
    end)

    task.spawn(function()
        local caption = "Volt MCP Pairing"
        local session = challenge.agent
        local daemon = challenge.daemon
        local body = "Volt MCP local daemon pairing request\n\n"
            .. "Daemon: "
            .. daemon.name
            .. "\nEndpoint: "
            .. daemon.endpoint
            .. "\n\nRoblox session:\nPlayer: "
            .. session.playerName
            .. " (User ID "
            .. tostring(session.userId)
            .. ")\nExperience ID: "
            .. tostring(session.gameId)
            .. "\nPlace ID: "
            .. tostring(session.placeId)
            .. "\nJob ID: "
            .. session.jobId
            .. "\n\nIf you choose Yes, MCP clients authorized to this local daemon can inspect live scripts and runtime state, and execute or modify client-side Luau.\n\n"
            .. "Yes stores a credential and reconnects future Volt sessions until pairing is reset.\n"
            .. "No stores nothing.\n\nVerification code: "
            .. challenge.code
            .. "\nThis code only correlates this dialog with the pending MCP challenge. It is not authorization or a credential.\n\n"
            .. "Choose Yes only if this code matches the MCP client. Choose No on any mismatch."
        local succeeded, result = false, nil
        if type(messagebox) == "function" then
            succeeded, result = pcall(messagebox, body, caption, 4 + 32)
        end
        local current =
            activePairing == pairing
            and pairing.valid
            and not stopped
            and socket == connection
            and not connection.IsClosed
            and DateTime.now().UnixTimestampMillis < pairing.expiresAt
        if not current then
            return
        end
        invalidatePairing()
        send({
            type = "pair_decision",
            challengeId = pairing.challengeId,
            approved = succeeded and result == 6,
        })
    end)
end

local function agentInfo()
    local player = Players.LocalPlayer
    return {
        agentVersion = "0.1.1",
        gameId = game.GameId,
        placeId = game.PlaceId,
        jobId = game.JobId,
        playerName = player and player.Name or "",
        userId = player and player.UserId or 0,
    }
end

local function respond(id, succeeded, value)
    if succeeded then
        local encoded, encodeError = pcall(HttpService.JSONEncode, HttpService, value)
        if not encoded then
            send({ type = "response", id = id, ok = false, error = tostring(encodeError) })
            return
        end
        send({ type = "response", id = id, ok = true, result = value })
    else
        send({
            type = "response",
            id = id,
            ok = false,
            error = tostring(value):sub(1, 4096),
        })
    end
end

local function handleMessage(connection, message, isBinary)
    if isBinary then
        return
    end
    local decoded, request = pcall(HttpService.JSONDecode, HttpService, message)
    if not decoded or type(request) ~= "table" then
        return
    end
    if request.type == "ready" then
        invalidatePairing()
        print("Volt MCP authentication successful")
        return
    end
    if request.type == "pair_challenge" then
        if
            type(request.challengeId) == "string"
            and type(request.code) == "string"
            and type(request.expiresAt) == "string"
            and type(request.agent) == "table"
            and type(request.agent.agentVersion) == "string"
            and type(request.agent.gameId) == "number"
            and type(request.agent.placeId) == "number"
            and type(request.agent.jobId) == "string"
            and type(request.agent.playerName) == "string"
            and type(request.agent.userId) == "number"
            and type(request.daemon) == "table"
            and type(request.daemon.name) == "string"
            and type(request.daemon.endpoint) == "string"
        then
            showPairingPrompt(connection, request)
        end
        return
    end
    if request.type == "pair_complete" then
        if type(request.token) ~= "string" or #request.token < 32 then
            return
        end
        local encoded = HttpService:JSONEncode({ version = 1, token = request.token })
        local persisted, persistError = pcall(function()
            writefile("volt-mcp/credential.json", encoded)
        end)
        if not persisted then
            warn("Volt MCP could not persist its pairing credential: " .. tostring(persistError))
            return
        end
        token = request.token
        invalidatePairing()
        send({ type = "hello", token = token, agent = agentInfo() })
        return
    end
    if request.type == "credential_rejected" then
        token = nil
        pcall(delfile, "volt-mcp/credential.json")
        invalidatePairing()
        return
    end
    if
        request.type == "pair_denied"
        or request.type == "pair_expired"
        or request.type == "pair_stale"
    then
        invalidatePairing()
        return
    end
    if request.type == "pair_unavailable" then
        invalidatePairing()
        warn("Volt MCP is paired to another credential; run setup reset-pairing to repair it")
        return
    end
    if request.type ~= "request" then
        return
    end
    if type(request.id) ~= "string" or type(request.method) ~= "string" then
        return
    end
    local handler = handlers[request.method]
    if not handler then
        respond(request.id, false, "Unknown method: " .. request.method)
        return
    end
    if inFlight >= 8 then
        respond(request.id, false, "Too many concurrent requests")
        return
    end

    inFlight += 1
    task.spawn(function()
        local succeeded, result = pcall(handler, request.params or {})
        inFlight -= 1
        respond(request.id, succeeded, result)
    end)
end

local connect
local function scheduleReconnect()
    if stopped or reconnectScheduled then
        return
    end
    reconnectScheduled = true
    task.delay(2, function()
        reconnectScheduled = false
        connect()
    end)
end

connect = function()
    if stopped then
        return
    end

    local connected, connection = pcall(WebSocket.connect, endpoint)
    if not connected then
        scheduleReconnect()
        return
    end

    socket = connection
    socket.OnMessage:Connect(function(message, isBinary)
        handleMessage(connection, message, isBinary)
    end)
    socket.OnClose:Connect(function()
        if stopped or socket ~= connection then
            return
        end
        invalidatePairing()
        connection:Close()
        socket = nil
        scheduleReconnect()
    end)

    if token then
        send({ type = "hello", token = token, agent = agentInfo() })
    else
        send({ type = "pair_request", agent = agentInfo() })
    end
end

local agent = {}

function agent.Stop()
    stopped = true
    invalidatePairing()
    if descendantAddedConnection then
        descendantAddedConnection:Disconnect()
        descendantAddedConnection = nil
    end
    if descendantRemovingConnection then
        descendantRemovingConnection:Disconnect()
        descendantRemovingConnection = nil
    end
    if actorStateConnection then
        actorStateConnection:Disconnect()
        actorStateConnection = nil
    end
    if socket then
        socket:Close()
        socket = nil
    end
end

environment.VoltMcpAgent = agent
startIndexMaintenance()
task.spawn(connect)
task.spawn(function()
    while not stopped do
        task.wait(2)
        if socket and socket.IsClosed then
            socket = nil
        end
        if not socket then
            scheduleReconnect()
        end
    end
end)
print("Volt MCP successfully loaded")
return agent
