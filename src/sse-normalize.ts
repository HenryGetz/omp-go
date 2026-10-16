// Response-direction SSE repair for the Responses lane (free tier included).
//
// WHY THIS EXISTS (wire capture 2026-10-16, /tmp/omp-free-sse.ndjson): the
// serving stack behind the Responses API DROPS argument bytes for function
// names outside the request's `tools` array — every `todo`/`task`/`bash` call
// arrived with ZERO `function_call_arguments.delta` events and
// `done: "{}"` while `subagent`/`execute`/`shell` streamed full JSON. The
// argument bytes are absent from the upstream stream, so nothing downstream
// can reconstruct them (this is why a context block alone can never fix the
// Responses lane, and why `rewriteFreeLanePayload` extends `tools[]` there).
// Two residual shapes this normalizer DOES repair or make loud, always in the
// RESPONSE direction — request bytes never change:
//
//   1. `default.`-qualified names: the model's native format qualifies tools
//      (`default.shell`); the gateway strips the prefix for tools it knows but
//      has passed `default.todo` through verbatim → "Tool default.todo not
//      found". When the bare name IS in the request's tools list, strip it.
//   2. A function_call whose name is NOT in the request's tools list AND that
//      finished with zero argument bytes (the silent-empty shape): its args
//      cannot exist anywhere. Rewriting the done-arguments to a non-JSON
//      marker makes the host surface a parse error that NAMES the tool and
//      explains the transport loss — the call never executes, and the model
//      gets an actionable message instead of a `{}`-vs-schema retry loop.

/** Non-JSON on purpose: the host's argument parser turns this into a
 *  `__parseError` result quoting `__rawJson` back to the model. */
export function argsLostMarker(name: string): string {
  return `<tool-call lost: "${name}" arrived with no arguments and is not in this request's tools list — either the free Responses lane dropped the arguments for an unoffered tool or the name is not offered here. Re-issue against an offered tool with complete JSON arguments.>`
}

const FRAME_SEP = /\r?\n\r?\n/

type NormalizableFrame = {
  /** Original frame bytes — emitted verbatim when nothing changed. */
  raw: string
  eventLine?: string
  data: string
}

function parseFrame(raw: string): NormalizableFrame | undefined {
  const lines = raw.split(/\r?\n/)
  let eventLine: string | undefined
  const dataLines: string[] = []
  for (const line of lines) {
    if (line.startsWith("event:")) eventLine = line
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""))
  }
  if (dataLines.length === 0) return undefined
  return { raw, eventLine, data: dataLines.join("\n") }
}

function serializeFrame(frame: NormalizableFrame): string {
  const lines = [frame.eventLine, `data: ${frame.data}`].filter((line): line is string => line !== undefined)
  return `${lines.join("\n")}\n\n`
}

/** Per-response state for one SSE stream. */
type ItemState = { name: string; argBytes: boolean }

