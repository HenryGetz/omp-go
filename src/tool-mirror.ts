// Free-tier tool mirror.
//
// The keyless free gateway (https://opencode.ai/inference/openai/v1) rejects
// traffic whose `tools` array does not fingerprint as the opencode harness's
// own tool surface (403 FreeTierError). The gate rule, established by ablation
// against the real gateway:
//
//   1. the EXACT harness definitions of `shell` AND `read` must both be present
//      (byte-same name + description + parameters as the harness sends);
//   2. every tool whose NAME is a harness-known name must carry that harness
//      tool's EXACT definition (omp's own read/edit/glob/grep/write schemas are
//      rejected — same names, different schemas);
//   3. unknown-named tools are allowed with any schema;
//   4. descriptions are fingerprint-checked (stripping them breaks the gate).
//
// So on the free lane the request's `tools` array is replaced, wholesale, by the
// harness's own serialization captured in ../../capture/harness-tools.json. That
// rewrite happens on the already-built provider payload (the host's
// `before_provider_request` hook) so nothing downstream re-serializes or
// normalizes the JSON Schema — the bytes stay the harness's.
//
// The model then calls harness names. `read`/`edit`/`glob`/`grep`/`write` are
// omp built-ins, reachable unchanged; a `tool_call` shim translates the harness
// argument shape into omp's. The seven harness-only names (shell, subagent,
// execute, websearch, webfetch, question, skill) are registered as wrapper tools
// with the harness's exact schemas + real behaviour. They are `defaultInactive`
// and only activated on an `opencode-free` session, so the working `opencode-go`
// lane's tool surface (and therefore its request bytes) is untouched.
//
// The replacement SPLITS the surface: omp's own executable tools that are not
// among the 12 (todo, task, vibe_*, …) stay active on the host but drop out of
// the offered array, and each protocol gets the repair that keeps them
// callable (see rewriteFreeLanePayload's docstring for the wire evidence):
//
//   chat/completions — their schemas ride the request context as one compact
//   block appended to the LAST USER message; the gateway preserves argument
//   bytes for any callable name there, so `tools[]` stays byte-harness-shaped.
//
//   Responses — the serving stack DROPS argument bytes for names outside
//   `tools[]` (wire capture 2026-10-16: zero argument deltas, `done: "{}"`
//   while offered names stream full JSON), so the active non-offered tools
//   EXTEND `tools[]` after the golden 12 instead (gate rule 3: unknown names
//   carry any schema), and src/sse-normalize.ts makes any residual
//   zero-argument unoffered call fail loudly on the way back.

import { readFileSync } from "node:fs"
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core"
import { EXTRA_TOOLS_HEADING } from "./sse-normalize"

/** One entry of the OpenAI chat-completions `tools` array, as the harness sends it. */
export type HarnessTool = {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
    strict?: boolean
  }
}

const ASSET_URL = new URL("../capture/harness-tools.json", import.meta.url)

/** The 12 harness tool definitions, byte-faithful to capture/golden-requests.ndjson. */
import { appendFileSync } from "node:fs"
import { join } from "node:path"

export const HARNESS_TOOLS: readonly HarnessTool[] = JSON.parse(
  readFileSync(ASSET_URL, "utf8"),
) as HarnessTool[]

export const HARNESS_TOOL_NAMES: readonly string[] = HARNESS_TOOLS.map((tool) => tool.function.name)

/** Harness names with no same-named omp built-in: registered as real wrappers. */
export const HARNESS_ONLY_NAMES: readonly string[] = [
  "shell",
  "subagent",
  "execute",
  "websearch",
  "webfetch",
  "question",
  "skill",
]

/** Harness names that collide with an omp built-in: reached through the arg shim. */
export const COLLIDING_NAMES: readonly string[] = ["read", "edit", "glob", "grep", "write"]

/**
 * JSON-Schema parameters for the wrapper tools. The `static` member is a
 * type-level phantom only (never present at runtime): it makes pi-ai's
 * `Static<TParams>` resolve to a plain argument record, so wrapper `execute`
 * bodies read params without casting.
 */
type WrapperSchema = Record<string, unknown> & { static: Record<string, unknown> }

const HARNESS_ONLY: Record<string, boolean> = Object.fromEntries(HARNESS_ONLY_NAMES.map((name) => [name, true]))

