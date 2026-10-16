// Response-direction SSE normalizer (src/sse-normalize.ts).
//
// Pinned against the REAL event shapes from the 2026-10-16 wire capture of
// muse-spark-1.3-contributor-free on /responses: spec-conformant keys, but
// non-offered tools finish with zero argument bytes (`done: "{}"`), and the
// model's native format qualifies tools as `default.<name>`.
//
// Run: bun test/sse-normalize.ts

import assert from "node:assert/strict"
import { argsLostMarker, chatRequestToolNames, normalizeChatSse, normalizeResponsesSse, requestToolNames } from "../src/sse-normalize"

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


// --- 9. Chat-lane parity: unoffered zero-arg call becomes the loud marker ----

const chatFrame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
const chatDone = "data: [DONE]\n\n"
const chatIntro = (index: number, name: string, args = ""): string =>
  chatFrame({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index, id: `call_${index}`, type: "function", function: { name, arguments: args } }] }, finish_reason: null }] })
const chatArgsDelta = (index: number, args: string): string =>
  chatFrame({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args } }] }, finish_reason: null }] })
const chatFinish = chatFrame({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })

const chatFeed = async (chunks: (string | Uint8Array)[], known: Set<string>): Promise<string> => {
  const encoder = new TextDecoder()
  const dec = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? dec.encode(chunk) : chunk)
      controller.close()
    },
  })
  const reader = normalizeChatSse(stream, known).getReader()
  let out = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) out += encoder.decode(value, { stream: true })
  }
  return out
}

// 9a. The silent-empty shape: unoffered name, zero argument bytes → marker.
{
  const known = new Set(["read", "glob", "todo"]) // todo is "mentioned" (context block)
  const stream1 = chatIntro(0, "quantum_flux") + chatIntro(1, "read", '{"path":"a.ts"}') + chatFinish + chatDone
  const out = await chatFeed([stream1], known)
  assert.ok(!out.includes('{"index":0,"id":"call_0","type":"function","function":{"name":"quantum_flux","arguments":""}}'), "the silent-empty intro never reaches the host as-is")
  const markerIndex = out.indexOf("tool-call lost: \\\"quantum_flux\\\"")
  assert.ok(markerIndex !== -1, "the marker names the unoffered tool")
  const finishIndex = out.indexOf('"finish_reason":"tool_calls"')
  const doneIndex = out.indexOf("data: [DONE]")
  assert.ok(markerIndex < finishIndex && markerIndex < doneIndex, "the marker lands BEFORE the finish/[DONE] frames the host finalizes on")
  assert.ok(out.includes(chatIntro(1, "read", '{"path":"a.ts"}')), "the offered tool's frames stay byte-identical")
  assert.ok(out.includes("data: [DONE]"), "[DONE] survives")
}

// 9b. Mentioned tools (context block) and offered tools pass byte-identical.
{
  const known = new Set(["read", "glob", "todo"])
  const stream2 = chatIntro(0, "todo", '{"op":"init"') + chatArgsDelta(0, ',"items":["a"]}') + chatFinish + chatDone
  assert.equal(await chatFeed([stream2], known), stream2, "a block-mentioned tool with real args passes byte-identical")
  const stream3 = chatIntro(0, "read", '{"path":"x"}') + chatFinish + chatDone
  assert.equal(await chatFeed([stream3], known), stream3, "an offered tool passes byte-identical")
}

// 9c. A model-emitted {} for an OFFERED name stays untouched (schema validation owns it).
{
  const known = new Set(["read"])
  const stream4 = chatIntro(0, "read") + chatFinish + chatDone
  assert.equal(await chatFeed([stream4], known), stream4, "empty args for an offered name are not ours to touch")
}

// 9d. An unoffered call WITH args (model read the context block) passes byte-identical.
{
  const known = new Set(["read"])
  const stream5 = chatIntro(0, "vibe_spawn") + chatArgsDelta(0, '{"cli":"x"}') + chatFinish + chatDone
  assert.equal(await chatFeed([stream5], known), stream5, "unoffered calls with real argument bytes pass untouched")
}

// 9e. Content + non-SSE bodies stay byte-identical.
{
  const known = new Set(["read"])
  const contentStream = chatFrame({ id: "c1", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }) + chatFrame({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + chatDone
  assert.equal(await chatFeed([contentStream], known), contentStream, "a plain content stream passes byte-identical")
  const jsonBody = '{"error":{"message":"nope"}}\n\n'
  assert.equal(await chatFeed([jsonBody], known), jsonBody, "a mislabeled JSON body is never rewritten")
}

// 9f. Chunk boundaries: 7-byte slicing never duplicates or drops a frame.
{
  const known = new Set(["read"])
  const whole = chatIntro(0, "quantum_flux") + chatIntro(1, "read", '{"path":"a.ts"}') + chatFinish + chatDone
  const chunks: string[] = []
  for (let i = 0; i < whole.length; i += 7) chunks.push(whole.slice(i, i + 7))
  const out = await chatFeed(chunks, known)
  assert.equal((out.match(/"finish_reason":"tool_calls"/g) ?? []).length, 1, "no duplicated finish frames across 7-byte chunks")
  assert.match(out, /tool-call lost: \\"quantum_flux\\"/, "the loss repair survives arbitrary chunking")
}

// 9g. Two doubtful parallel calls: both get markers, each on its last carrier.
{
  const known = new Set(["read"])
  const stream6 = chatIntro(0, "flux_a") + chatIntro(1, "flux_b") + chatFinish + chatDone
  const out = await chatFeed([stream6], known)
  assert.match(out, /tool-call lost: \\"flux_a\\"/, "first doubtful call is marked")
  assert.match(out, /tool-call lost: \\"flux_b\\"/, "second doubtful call is marked")
}

// --- 10. chatRequestToolNames: tools[] ∪ context-block names ------------------

{
  const block = [
    "## Additional tools active in this session",
    "",
    "Preamble.",
    "",
    '```json\n[{"name":"todo","description":"d","parameters":{"type":"object"}},{"name":"vibe_spawn","description":"d","parameters":{"type":"object"}}]\n```',
  ].join("\n\n")
  const body = Buffer.from(
    JSON.stringify({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: [{ type: "text", text: `do it\n\n${block}` }] },
      ],
      tools: [{ type: "function", function: { name: "read" } }],
    }),
  )
  const names = chatRequestToolNames(body)
  assert.deepEqual([...names].sort(), ["read", "todo", "vibe_spawn"], "tools[] names AND context-block names both count as offered")
  assert.equal(chatRequestToolNames(Buffer.from("not json")).size, 0, "unparseable bodies contribute no names")
  assert.equal(chatRequestToolNames(undefined).size, 0)
}


console.log("SSE-NORMALIZE OK: loss marker, name strip, byte-pass-through, chunking, name extraction + chat-lane parity verified")
