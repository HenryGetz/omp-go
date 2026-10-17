// Plugin registration gating (src/register.ts).
//
// Registering a tool whose NAME matches an omp built-in REPLACES that built-in
// in the host registry, whether or not the wrapper is active. The five
// colliding harness wrappers were registered unconditionally at plugin setup,
// which deleted `read`/`write`/`edit`/`glob`/`grep` from every lane — the Go
// lane included. omp allocates its `xd://` tool-device layer only when the
// session holds a `write` tool:
//
//   xdevEnabled = xdevRequested && tools.some(t => t.name === "write")
//
// so losing `write` silently ships every MCP tool schema top-level on every
// request (measured: 159 top-level tools and 0 devices, vs 12 top-level tools
// and 78 devices once registration is gated correctly).
//
// Pinned here: colliding wrappers stay unregistered until a free-lane session
// actually needs them.

import assert from "node:assert/strict"
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"
import { registerOpencodeGo } from "../src/register"
import { COLLIDING_NAMES, HARNESS_ONLY_NAMES, type HarnessTool } from "../src/tool-mirror"

type AnyTool = { name: string; description?: string; defaultInactive?: boolean }
type Handler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>

const tools = new Map<string, AnyTool>()
const handlers = new Map<string, Handler[]>()
let active = ["read", "edit", "glob", "grep", "write", "bash", "todo", "task"]

const pi = {
  registerProvider: () => undefined,
  registerTool: (tool: AnyTool) => {
    tools.set(tool.name, tool)
  },
  getActiveTools: () => [...active],
  setActiveTools: (names: string[]) => {
    active = [...names]
  },
  on: (name: string, handler: Handler) => {
    const list = handlers.get(name)
    if (list) list.push(handler)
    else handlers.set(name, [handler])
  },
} as unknown as ExtensionAPI

registerOpencodeGo(pi)

const registeredColliding = (): string[] => COLLIDING_NAMES.filter(name => tools.has(name))
const fire = async (event: string, provider: string): Promise<void> => {
  for (const handler of handlers.get(event) ?? []) {
    await handler({}, { model: { provider } } as unknown as ExtensionContext)
  }
}

// --- 1. Plugin setup must not clobber the host's built-ins -------------------

assert.deepEqual(
  registeredColliding(),
  [],
  "setup must NOT register the colliding wrappers: a same-named registration replaces omp's real read/write/edit/glob/grep in every lane",
)

for (const name of HARNESS_ONLY_NAMES) {
  assert.ok(tools.has(name), `${name} (harness-only, no omp built-in) is inert and must register at setup`)
}

// --- 2. The Go lane must leave the built-ins and the xd:// layer alone -------

await fire("session_start", "opencode-go")
await fire("before_agent_start", "opencode-go")
assert.deepEqual(
  registeredColliding(),
  [],
  "a Go-lane session must never register the colliding wrappers",
)
assert.ok(active.includes("write"), "the Go lane keeps the built-in write tool, and with it xd:// device mounting")

// --- 3. The free lane still gets the full harness surface --------------------

await fire("session_start", "opencode-free")
await fire("before_agent_start", "opencode-free")
for (const name of COLLIDING_NAMES) {
  const tool = tools.get(name)
  assert.ok(tool, `${name} must be registered once the free lane needs it`)
  assert.equal(tool.defaultInactive, true, `${name} wrapper stays defaultInactive; activation owns the switch`)
}
for (const name of [...COLLIDING_NAMES, ...HARNESS_ONLY_NAMES]) {
  assert.ok(active.includes(name), `${name} must be active on the free lane`)
}
assert.ok(active.includes("bash"), "non-harness active tools survive the free-lane rebuild")

console.log("REGISTRATION-GATING OK: colliding wrappers register on the free lane only; built-ins survive everywhere else")
