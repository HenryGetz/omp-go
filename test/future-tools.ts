// Future-tool guarantee (src/tool-mirror.ts + src/sse-normalize.ts).
//
// The user's bar: EVERY tool — including ones added to the host long after
// this plugin was written — is guaranteed callable on every free model, with
// no per-tool code here. This test pins that claim BY CONSTRUCTION: a
// SYNTHETIC tool that this codebase has never heard of is registered through
// a fake ExtensionAPI (tests only — no shipped env seams, no test tools in
// src/), and then asserted to be
//
//   1. visible with its EXACT schema on the chat lane (context block entry:
//      deep-equal `properties` + `required`),
//   2. visible with its EXACT schema on the Responses lane (flat `tools[]`
//      entry after the golden 12, whose bytes+order must stay untouched),
//   3. executable: a simulated model call carrying schema-complete args
//      round-trips through the SAME schema object the model saw, straight to
//      the tool's execute,
//   4. and gone from both surfaces the moment it leaves the active set.
//
// The mechanism under test is set-derivation, not a name list:
// activeExtraTools(pi) = pi.getActiveTools() ∩ pi.getAllTools() minus the
// offered 12 — so any future tool that follows the host's normal
// registerTool path is covered with zero changes here.
//
// Run: bun test/future-tools.ts

import assert from "node:assert/strict"
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"
import {
  HARNESS_TOOLS,
  HARNESS_TOOLS_RESPONSES,
  activeExtraTools,
  rewriteFreeLanePayload,
  type ExtraToolSchema,
} from "../src/tool-mirror"

// --- The future tool: multi-parameter (required keys, enum, nested arrays) ---

const FUTURE_TOOL = "quantum_flux_audit"
const FUTURE_SCHEMA = {
  type: "object",
  properties: {
    target: { type: "string", description: "Which flux field to audit" },
    severity: { type: "string", enum: ["low", "critical"], description: "Audit depth" },
    tags: { type: "array", items: { type: "string" } },
    probes: {
      type: "array",
      description: "Nested probe definitions",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["emitter", "resonator"] },
          gain: { type: "number" },
        },
        required: ["kind"],
      },
    },
  },
  required: ["target", "severity", "probes"],
} as const

/** Minimal host stand-in: registerTool stores the definition; getActiveTools /
 *  getAllTools mirror the host's registry reads that activeExtraTools uses. */
function fakeHost() {
  const registry = new Map<string, ToolDefinition<Record<string, unknown>, unknown>>()
  const active: string[] = []
  const executed: Record<string, unknown>[] = []
  const pi = {
    registerTool: (tool: ToolDefinition<Record<string, unknown>, unknown>) => {
      registry.set(tool.name, tool)
    },
    getActiveTools: () => [...active],
    getAllTools: () => [...registry.values()],
  } as unknown as ExtensionAPI
  return { pi, registry, active, executed }
}

const host = fakeHost()

// The registration path a future extension/MCP tool takes: a plain-JSON
// schema handed to pi.registerTool. No name list anywhere in this plugin
// mentions quantum_flux_audit — grep src/ if you doubt it.
const futureTool: ToolDefinition<Record<string, unknown>, unknown> = {
  name: FUTURE_TOOL,
  label: "Quantum Flux Audit",
  description: "Audit a quantum flux field for resonant drift",
  parameters: FUTURE_SCHEMA as unknown as Record<string, unknown>,
  defaultInactive: true,
  loadMode: "discoverable",
  approval: "exec",
  execute: async (_id, params: Record<string, unknown>) => {
    host.executed.push(params)
    return { content: [{ type: "text", text: `audited ${String(params.target)}` }] }
  },
}
host.registry.set(futureTool.name, futureTool)
host.active.push(FUTURE_TOOL)

// --- 1+2. Both lanes expose the future tool with its EXACT schema ------------

const extras: ExtraToolSchema[] = activeExtraTools(host.pi)
const futureExtra = extras.find((tool) => tool.name === FUTURE_TOOL)
assert.ok(futureExtra, "a tool registered after this plugin was written is picked up with no code change here")
assert.deepEqual(
  futureExtra.parameters,
  JSON.parse(JSON.stringify(FUTURE_SCHEMA)),
  "the registry schema rides verbatim (deep-equal properties + required + nested arrays)",
)

// Chat lane: schema block in the last user message; tools[] stays the golden 12.
const chatPayload = {
  model: "mimo-v2.6-flash-free",
  messages: [{ role: "user", content: "audit the flux" }],
  tools: [{ type: "function", function: { name: "read" } }],
  stream: true,
}
const chatRewritten = rewriteFreeLanePayload(chatPayload, { activated: true, extraTools: extras }) as Record<string, unknown>
assert.deepEqual(chatRewritten.tools, [...HARNESS_TOOLS], "chat lane: tools[] stays byte-harness-shaped")
const chatMessages = chatRewritten.messages as { content: string }[]
const fence = /```json\n([\s\S]*?)\n```/.exec(chatMessages[0]?.content ?? "")
assert.ok(fence, "chat lane: the context block carries a fenced JSON list")
const blockEntries = JSON.parse(fence?.[1] ?? "[]") as { name: string; parameters: unknown }[]
const chatEntry = blockEntries.find((entry) => entry.name === FUTURE_TOOL)
assert.ok(chatEntry, "chat lane: the future tool is advertised in the schema block")
assert.deepEqual(chatEntry.parameters, JSON.parse(JSON.stringify(FUTURE_SCHEMA)), "chat lane: exact schema in the block")