/** The offered harness surface: already visible to the model through `tools[]`. */
const OFFERED: Record<string, boolean> = Object.fromEntries(HARNESS_TOOL_NAMES.map((name) => [name, true]))

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

const text = (value: string): AgentToolResult<unknown> => ({ content: [{ type: "text", text: value }] })

/** Marker line prefix carrying `execute`'s returned value back to the tool result. */
const RESULT_PREFIX = "__omp_execute_result__:"

/** Whether a name is a harness-only wrapper this module registers. */
export const isHarnessOnlyName = (name: string): boolean => HARNESS_ONLY[name] === true

// --- Request-side rewrite ----------------------------------------------------

/**
 * Responses-protocol function tools put `name` at the TOP level
 * (`{type:"function", name, description, parameters}`); chat-completions
 * nests it under `function`. The harness sends each shape on its protocol —
 * a chat-shaped tool on the Responses API is rejected with
 * `400 Missing required parameter: tools[0].name`.
 */
export const HARNESS_TOOLS_RESPONSES: readonly Record<string, unknown>[] = HARNESS_TOOLS.map((tool) => ({
  type: "function",
  name: tool.function.name,
  description: tool.function.description,
  parameters: tool.function.parameters,
}))

/**
 * A tool the offered `tools` array omits, as it rides the context block. The
 * model needs its name, a one-line description, and the full JSON Schema —
 * host validation enforces the schema, so the schema is never truncated.
 */
export type ExtraToolSchema = {
  name: string
  description: string
  parameters: unknown
}

/** Collapse prose to a single bounded line (the block rides every free turn). */
function oneLine(description: unknown): string {
  const flat = typeof description === "string" ? description.replace(/\s+/g, " ").trim() : ""
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat
}

/**
 * The context block: one compact JSON list of the session's non-offered active
 * tools. The preamble names the exact failure this prevents — a model calling
 * tools it was never shown and inventing their argument shapes from history.
 */
function renderExtraToolsBlock(tools: readonly ExtraToolSchema[]): string {
  const entries = tools.map((tool) => ({
    name: tool.name,
    description: oneLine(tool.description),
    parameters: tool.parameters ?? { type: "object", properties: {} },
  }))
  return [
    EXTRA_TOOLS_HEADING,
    "The tools below are active and fully callable in this session even though they are not in the `tools` array (the free gateway only accepts the harness's own tool surface there). Before calling one, read its schema here — call it by name with arguments matching that JSON Schema exactly: never rename keys, invent enum values, or reuse an argument shape from earlier history or from a similar-sounding tool.",
    // Pretty-printed on purpose: a model scanning a compact one-line JSON wall
    // skips past `properties` and improvises (observed live: todo called with
    // guessed keys while its schema sat unread in the block). Indented schema
    // blocks are what tool definitions look like everywhere the model has been
    // trained to read them.
    `\`\`\`json\n${JSON.stringify(entries, null, 2)}\n\`\`\``,
  ].join("\n\n")
}

/** The active non-offered tools as Responses `tools[]` entries (flat shape,
 *  same serialization family the golden 12 use on this protocol). */
function extraResponsesTools(tools: readonly ExtraToolSchema[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: oneLine(tool.description),
    parameters: tool.parameters ?? { type: "object", properties: {} },
  }))
}

/** Append `block` to a message's text content — string or typed text parts. */
function appendTextContent(content: unknown, block: string, textType: string): unknown {
  if (typeof content === "string") return `${content}\n\n${block}`
  if (Array.isArray(content)) {
    const parts = content.slice()
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const part = parts[index]
      const text = part && typeof part === "object" ? (part as { text?: unknown }).text : undefined
      if (typeof text === "string") {
        parts[index] = { ...(part as Record<string, unknown>), text: `${text}\n\n${block}` }
        return parts
      }
    }
    parts.push({ type: textType, text: block })
    return parts
  }
  return block
}

/**
 * Append `block` to a chat payload's request context without adding a top-level
 * body field or disturbing the fingerprinted `tools` array. The LAST user
 * message carries it — the sentence that triggers the tool call is right above
 * it, and the live gate showed a system-level block being scanned past (todo
 * improvised with its full schema sitting unread in the system prompt).
 * Payloads without a user message fall back to the LAST leading
 * system/developer message. Responses payloads never take this path: they
 * carry the extras in `tools[]` instead (see {@link rewriteFreeLanePayload}).
 */