export function normalizeResponsesSse(
  stream: ReadableStream<Uint8Array>,
  requestToolNames: ReadonlySet<string>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  let sawSse = false
  let unsure = true
  let itemsById = new Map<string, ItemState>()
  let itemsByIndex = new Map<number, ItemState>()

  const bareName = (name: string): string =>
    name.startsWith("default.") && requestToolNames.has(name.slice("default.".length))
      ? name.slice("default.".length)
      : name

  const lookup = (id: unknown, index: unknown): ItemState | undefined => {
    if (typeof id === "string") {
      const found = itemsById.get(id)
      if (found) return found
    }
    if (typeof index === "number") return itemsByIndex.get(index)
    return undefined
  }

  /** True when the call finished with no argument bytes and its (bare) name
   *  is not in the request's tools list — the silent-empty transport shape. */
  const lostShape = (state: ItemState | undefined, name: string | undefined, args: unknown): boolean => {
    const resolved = name ? bareName(name) : state?.name
    if (resolved === undefined) return false
    if (requestToolNames.has(resolved)) return false
    if (state?.argBytes) return false
    const text = typeof args === "string" ? args.trim() : ""
    return text === "" || text === "{}"
  }

  const rewriteFrame = (frame: NormalizableFrame): string => {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(frame.data) as Record<string, unknown>
    } catch {
      return frame.raw
    }
    const type = typeof obj.type === "string" ? obj.type : undefined
    if (type === undefined) return frame.raw
    let changed = false
    // Mutations happen on `obj`; the frame only re-serializes from it when
    // something changed (otherwise the ORIGINAL bytes stay untouched).
    const finish = (): string => {
      frame.data = JSON.stringify(obj)
      return serializeFrame(frame)
    }

    if (type === "response.created") {
      // A stream can carry several responses; ids/indexes restart per response.
      itemsById = new Map()
      itemsByIndex = new Map()
      return frame.raw
    }

    if (type === "response.output_item.added") {
      const item = obj.item as Record<string, unknown> | undefined
      if (item?.type === "function_call" && typeof item.name === "string") {
        const stripped = bareName(item.name)
        const state: ItemState = { name: stripped, argBytes: false }
        if (typeof item.id === "string") itemsById.set(item.id, state)
        if (typeof obj.output_index === "number") itemsByIndex.set(obj.output_index, state)
        if (stripped !== item.name) {
          item.name = stripped
          changed = true
        }
      }
      return changed ? finish() : frame.raw
    }

    if (type === "response.function_call_arguments.delta") {
      const state = lookup(obj.item_id, obj.output_index)
      if (state && typeof obj.delta === "string" && obj.delta.trim().length > 0) state.argBytes = true
      return frame.raw
    }

    if (type === "response.function_call_arguments.done") {
      const state = lookup(obj.item_id, obj.output_index)
      const name = typeof obj.name === "string" ? obj.name : undefined
      if (name !== undefined) {
        const stripped = bareName(name)
        if (stripped !== name) {
          obj.name = stripped
          changed = true
        }
      }
      if (lostShape(state, name, obj.arguments)) {
        obj.arguments = argsLostMarker(bareName(name ?? state?.name ?? "tool"))
        changed = true
      }
      return changed ? finish() : frame.raw
    }

    if (type === "response.output_item.done") {
      const item = obj.item as Record<string, unknown> | undefined
      if (item?.type !== "function_call") return frame.raw
      const state = lookup(item.id, obj.output_index)
      const name = typeof item.name === "string" ? item.name : undefined
      if (name !== undefined) {
        const stripped = bareName(name)
        if (stripped !== name) {
          item.name = stripped
          changed = true
        }
      }
      // `.done`-args win over the delta buffer downstream; a blank item
      // arguments field would also erase a marker set on the arguments.done
      // event, so both frames are rewritten together.
      if (lostShape(state, name, item.arguments)) {
        item.arguments = argsLostMarker(bareName(name ?? state?.name ?? "tool"))
        changed = true
      }
      return changed ? finish() : frame.raw
    }

    return frame.raw
  }

  /** Drain every complete frame out of `buffer` (closure state: consume as
   *  you go, so no frame is ever emitted twice across chunk boundaries). */
  const drainFrames = (flush: boolean): Uint8Array[] => {
    const out: Uint8Array[] = []
    for (;;) {
      const match = FRAME_SEP.exec(buffer)
      if (!match) break
      const raw = buffer.slice(0, match.index)
      const separator = match[0]
      buffer = buffer.slice(match.index + separator.length)
      if (raw.trim().length === 0) {
        out.push(encoder.encode(separator))
        continue
      }
      // The first non-empty frame decides whether this stream is SSE at all: a
      // mislabeled JSON/error body must pass through byte-untouched.
      if (unsure) {
        unsure = false
        sawSse = /^event:|^data:/m.test(raw)
      }
      if (!sawSse) {
        out.push(encoder.encode(raw + separator))
        continue
      }
      const frame = parseFrame(raw)
      if (!frame) {
        out.push(encoder.encode(raw + separator))
        continue
      }
      // Unchanged frames keep their ORIGINAL separator bytes; rewritten frames
      // come back from serializeFrame() already terminated.
      const rewritten = rewriteFrame(frame)
      out.push(encoder.encode(rewritten === frame.raw ? rewritten + separator : rewritten))
    }
    if (flush && buffer.length > 0) {
      out.push(encoder.encode(buffer))
      buffer = ""
    }
    return out
  }

  const ts = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      for (const bytes of drainFrames(false)) controller.enqueue(bytes)
      if (buffer.length > 1024 * 1024) {
        // Pathological non-SSE stream: stop buffering, pass through.
        controller.enqueue(encoder.encode(buffer))
        buffer = ""
      }
    },
    flush(controller) {
      buffer += decoder.decode()
      for (const bytes of drainFrames(true)) controller.enqueue(bytes)
    },
  })
  return stream.pipeThrough(ts)
}

/** Tool names from a request body (flat Responses or chat-nested shape). */
export function requestToolNames(body: Buffer | undefined): Set<string> {
  const names = new Set<string>()
  if (!body) return names
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { tools?: unknown }
    if (!Array.isArray(parsed.tools)) return names
    for (const tool of parsed.tools) {
      if (typeof tool !== "object" || tool === null) continue
      const record = tool as { name?: unknown; function?: { name?: unknown } }
      if (typeof record.name === "string") names.add(record.name)
      else if (typeof record.function?.name === "string") names.add(record.function.name)
    }
  } catch {
    // Unparseable body: skip normalization entirely (caller gets an empty set
    // and every name would mislabel — guard with the size check upstream).
  }
  return names
}