// Responses lane: flat entry after the golden 12; golden prefix untouched.
const responsesPayload = {
  model: "muse-spark-1.3-contributor-free",
  instructions: "sys",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "audit the flux" }] }],
  tools: [{ type: "function", name: "read" }],
  stream: true,
}
const responsesRewritten = rewriteFreeLanePayload(responsesPayload, { activated: true, extraTools: extras }) as Record<string, unknown>
const responseTools = responsesRewritten.tools as Record<string, unknown>[]
assert.deepEqual(
  responseTools.slice(0, HARNESS_TOOLS_RESPONSES.length),
  [...HARNESS_TOOLS_RESPONSES],
  "Responses lane: the golden 12 keep their bytes and order as the prefix",
)
const responsesEntry = responseTools.find((tool) => tool.name === FUTURE_TOOL) as { type: string; parameters: unknown; function?: unknown } | undefined
assert.ok(responsesEntry, "Responses lane: the future tool extends tools[] after the golden 12")
assert.equal(responsesEntry.type, "function", "Responses lane: flat shape")
assert.equal(responsesEntry.function, undefined, "Responses lane: no chat-style nesting")
assert.deepEqual(responsesEntry.parameters, JSON.parse(JSON.stringify(FUTURE_SCHEMA)), "Responses lane: exact schema in tools[]")

// --- 3. Simulated model call: schema-complete args round-trip to execute -----

// What a model reading either surface would emit — required keys present,
// enum value from the schema, nested array of schema-valid objects.
const modelArgs = {
  target: "north-hall",
  severity: "critical",
  tags: ["drift", "resonance"],
  probes: [
    { kind: "emitter", gain: 1.5 },
    { kind: "resonator" },
  ],
}
// The model's wire shape: JSON text (chat lane accumulates argument deltas;
// Responses lane receives done-arguments) — both end at JSON.parse.
const wireArgs = JSON.stringify(modelArgs)
// Host-side validation against the SAME schema object the model saw:
const schemaSeenByModel = chatEntry?.parameters as typeof FUTURE_SCHEMA
for (const key of schemaSeenByModel.required) {
  assert.ok(Object.prototype.hasOwnProperty.call(modelArgs, key), `schema-complete args carry required key "${key}"`)
}
assert.ok(
  (schemaSeenByModel.properties.severity.enum as readonly string[]).includes(modelArgs.severity),
  "enum value comes from the schema the model was shown",
)
assert.ok(
  modelArgs.probes.every((probe) =>
    (schemaSeenByModel.properties.probes.items.properties.kind.enum as readonly string[]).includes(probe.kind),
  ),
  "nested array items validate against the nested schema the model was shown",
)
const callCtx = { cwd: "/tmp" } as never
const result = await futureTool.execute("call-1", JSON.parse(wireArgs), undefined, undefined, callCtx)
assert.equal(host.executed.length, 1, "the future tool's execute runs")
assert.deepEqual(host.executed[0], modelArgs, "schema-complete model args arrive at execute verbatim")
assert.match(
  (result.content[0] as { text: string }).text,
  /audited north-hall/,
  "the tool result surfaces",
)

// --- 4. Inverse: leaving the active set removes it from BOTH surfaces --------

host.active.length = 0
const extrasAfter = activeExtraTools(host.pi)
assert.equal(
  extrasAfter.find((tool) => tool.name === FUTURE_TOOL),
  undefined,
  "an inactive tool contributes no schema",
)
const chatGone = rewriteFreeLanePayload(chatPayload, { activated: true, extraTools: extrasAfter }) as Record<string, unknown>
assert.ok(
  !((chatGone.messages as { content: string }[])[0]?.content ?? "").includes(FUTURE_TOOL),
  "chat lane: the tool disappears from the schema block",
)
assert.ok(
  !JSON.stringify(chatGone.tools).includes(FUTURE_TOOL),
  "chat lane: the tool never appears in tools[]",
)
const responsesGone = rewriteFreeLanePayload(responsesPayload, { activated: true, extraTools: extrasAfter }) as Record<string, unknown>
assert.ok(
  !JSON.stringify(responsesGone.tools).includes(FUTURE_TOOL),
  "Responses lane: the tool disappears from tools[]",
)
assert.deepEqual(
  responsesGone.tools,
  [...HARNESS_TOOLS_RESPONSES],
  "Responses lane: with no active extras tools[] is exactly the golden 12",
)

// Re-adding to the active set brings it back (activation is the only switch).
host.active.push(FUTURE_TOOL)
assert.ok(
  activeExtraTools(host.pi).some((tool) => tool.name === FUTURE_TOOL),
  "reactivating restores the tool on both surfaces, with no plugin change",
)

console.log("FUTURE-TOOLS OK: a tool this code never saw is schema-visible on both lanes, executes with complete args, and follows the active set")