function injectContextBlock(payload: Record<string, unknown>, block: string): Record<string, unknown> {
  const container = payload.messages
  if (!Array.isArray(container)) return payload
  const items = container.slice()
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const role = (items[index] as { role?: unknown } | null)?.role
    if (role !== "user") continue
    const message = items[index] as Record<string, unknown>
    items[index] = { ...message, content: appendTextContent(message.content, block, "text") }
    return { ...payload, messages: items }
  }
  let target = -1
  for (let index = 0; index < items.length; index += 1) {
    const role = (items[index] as { role?: unknown } | null)?.role
    if (role === "system" || role === "developer") target = index
    else break
  }
  if (target >= 0) {
    const item = items[target] as Record<string, unknown>
    items[target] = { ...item, content: appendTextContent(item.content, block, "text") }
    return { ...payload, messages: items }
  }
  items.unshift({ role: "system", content: block })
  return { ...payload, messages: items }
}

/**
 * State of the free-lane session at rewrite time. `activated` is the
 * never-advertise-without-activation guard: the harness names may reach the
 * wire only when activation confirmed them, or the host answers every harness
 * call with "Tool ... not found". `extraTools` carries the ACTIVE tools the
 * offered surface omits; their schemas ride the request context.
 */
export type FreeLaneRewriteState = {
  activated: boolean
  extraTools?: readonly ExtraToolSchema[]
}

/**
 * Replace a built provider payload's `tools` array with the harness's exact 12.
 * Returns the payload unchanged when it carries no tools (a tool-less turn —
 * e.g. a title/compaction call — must not gain a tool surface it never had),
 * and unchanged when `state.activated` is not true (the host's own payload
 * resolves its own tool names). Shape follows the protocol: flat tools for
 * Responses payloads (`input`), chat-wrapped for completions payloads
 * (`messages`).
 *
 * The swap also SPLITS the tool surface: every active tool outside the 12 is
 * dropped from `tools[]` yet stays executable by the host — and the two
 * protocols need DIFFERENT repairs to keep those tools usable:
 *
 *   chat/completions — the gateway preserves argument bytes for ANY callable
 *   name (mimo emitted first-shot-valid `todo` args with only the context
 *   block), so the schemas ride the request CONTEXT: one compact block
 *   appended to the LAST USER message (next to the task that triggers the
 *   call). `tools[]` stays byte-harness-shaped.
 *
 *   Responses — the serving stack DROPS argument bytes for function names
 *   outside `tools[]` (wire capture 2026-10-16: every `todo`/`task`/`bash`
 *   call arrives with ZERO `function_call_arguments.delta` events and
 *   `done: "{}"` while `subagent`/`execute`/`shell` stream full JSON), so a
 *   context block can never work there. The active non-offered tools are
 *   extended INTO `tools[]` instead — after the golden 12, flat shape, real
 *   schemas — which is a native surface every model's tool-calling head is
 *   trained on, and the gate's rule 3 allows unknown-named tools with any
 *   schema.
 *
 * Either way: no new top-level body field, and the golden 12 keep their
 * bytes and order.
 */
export function rewriteFreeLanePayload(payload: unknown, state: FreeLaneRewriteState): unknown {
  if (typeof payload !== "object" || payload === null || !("tools" in payload)) return payload
  const tools = payload.tools
  if (!Array.isArray(tools) || tools.length === 0) return payload
  if (state.activated !== true) return payload
  const record = payload as Record<string, unknown>
  const responses = "input" in record && !("messages" in record)
  const surface = responses ? HARNESS_TOOLS_RESPONSES : HARNESS_TOOLS
  let next: Record<string, unknown> = { ...record, tools: surface.map((tool) => tool) }
  const extra = state.extraTools ?? []
  if (extra.length > 0) {
    if (responses) {
      // Responses: extend `tools[]` (see the docstring — argument bytes for
      // unoffered names do not survive this protocol). The golden 12 keep
      // their bytes and order; the extras follow.
      next = { ...next, tools: [...HARNESS_TOOLS_RESPONSES, ...extraResponsesTools(extra)] }
    } else if (Array.isArray(next.messages)) {
      const block = renderExtraToolsBlock(extra)
      next = injectContextBlock(next, block)
    }
  }
  return next
}

