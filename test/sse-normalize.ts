// Response-direction SSE normalizer (src/sse-normalize.ts).
//
// Pinned against the REAL event shapes from the 2026-10-16 wire capture of
// muse-spark-1.3-contributor-free on /responses: spec-conformant keys, but
// non-offered tools finish with zero argument bytes (`done: "{}"`), and the
// model's native format qualifies tools as `default.<name>`.
//
// Run: bun test/sse-normalize.ts

import assert from "node:assert/strict"
import { argsLostMarker, normalizeResponsesSse, requestToolNames } from "../src/sse-normalize"

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const feed = async (chunks: (string | Uint8Array)[], toolNames: Set<string>): Promise<string> => {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk)
      controller.close()
    },
  })
  const reader = normalizeResponsesSse(stream, toolNames).getReader()
  let out = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) out += decoder.decode(value, { stream: true })
  }
  return out
}

const tools = new Set(["edit", "glob", "grep", "question", "read", "shell", "skill", "subagent", "webfetch", "websearch", "write", "execute"])

// --- 1. The silent-empty shape becomes a loud, non-executable marker ----------

const created = frame("response.created", { type: "response.created", response: { id: "r1" } })
const lostAdded = frame("response.output_item.added", {
  type: "response.output_item.added",
  output_index: 2,
  item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "todo", arguments: "" },
})
const lostDone = frame("response.function_call_arguments.done", {
  type: "response.function_call_arguments.done",
  output_index: 2,
  item_id: "fc_1",
  name: "todo",
  arguments: "{}",
})
const lostItemDone = frame("response.output_item.done", {
  type: "response.output_item.done",
  output_index: 2,
  item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "todo", arguments: "" },
})
const out1 = await feed([created, lostAdded, lostDone, lostItemDone], tools)
assert.ok(out1.includes(created), "untouched frames keep their original bytes")
assert.ok(!out1.includes(`data: "{}"`), "the empty done-arguments never reach the host")
const doneData = JSON.parse(out1.split("event: response.function_call_arguments.done\ndata: ")[1]?.split("\n\n")[0] ?? "{}") as { arguments?: string }
assert.match(doneData.arguments ?? "", /tool-call lost: "todo"/, "arguments.done carries the marker, which names the tool")
assert.match(doneData.arguments ?? "", /Re-issue against an offered tool with complete JSON arguments/, "the marker is actionable")
const itemDoneData = JSON.parse(out1.split("event: response.output_item.done\ndata: ")[1]?.split("\n\n")[0] ?? "{}") as { item: { arguments?: string } }
assert.match(itemDoneData.item?.arguments ?? "", /tool-call lost: "todo"/, "output_item.done is rewritten too (its args win downstream)")
assert.ok(argsLostMarker("todo").length < 500, "the marker fits the host's 512-char __rawJson bound")

// --- 2. Offered tools pass through byte-identical -----------------------------

const okAdded = frame("response.output_item.added", {
  type: "response.output_item.added",
  output_index: 4,
  item: { type: "function_call", id: "fc_2", call_id: "call_2", name: "subagent", arguments: "" },
})
const okDelta = frame("response.function_call_arguments.delta", {
  type: "response.function_call_arguments.delta",
  output_index: 4,
  item_id: "fc_2",
  delta: '{"agent":"explore"',
})
const okDone = frame("response.function_call_arguments.done", {
  type: "response.function_call_arguments.done",
  output_index: 4,
  item_id: "fc_2",
  name: "subagent",
  arguments: '{"agent":"explore","description":"repro","prompt":"say hi"}',
})
const out2 = await feed([created, okAdded, okDelta, okDone], tools)
assert.equal(out2, created + okAdded + okDelta + okDone, "an offered tool's frames are byte-identical")

// --- 3. A model-emitted {} against an OFFERED tool is not ours to touch -------

const offeredEmpty = frame("response.function_call_arguments.done", {
  type: "response.function_call_arguments.done",
  output_index: 1,
  item_id: "fc_3",
  name: "shell",
  arguments: "{}",
})
const out3 = await feed([created, offeredEmpty], tools)
assert.equal(out3, created + offeredEmpty, "empty args for an OFFERED name stay untouched (schema validation owns those)")

// --- 4. `default.`-qualified names strip when the bare name is offered --------

const qualAdded = frame("response.output_item.added", {
  type: "response.output_item.added",
  output_index: 2,
  item: { type: "function_call", id: "fc_4", call_id: "call_4", name: "default.shell", arguments: "" },
})
const qualDone = frame("response.function_call_arguments.done", {
  type: "response.function_call_arguments.done",
  output_index: 2,
  item_id: "fc_4",
  name: "default.shell",
  arguments: '{"command":"echo ok"}',
})
const out4 = await feed([created, qualAdded, qualDone], tools)
assert.ok(out4.includes(`"name":"shell"`), "default.shell strips to shell in output_item.added")
assert.ok(!out4.includes("default.shell"), "no qualified name survives anywhere")
const strippedDone = JSON.parse(out4.split("event: response.function_call_arguments.done\ndata: ")[1]?.split("\n\n")[0] ?? "{}") as { name?: string; arguments?: string }
assert.equal(strippedDone.name, "shell", "the done event names the bare tool")
assert.equal(strippedDone.arguments, '{"command":"echo ok"}', "arguments survive the name rewrite")

// --- 5. An unknown qualified name still fails loudly when empty ---------------

const qualLost = frame("response.function_call_arguments.done", {
  type: "response.function_call_arguments.done",
  output_index: 2,
  item_id: "fc_5",
  name: "default.todo",
  arguments: "{}",
})
const out5 = await feed([created, qualLost], tools)
assert.match(out5, /tool-call lost: \\"default\.todo\\"/, "an unknown qualified name gets the marker, not {}")

// --- 6. Chunk boundaries never duplicate or drop a frame ----------------------

const whole = created + lostAdded + lostDone + lostItemDone + okAdded + okDelta + okDone
const chunks: string[] = []
for (let i = 0; i < whole.length; i += 7) chunks.push(whole.slice(i, i + 7))
const out6 = await feed(chunks, tools)
assert.equal(out6.length > 0, true)
assert.equal((out6.match(/event: response\.created/g) ?? []).length, 1, "no duplicated frames across 7-byte chunks")
assert.match(out6, /tool-call lost: \\"todo\\"/, "the loss repair survives arbitrary chunking")
assert.ok(out6.includes(okDone), "intact frames survive chunking byte-identical")

// --- 7. A non-SSE body passes through byte-untouched --------------------------

const jsonBody = '{"error":{"message":"nope"}}\n\n'
const out7 = await feed([jsonBody], tools)
assert.equal(out7, jsonBody, "a mislabeled JSON body is never rewritten")

// --- 8. requestToolNames: flat + chat-nested + hostile bodies -----------------

const flat = requestToolNames(Buffer.from(JSON.stringify({ tools: [{ type: "function", name: "todo" }, { type: "function", name: "task" }] })))
assert.deepEqual([...flat].sort(), ["task", "todo"])
const nested = requestToolNames(Buffer.from(JSON.stringify({ tools: [{ type: "function", function: { name: "read" } }] })))
assert.deepEqual([...nested], ["read"])
assert.equal(requestToolNames(Buffer.from("not json")).size, 0, "unparseable bodies contribute no names")
assert.equal(requestToolNames(undefined).size, 0)

console.log("SSE-NORMALIZE OK: loss marker, name strip, byte-pass-through, chunking, name extraction verified")
