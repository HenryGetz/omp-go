// Free-tier tool mirror (src/tool-mirror.ts).
//
// Two contracts are pinned here, without the network:
//   1. the asset capture/harness-tools.json is byte-identical to the harness's
//      own `tools` array in capture/golden-requests.ndjson — the gateway's
//      fingerprint check fails on any drift, so this comparison must be exact;
//   2. the free-lane payload rewrite, the harness→omp argument shim, and the
//      seven harness-only wrapper registrations behave as the runtime expects.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"
import {
  COLLIDING_NAMES,
  HARNESS_DEFINITIONS,
  HARNESS_ONLY_NAMES,
  HARNESS_TOOLS,
  HARNESS_TOOL_NAMES,
  activateHarnessTools,
  htmlToMarkdown,
  isHarnessOnlyName,
  isHarnessToolPayload,
  registerCollidingHarnessTools,
  registerHarnessTools,
  rewriteFreeLanePayload,
  toOmpParams,
  type HarnessTool,
} from "../src/tool-mirror"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// --- 1. Asset exactness vs the golden harness capture ------------------------

const GOLDEN = readFileSync(path.join(REPO, "capture", "golden-requests.ndjson"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { url: string; body: string })

const freeChat = GOLDEN.find((row) => row.url.includes("/inference/openai/") && row.url.endsWith("/chat/completions"))
assert.ok(freeChat, "golden capture must contain the free-tier chat request")

const goldenTools = (JSON.parse(freeChat.body) as { tools?: unknown }).tools
assert.ok(Array.isArray(goldenTools) && goldenTools.length === 12, "golden free chat must carry 12 tools")

assert.equal(HARNESS_TOOLS.length, 12, "asset must hold the 12 harness tools")
assert.deepEqual(
  [...HARNESS_TOOL_NAMES],
  ["edit", "glob", "grep", "question", "read", "shell", "skill", "subagent", "webfetch", "websearch", "write", "execute"],
  "asset tool order must match the harness wire order",
)

for (const [index, tool] of HARNESS_TOOLS.entries()) {
  // Byte-for-byte (JSON.stringify preserves key order): name, description,
  // parameters AND the explicit `strict: false` all feed the fingerprint.
  assert.equal(
    JSON.stringify(tool),
    JSON.stringify(goldenTools[index]),
    `asset tool ${index} (${tool.function.name}) must be byte-identical to the golden harness definition`,
  )
}

// The gate centers on the exact `shell` + `read` pair; pin them explicitly so a
// future asset edit that drops a description fails loudly here.
for (const name of ["shell", "read"]) {
  const definition = HARNESS_DEFINITIONS[name]
  assert.ok(definition, `${name} must be present in the asset`)
  assert.ok(definition.description.length > 40, `${name} description must not be stripped (fingerprint-checked)`)
  assert.match(JSON.stringify(definition.parameters), /"required"/, `${name} must declare required params`)
}

// --- 2. Request-side payload rewrite -----------------------------------------

const ompLikePayload = {
  model: "mimo-v2.6-flash-free",
  messages: [{ role: "user", content: "hi" }],
  tools: [
    { type: "function", function: { name: "read", description: "omp read", parameters: { type: "object", properties: { i: {}, path: {} }, required: ["path", "i"] } } },
    { type: "function", function: { name: "bash", description: "omp bash", parameters: { type: "object", properties: {} } } },
  ],
  stream: true,
}
assert.equal(isHarnessToolPayload(ompLikePayload), false, "omp-shaped payload is not yet the harness surface")

const rewritten = rewriteFreeLanePayload(ompLikePayload) as Record<string, unknown>
assert.equal(isHarnessToolPayload(rewritten), true, "rewrite must install the exact harness surface")
assert.deepEqual(rewritten.tools, [...HARNESS_TOOLS], "rewrite must install the asset definitions verbatim")
assert.equal(rewritten.model, "mimo-v2.6-flash-free", "rewrite must preserve every other field")
assert.deepEqual(rewritten.messages, ompLikePayload.messages, "rewrite must preserve messages")
assert.equal(Array.isArray(rewritten.tools) && (rewritten.tools as unknown[]).length, 12, "rewrite must drop omp duplicates")
const names = (rewritten.tools as HarnessTool[]).map((tool) => tool.function.name)
assert.ok(!names.includes("bash"), "rewrite must drop unknown-name omp tools for a harness-shaped set")

// Tool-less turns stay tool-less (a title/compaction call must not gain tools).
const toolLess = { model: "mimo-v2.6-flash-free", messages: [] }
assert.equal(rewriteFreeLanePayload(toolLess), toolLess, "a tool-less payload must be returned unchanged")

// --- 3. Argument shim --------------------------------------------------------

assert.deepEqual(
  toOmpParams("read", { path: "src/index.ts" }),
  { path: "src/index.ts" },
  "read: path-only harness call maps straight through",
)
assert.deepEqual(
  toOmpParams("read", { path: "src/index.ts", offset: 5, limit: 10 }),
  { path: "src/index.ts:5-14" },
  "read: harness offset/limit becomes an omp line selector",
)
assert.equal(
  toOmpParams("read", { path: "src/index.ts", i: "Reviewing entry" }),
  undefined,
  "read: an omp-shaped call (with `i`) is left untouched",
)
assert.deepEqual(
  toOmpParams("edit", { path: "a.ts", oldString: "x", newString: "y", replaceAll: true }),
  { path: "a.ts", old_string: "x", new_string: "y", replace_all: true },
  "edit: camelCase harness keys map to omp snake_case",
)
assert.deepEqual(
  toOmpParams("glob", { pattern: "**/*.ts", path: "src" }),
  { path: "src/**/*.ts" },
  "glob: harness pattern+path maps onto omp's path glob",
)
assert.deepEqual(
  toOmpParams("grep", { pattern: "a.b", literal: true, caseSensitive: false }),
  { pattern: "a\\.b", case: false },
  "grep: literal escapes regex metacharacters and caseSensitive maps to omp case",
)
assert.deepEqual(
  toOmpParams("write", { path: "a.ts", content: "hi" }),
  { path: "a.ts", content: "hi" },
  "write: identical keys",
)
assert.equal(toOmpParams("bash", { command: "ls" }), undefined, "unknown names are not translated")

// --- 4. Wrapper registration + activation ------------------------------------

type CapturedTool = ToolDefinition<Record<string, unknown>, unknown>

function fakePi(active: string[]) {
  const tools = new Map<string, CapturedTool>()
  let activeNow = [...active]
  const execCalls: Array<{ command: string; args: string[]; cwd?: string }> = []
  const pi = {
    registerTool: (tool: CapturedTool) => tools.set(tool.name, tool),
    getActiveTools: () => [...activeNow],
    setActiveTools: (updated: string[]) => {
      activeNow = [...updated]
    },
    exec: async (command: string, args: string[], options?: { cwd?: string }) => {
      execCalls.push({ command, args, cwd: options?.cwd })
      return { stdout: "hello from tool", stderr: "", code: 0, killed: false }
    },
  } as unknown as ExtensionAPI
  return { pi, tools, execCalls, active: () => activeNow }
}

const harness = fakePi(["read", "edit", "glob", "grep", "write", "bash"])
registerHarnessTools(harness.pi)
assert.deepEqual(
  [...harness.tools.keys()].toSorted(),
  [...HARNESS_ONLY_NAMES].toSorted(),
  "all seven harness-only wrappers register, and only those",
)
for (const name of HARNESS_ONLY_NAMES) {
  const tool = harness.tools.get(name)
  assert.ok(tool, `${name} wrapper must be registered`)
  const definition = HARNESS_DEFINITIONS[name]
  assert.equal(tool.description, definition.description, `${name} wrapper must carry the harness description verbatim`)
  assert.deepEqual(tool.parameters, definition.parameters, `${name} wrapper must carry the harness parameters verbatim`)
  assert.equal(tool.defaultInactive, true, `${name} wrapper must stay inactive by default (Go lane untouched)`)
}

// Activation is free-lane only.
await activateHarnessTools(harness.pi, "opencode-go")
assert.equal(harness.active().includes("shell"), false, "Go lane must not activate harness tools")
await activateHarnessTools(harness.pi, "opencode-free")
for (const name of HARNESS_ONLY_NAMES) assert.ok(harness.active().includes(name), `${name} must be active on the free lane`)
assert.ok(harness.active().includes("read"), "activation must preserve the existing built-in tool surface")

const empty = fakePi([])
assert.equal(await activateHarnessTools(empty.pi, "opencode-free"), false, "an empty active snapshot is never clobbered")

// Colliding-name wrappers re-register the omp built-ins with the harness schema
// and delegate to the native tool through `ctx.invokeTool`.
const colliding = fakePi(["read", "edit", "glob", "grep", "write"])
registerCollidingHarnessTools(colliding.pi)
assert.deepEqual(
  [...colliding.tools.keys()].toSorted(),
  [...COLLIDING_NAMES].toSorted(),
  "all five colliding wrappers register, and only those",
)
for (const name of COLLIDING_NAMES) {
  const tool = colliding.tools.get(name)
  assert.ok(tool, `${name} wrapper must be registered`)
  const definition = HARNESS_DEFINITIONS[name]
  assert.equal(tool.description, definition.description, `${name} wrapper must carry the harness description verbatim`)
  assert.deepEqual(tool.parameters, definition.parameters, `${name} wrapper must carry the harness parameters verbatim`)
}
const editWrapper = colliding.tools.get("edit")
assert.ok(editWrapper, "edit wrapper exists")
let delegated: Record<string, unknown> | undefined
const invokeCtx = {
  cwd: "/tmp",
  invokeTool: async (params: Record<string, unknown>) => {
    delegated = params
    return { content: [{ type: "text", text: "edited" }] }
  },
} as unknown as ExtensionContext
await editWrapper.execute(
  "call-2",
  { path: "a.ts", oldString: "x", newString: "y", replaceAll: true },
  undefined,
  undefined,
  invokeCtx,
)
assert.deepEqual(
  delegated,
  { path: "a.ts", old_string: "x", new_string: "y", replace_all: true },
  "edit wrapper must translate harness keys and delegate the omp shape to the native tool",
)

// The shell wrapper executes a real command through omp's exec primitive.
const shell = harness.tools.get("shell")
assert.ok(shell, "shell wrapper exists")
const ctx = { cwd: "/tmp" } as unknown as ExtensionContext
const result = await shell.execute("call-1", { command: "echo hi" }, undefined, undefined, ctx)
assert.equal(harness.execCalls.length, 1, "shell wrapper must run exactly one command")
assert.equal(harness.execCalls[0].command, "bash", "shell wrapper must use the shell executor")
assert.deepEqual(harness.execCalls[0].args, ["-c", "echo hi"], "shell wrapper must pass the command to bash -c")
assert.match(result.content[0] && "text" in result.content[0] ? result.content[0].text : "", /hello from tool/, "shell output must surface")

// --- 5. Helpers --------------------------------------------------------------

assert.equal(isHarnessOnlyName("shell"), true, "shell is a harness-only name")
assert.equal(isHarnessOnlyName("read"), false, "read is a colliding built-in, not a wrapper")
assert.match(
  htmlToMarkdown("<h1>Title</h1><p>See <a href=\"https://x.test\">link</a></p>"),
  /# Title[\s\S]*\[link\]\(https:\/\/x\.test\)/,
  "HTML→markdown extraction keeps headings and links",
)

console.log("TOOL-MIRROR OK: harness asset exact, payload rewrite + shims + wrappers verified")