/** True when a payload's `tools` array is the harness's exact 12, in order. */
export function isHarnessToolPayload(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || !("tools" in payload)) return false
  const tools = payload.tools
  if (!Array.isArray(tools) || tools.length !== HARNESS_TOOLS.length) return false
  return tools.every((tool, index) => {
    if (typeof tool !== "object" || tool === null || !("function" in tool)) return false
    const fn = tool.function
    return typeof fn === "object" && fn !== null && "name" in fn && fn.name === HARNESS_TOOL_NAMES[index]
  })
}

// --- Argument shim (harness shape -> omp built-in shape) ---------------------

/** Append an omp read selector (`:N-M` / `:N-` / `:1-M`) when harness offset/limit are given. */
function withReadSelector(path: string, offset: number | undefined, limit: number | undefined): string {
  if (path.includes(":")) return path
  const from = offset ?? 1
  if (limit !== undefined) return `${path}:${from}-${from + Math.max(1, limit) - 1}`
  if (offset !== undefined) return `${path}:${from}-`
  return path
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g

/**
 * Translate a harness-shaped argument object into the parameter object omp's
 * built-in for the same name expects. Returns `undefined` when the call does
 * not look harness-shaped (an already-omp-shaped call is left alone).
 */
export function toOmpParams(name: string, input: Record<string, unknown>): Record<string, unknown> | undefined {
  switch (name) {
    case "read": {
      if (typeof input.i === "string") return undefined
      const path = str(input.path)
      if (path === undefined) return undefined
      return { path: withReadSelector(path, num(input.offset), num(input.limit)) }
    }
    case "edit": {
      if (str(input.oldString) === undefined) return undefined
      const translated: Record<string, unknown> = {
        path: input.path,
        old_string: input.oldString,
        new_string: input.newString,
      }
      if (typeof input.replaceAll === "boolean") translated.replace_all = input.replaceAll
      return translated
    }
    case "glob": {
      const pattern = str(input.pattern)
      if (pattern === undefined) return undefined
      const root = str(input.path)
      const combined = root && !pattern.startsWith("/") ? `${root.replace(/\/+$/, "")}/${pattern}` : pattern
      const translated: Record<string, unknown> = { path: combined }
      if (typeof input.hidden === "boolean") translated.hidden = input.hidden
      if (num(input.limit) !== undefined) translated.limit = input.limit
      return translated
    }
    case "grep": {
      const pattern = str(input.pattern)
      if (pattern === undefined) return undefined
      // omp grep has no literal flag: escape the pattern when the harness asked
      // for a substring match. `include`/`limit` have no omp equivalent.
      const translated: Record<string, unknown> = {
        pattern: input.literal === true ? pattern.replace(REGEX_META, "\\$&") : pattern,
      }
      if (str(input.path) !== undefined) translated.path = input.path
      if (typeof input.caseSensitive === "boolean") translated.case = input.caseSensitive
      return translated
    }
    case "write": {
      if (typeof input.i === "string") return undefined
      return { path: input.path, content: input.content }
    }
    default:
      return undefined
  }
}

// --- Wrapper tools -----------------------------------------------------------

function harnessDefinition(name: string): HarnessTool["function"] {
  const tool = HARNESS_TOOLS.find((entry) => entry.function.name === name)
  if (!tool) throw new Error(`tool-mirror: no harness definition for "${name}"`)
  return tool.function
}

const decodeEntities = (html: string): string =>
  html
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))

/** Minimal, real HTML→markdown: headings, links, lists, code blocks. */
export function htmlToMarkdown(html: string): string {
  let out = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
  out = out.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body: string) => `\n\`\`\`\n${decodeEntities(body.replace(/<[^>]+>/g, ""))}\n\`\`\`\n`)
  out = out.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, body: string) => `\`${decodeEntities(body.replace(/<[^>]+>/g, ""))}\``)
  out = out.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, body: string) => `\n${"#".repeat(Number(level))} ${decodeEntities(body.replace(/<[^>]+>/g, "")).trim()}\n`)
  out = out.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, body: string) => `\n- ${decodeEntities(body.replace(/<[^>]+>/g, "")).trim()}`)
  out = out.replace(/<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, body: string) => `[${decodeEntities(body.replace(/<[^>]+>/g, "")).trim()}](${href})`)
  out = out.replace(/<\/(p|div|section|article|li|ul|ol|tr|table)>/gi, "\n")
  out = out.replace(/<br\s*\/?>/gi, "\n")
  out = out.replace(/<[^>]+>/g, "")
  return decodeEntities(out)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

async function runWebfetch(params: Record<string, unknown>, signal: AbortSignal | undefined): Promise<string> {
  const url = str(params.url)
  if (!url) throw new Error("webfetch: `url` is required")
  const format = str(params.format) ?? "markdown"
  const seconds = num(params.timeout)
  const timeoutMs = seconds !== undefined && seconds > 0 ? Math.min(seconds, 120) * 1000 : 30_000
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  const response = await fetch(url, { signal: combined, headers: { accept: "text/html,application/xhtml+xml,text/plain,*/*" } })
  const body = await response.text()
  const header = `HTTP ${response.status}${response.url && response.url !== url ? ` (${response.url})` : ""}`
  if (format === "html") return `${header}\n\n${body}`
  if (format === "text" || !/html/i.test(response.headers.get("content-type") ?? "")) return `${header}\n\n${htmlToText(body)}`
  return `${header}\n\n${htmlToMarkdown(body)}`
}

async function runWebsearch(params: Record<string, unknown>, signal: AbortSignal | undefined): Promise<string> {
  const query = str(params.query)
  if (!query) throw new Error("websearch: `query` is required")
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`
  const timeoutSignal = AbortSignal.timeout(20_000)
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  const response = await fetch(url, { signal: combined, headers: { accept: "text/html", "user-agent": "Mozilla/5.0" } })
  const html = await response.text()
  const results: string[] = []
  const linkRe = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const snippetRe = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi
  const links = [...html.matchAll(linkRe)]
  const snippets = [...html.matchAll(snippetRe)]
  for (const [index, match] of links.entries()) {
    const href = decodeEntities(match[1] ?? "")
    const title = decodeEntities((match[2] ?? "").replace(/<[^>]+>/g, "")).trim()
    const snippet = decodeEntities((snippets[index]?.[1] ?? "").replace(/<[^>]+>/g, "")).trim()
    if (!title) continue
    results.push(`${index + 1}. ${title}\n   ${href}${snippet ? `\n   ${snippet}` : ""}`)
  }
  if (results.length === 0) {
    const fallback = htmlToText(html).slice(0, 4000)
    return `Web search for ${JSON.stringify(query)} returned no parsed results (HTTP ${response.status}).\n\n${fallback}`
  }
  return `Web search results for ${JSON.stringify(query)}:\n\n${results.join("\n\n")}`
}

function baseDefinition(name: string, label: string): Omit<ToolDefinition<WrapperSchema, unknown>, "execute"> {
  const definition = harnessDefinition(name)
  return {
    name,
    label,
    description: definition.description,
    // Type-level only: the phantom `static` member makes `Static<WrapperSchema>`
    // a plain argument record; at runtime this is the harness's JSON Schema.
    parameters: definition.parameters as WrapperSchema,
    strict: false,
    defaultInactive: true,
    loadMode: "discoverable",
    approval: name === "question" || name === "skill" ? "read" : "exec",
  }
}

function makeWrappers(pi: ExtensionAPI): ToolDefinition<WrapperSchema, unknown>[] {
  const shell: ToolDefinition<WrapperSchema, unknown> = {
    ...baseDefinition("shell", "Shell"),
    execute: async (_id, params, signal, _onUpdate, ctx) => {
      const command = str(params.command)
      if (!command) throw new Error("shell: `command` is required")
      const workdir = str(params.workdir) ?? ctx.cwd
      const timeout = num(params.timeout)
      const result = await pi.exec("bash", ["-c", command], {
        cwd: workdir,
        signal,
        timeout: timeout !== undefined && timeout > 0 ? timeout : undefined,
      })
      const output = [result.stdout, result.stderr].filter((part) => part.trim().length > 0).join("\n").trim()
      const status = `exit ${result.code}${result.killed ? " (killed)" : ""}`
      const note = params.background === true ? "\n\n[note] background execution is not available on this lane; ran in the foreground." : ""
      return text(`${output || "(no output)"}\n\n${status}${note}`)
    },
  }

  const execute: ToolDefinition<WrapperSchema, unknown> = {
    ...baseDefinition("execute", "Execute"),
    execute: async (_id, params, signal, _onUpdate, ctx) => {
      const code = str(params.code)
      if (!code) throw new Error("execute: `code` is required")
      // The harness's execute evaluates a FUNCTION BODY: models write
      // `return {...}` and expect the value as the tool result. Run the code
      // wrapped in an async function so `return` and top-level await both
      // work, and surface the returned value as the headline.
      const wrapped = [
        "(async () => {",
        code,
        "})().then((value) => {",
        `  if (value !== undefined) process.stdout.write("\\n${RESULT_PREFIX}" + JSON.stringify(value) + "\\n")`,
        "}).catch((error) => {",
        "  console.error(String((error && error.stack) || error))",
        "  process.exitCode = 1",
        "})",
      ].join("\n")
      const runtime = process.versions.bun ? "bun" : process.execPath
      const args = runtime === "bun" ? ["-e", wrapped] : ["--input-type=module", "-e", wrapped]
      const result = await pi.exec(runtime, args, { cwd: ctx.cwd, signal })
      const lines = [result.stdout, result.stderr]
        .filter((part) => part.trim().length > 0)
        .join("\n")
        .split("\n")
      const valueLine = lines.find((line) => line.startsWith(RESULT_PREFIX))
      const rest = lines.filter((line) => !line.startsWith(RESULT_PREFIX)).join("\n").trim()
      const returned = valueLine?.slice(RESULT_PREFIX.length)
      const status = `exit ${result.code}`
      if (returned !== undefined) {
        let pretty = returned
        try {
          pretty = JSON.stringify(JSON.parse(returned), null, 2)
        } catch {
          // Not JSON: show the raw serialization.
        }
        return text(`${pretty}${rest ? `\n\n${rest}` : ""}\n\n${status}`)
      }
      return text(`${rest || "(no output)"}\n\n${status}`)
    },
  }

  const subagent: ToolDefinition<WrapperSchema, unknown> = {
    ...baseDefinition("subagent", "Subagent"),
    execute: async (_id, params, signal, _onUpdate, ctx) => {
      const prompt = str(params.prompt)
      if (!prompt) throw new Error("subagent: `prompt` is required")
      const agent = str(params.agent)
      const description = str(params.description)
      const model = str(params.model)
      const args = ["run", "--print", "--no-title"]
      if (model) args.push(`--model=${model}`)
      args.push(prompt)
      const result = await pi.exec(process.env.OMP_BIN ?? "omp", args, { cwd: ctx.cwd, signal, timeout: 600_000 })
      const output = [result.stdout, result.stderr].filter((part) => part.trim().length > 0).join("\n").trim()
      const header = [agent ? `agent: ${agent}` : undefined, description ? `task: ${description}` : undefined].filter(Boolean).join(", ")
      if (result.code !== 0 && output.length === 0) throw new Error(`subagent: child exited ${result.code}`)
      return text(`${header ? `${header}\n\n` : ""}${output}`)
    },
  }

  const webfetch: ToolDefinition<WrapperSchema, unknown> = {
    ...baseDefinition("webfetch", "Web Fetch"),
    execute: async (_id, params, signal) => text(await runWebfetch(params, signal)),
  }

  const websearch: ToolDefinition<WrapperSchema, unknown> = {
    ...baseDefinition("websearch", "Web Search"),
    execute: async (_id, params, signal) => text(await runWebsearch(params, signal)),
  }

  const question: ToolDefinition<WrapperSchema, unknown> = {
    ...baseDefinition("question", "Question"),
    execute: async (_id, params) => {
      const entries: unknown[] = Array.isArray(params.questions) ? params.questions : []
      const rendered = entries
        .map((entry, index) => {
          if (typeof entry !== "object" || entry === null) return `${index + 1}. ${String(entry)}`
          const header = "header" in entry && typeof entry.header === "string" ? entry.header : `Question ${index + 1}`
          const body = "question" in entry && typeof entry.question === "string" ? entry.question : ""
          const rawOptions = "options" in entry && Array.isArray(entry.options) ? entry.options : []
          const options = rawOptions
            .map((option) => {
              if (typeof option !== "object" || option === null) return `   - ${String(option)}`
              const label = "label" in option && typeof option.label === "string" ? option.label : ""
              const description = "description" in option && typeof option.description === "string" ? option.description : ""
              return `   - ${label}: ${description}`
            })
            .join("\n")
          return `${index + 1}. ${header}\n   ${body}${options ? `\n${options}` : ""}`
        })
        .join("\n\n")
      return text(
        `No interactive user is available on this lane, so the question tool cannot prompt.\n\n${rendered}\n\nProceed with your best judgement, stating the assumption you made.`,
      )
    },
  }

  const skill: ToolDefinition<WrapperSchema, unknown> = {
    ...baseDefinition("skill", "Skill"),
    execute: async (_id, params) => {
      const id = str(params.id) ?? "(unknown)"
      return text(
        `Skills cannot be loaded on this lane (skill:// resources are not mounted here). Requested skill: ${id}. Use read/grep to inspect repository skill files instead.`,
      )
    },
  }

  return [shell, subagent, execute, websearch, webfetch, question, skill]
}

/**
 * Wrappers for the five harness names that collide with an omp built-in. They
 * carry the harness's exact schema and translate the call into omp's shape,
 * then delegate to the native built-in through `ctx.invokeTool` (same-name
 * delegation). Registered only on a free-lane session so the Go lane keeps the
 * built-ins' own schemas.
 */
function makeCollidingWrappers(): ToolDefinition<WrapperSchema, unknown>[] {
  return COLLIDING_NAMES.map((name) => ({
    ...baseDefinition(name, name === "read" ? "Read" : name === "write" ? "Write" : name[0].toUpperCase() + name.slice(1)),
    execute: async (_id, params, signal, onUpdate, ctx) => {
      const ompParams = toOmpParams(name, params)
      if (ompParams === undefined) throw new Error(`${name}: unrecognized harness arguments`)
      if (!ctx.invokeTool) throw new Error(`${name}: native delegate unavailable`)
      return ctx.invokeTool(ompParams, { signal, onUpdate })
    },
  }))
}

/**
 * Register the five colliding-name wrappers. Call on a free-lane session only:
 * they intentionally re-register the omp built-ins, so a Go-lane session must
 * never see them.
 */
export function registerCollidingHarnessTools(pi: ExtensionAPI): void {
  for (const wrapper of makeCollidingWrappers()) registerOne(pi, wrapper)
}

// One tool at a time: a name the host refuses (built-in collision etc.) must
// never abort the loop and leave the rest unregistered ("Tool shell not
// found" while write worked was exactly this).
function registerOne(pi: ExtensionAPI, wrapper: ToolDefinition<WrapperSchema, unknown>): void {
  try {
    pi.registerTool(wrapper)
  } catch (error) {
    try {
      appendFileSync(join(process.env.HOME || "", ".omp", "agent", "omp-go-tool-reg.log"), `${new Date().toISOString()} TOOL-REG-FAIL ${wrapper.name ?? "?"}: ${String(error).slice(0, 160)}\n`)
    } catch {}
  }
}

/**
 * Register the seven harness-only wrapper tools. They are `defaultInactive`
 * (invisible on the `opencode-go` lane) and activated for `opencode-free`
 * sessions by {@link activateHarnessTools}.
 */
export function registerHarnessTools(pi: ExtensionAPI): void {
  for (const wrapper of makeWrappers(pi)) registerOne(pi, wrapper)
}

/**
 * Activate the harness wrappers when the session runs the free lane.
 * `includeColliding` must be true only after {@link registerCollidingHarnessTools}
 * has run, so the colliding names resolve to the wrappers rather than the
 * built-ins.
 *
 * Returns true when the harness tool surface is ACTIVE — the caller's licence
 * to advertise the harness names on the wire (see {@link rewriteFreeLanePayload}).
 * False means this is not the free lane or the active set never established
 * (the 30 s wait exhausted): the request must then keep the host's own tools.
 */
export async function activateHarnessTools(
  pi: ExtensionAPI,
  provider: string | undefined,
  includeColliding = false,
): Promise<boolean> {
  if (provider !== "opencode-free") return false
  // The first turn is exactly when the hook can run BEFORE the session's tool
  // set is populated - and skipping there leaves the turn with a tool list
  // whose names the host cannot resolve ("Tool write not found"). Wait,
  // bounded, for the built-in surface to establish; never clobber an empty
  // snapshot into a wrapper-only set.
  let active = pi.getActiveTools()
  // Session assembly (the "Still starting" phase) can take 30s+; the first
  // turn's tool calls resolve against this snapshot, so wait it out rather
  // than skip (skip = "Tool write not found" on turn 1).
  for (let i = 0; i < 60 && active.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    active = pi.getActiveTools()
  }
  try {
    appendFileSync(join(process.env.HOME || "", ".omp", "agent", "omp-go-tool-reg.log"), `${new Date().toISOString()} ACTIVATE provider=${provider ?? "?"} active=${active.length} colliding=${includeColliding}\n`)
  } catch {}
  if (active.length === 0) return false
  if (includeColliding) {
    // The colliding wrappers REPLACE omp's built-ins in the registry, so an
    // active list built earlier holds STALE entries for those names — the
    // host then answers their calls with "Tool not found". Rebuild the set
    // so every harness name re-resolves against the current registry.
    const rebuilt = [
      ...active.filter((name) => !HARNESS_TOOL_NAMES.includes(name) && !COLLIDING_NAMES.includes(name)),
      ...HARNESS_TOOL_NAMES,
    ]
    // Already fully active: the surface resolves even though nothing changed.
    if (rebuilt.length === active.length && HARNESS_TOOL_NAMES.every((name) => active.includes(name))) return true
    await pi.setActiveTools(rebuilt)
    return true
  }
  const missing = HARNESS_ONLY_NAMES.filter((name) => !active.includes(name))
  if (missing.length > 0) await pi.setActiveTools([...active, ...missing])
  return true
}

/**
 * Host built-ins register omptype schema INSTANCES whose JSON.stringify is
 * `{}` — shipping that as a "schema" tells the model the tool takes no
 * arguments, and it improvises (exactly the failure this block prevents).
 * omptype emits real JSON Schema via toJsonSchema(); MCP/extension tools
 * already carry plain JSON and pass through untouched.
 */
function jsonSchemaOf(parameters: unknown): unknown {
  // omptype schemas are FUNCTION instances (own length/name/ir, methods on the
  // prototype) — a plain `typeof === "object"` guard skips exactly them.
  if (parameters !== null && (typeof parameters === "object" || typeof parameters === "function")) {
    const candidate = parameters as { toJsonSchema?: () => Record<string, unknown> }
    if (typeof candidate.toJsonSchema === "function") {
      try {
        return candidate.toJsonSchema()
      } catch {
        // An unemittable schema falls through as-is; never crash the request.
      }
    }
  }
  return parameters
}

/**
 * The session's ACTIVE tools the offered surface omits, with their registry
 * schemas. The rewrite offers only the harness 12, yet the host keeps
 * executing these — a model that never sees their schemas improvises argument
 * shapes and fails host validation ("Invalid todo arguments…",
 * "vibe_spawn … (was missing)"). Deduped (a re-registered name resolves to the
 * latest registration); only tools actually active in the session qualify.
 */
export function activeExtraTools(pi: ExtensionAPI): ExtraToolSchema[] {
  let active: string[]
  let all: { name?: unknown; description?: unknown; parameters?: unknown }[]
  try {
    active = pi.getActiveTools()
    all = typeof pi.getAllTools === "function" ? pi.getAllTools() : []
  } catch {
    return []
  }
  const activeSet = new Set(active)
  const seen = new Set<string>()
  const extra: ExtraToolSchema[] = []
  for (const info of all) {
    const name = typeof info?.name === "string" ? info.name : undefined
    if (name === undefined) continue
    if (OFFERED[name] === true) continue // already visible through the offered tools[]
    if (!activeSet.has(name)) continue
    if (seen.has(name)) continue
    seen.add(name)
    extra.push({ name, description: typeof info.description === "string" ? info.description : "", parameters: jsonSchemaOf(info.parameters) })
  }
  return extra
}

/** Test seam: the harness definitions as a name→function record. */
export const HARNESS_DEFINITIONS: Readonly<Record<string, HarnessTool["function"]>> = Object.fromEntries(
  HARNESS_TOOLS.map((tool) => [tool.function.name, tool.function]),
)
