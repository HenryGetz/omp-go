// Wire-parity proof: drives the omp integration layer against
// capture/stub-console.mjs and diffs the resulting trace against
// capture/golden-requests.ndjson — the recorded output of the real opencode
// v2.0.26 harness against the same stub.
//
// Comparison model: protocol constants must match exactly (paths, methods,
// grant_type/client_id bodies, User-Agent, header sets, body key order). Random
// values (tokens, trace/span ids, session/project ids) must match the golden
// value *shape* and are compared as placeholders. Message/tool arrays are user
// content and compare as `<ARRAY>`.
//
// Run: bun test/parity.ts

import { spawn, type ChildProcess } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"
import { OpencodeOAuthProvider } from "../src/opencode-provider"
import { registerOpencodeGo } from "../src/register"
import { fetchConsoleConfig, zenChatCompletion, type SessionIdentity } from "../src/wire"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..")
const GOLDEN_PATH = path.join(REPO, "capture", "golden-requests.ndjson")
const STUB_PATH = path.join(REPO, "capture", "stub-console.mjs")
const PORT = 18988
const LOG_PATH = path.join(HERE, "omp-requests.ndjson")

type WireRequest = {
  time: string
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

// --- trace capture -----------------------------------------------------------

async function startStub(): Promise<ChildProcess> {
  const child = spawn("node", [STUB_PATH], {
    env: { ...process.env, STUB_PORT: String(PORT), STUB_LOG: LOG_PATH },
    stdio: ["ignore", "pipe", "inherit"],
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("stub did not start")), 10_000)
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening")) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  return child
}

const readTrace = (file: string): WireRequest[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WireRequest)

// --- fingerprint assertions (checked before normalization) -------------------

const EXPECTED_UA = "opencode/latest/2.0.26/cli"
const B3_RE = /^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/
const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/
const SESSION_RE = /^ses_[A-Za-z0-9]{26}$/
const PROJECT_RE = /^[0-9a-f]{40}$/

function fingerprintChecks(requests: WireRequest[], label: string): string[] {
  const problems: string[] = []
  for (const [index, request] of requests.entries()) {
    const at = `${label}[${index}] ${request.method} ${request.url}`
    const ua = request.headers["user-agent"]
    if (ua !== EXPECTED_UA) problems.push(`${at}: user-agent ${JSON.stringify(ua)} != ${EXPECTED_UA}`)
    const b3 = request.headers["b3"]
    const traceparent = request.headers["traceparent"]
    if (!b3 || !B3_RE.test(b3)) problems.push(`${at}: malformed b3 ${JSON.stringify(b3)}`)
    if (!traceparent || !TRACEPARENT_RE.test(traceparent)) problems.push(`${at}: malformed traceparent ${JSON.stringify(traceparent)}`)
    if (b3 && traceparent && b3.slice(0, 32) !== traceparent.slice(3, 35))
      problems.push(`${at}: b3/traceparent trace ids disagree`)
    for (const name of ["x-opencode-session", "x-opencode-session-id", "x-session-affinity", "x-session-id"]) {
      const value = request.headers[name]
      if (value !== undefined && !SESSION_RE.test(value)) problems.push(`${at}: ${name} shape ${JSON.stringify(value)}`)
    }
    const project = request.headers["x-opencode-project"]
    if (project !== undefined && !PROJECT_RE.test(project)) problems.push(`${at}: project shape ${JSON.stringify(project)}`)
  }
  return problems
}

// --- normalization -----------------------------------------------------------

const PROTOCOL_STRINGS: Record<string, true> = {
  "opencode-cli": true,
  "urn:ietf:params:oauth:grant-type:device_code": true,
  refresh_token: true,
  "mimo-v2.6-pro": true,
  "application/json": true,
  "*/*": true,
}

function normalizeScalar(value: unknown): unknown {
  if (typeof value !== "string") return value
  if (PROTOCOL_STRINGS[value]) return value
  if (/^(at|rt|dev)_stub_\d+$/.test(value)) return "<TOKEN>"
  if (/^ses_[A-Za-z0-9]+$/.test(value)) return "<SESSION>"
  if (/^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/.test(value)) return "<B3>"
  if (/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(value)) return "<TRACEPARENT>"
  if (/^[0-9a-f]{32,}$/.test(value)) return "<HEX>"
  if (value.startsWith("Bearer ")) return "Bearer <TOKEN>"
  return value
}

function normalizeBody(body: string): unknown {
  if (!body) return null
  const parsed = JSON.parse(body) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  // Key order matters: the harness emits model, messages, tools, stream,
  // stream_options, max_completion_tokens, store in that order.
  for (const [key, value] of Object.entries(parsed)) {
    out[key] = Array.isArray(value) ? "<ARRAY>" : normalizeScalar(value)
  }
  return out
}

function normalizeRequest(request: WireRequest) {
  const headers: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (name === "host" || name === "content-length") continue
    if (name === "accept-encoding" || name === "connection") headers[name] = "<RUNTIME>"
    else headers[name] = normalizeScalar(value)
  }
  return {
    method: request.method,
    url: normalizeScalar(request.url),
    headers,
    body: normalizeBody(request.body),
  }
}

// --- comparison --------------------------------------------------------------

function diff(expected: unknown, actual: unknown, trail: string, problems: string[]): void {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return
  const bothObjects =
    expected !== null && actual !== null &&
    typeof expected === "object" && typeof actual === "object" &&
    !Array.isArray(expected) && !Array.isArray(actual)
  if (bothObjects) {
    const keys = new Set([...Object.keys(expected as object), ...Object.keys(actual as object)])
    for (const key of keys)
      diff((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], `${trail}.${key}`, problems)
    return
  }
  problems.push(`${trail}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// --- scenario ----------------------------------------------------------------

async function main(): Promise<number> {
  const stub = await startStub()
  try {
    const base = `http://127.0.0.1:${PORT}/console`
    const provider = new OpencodeOAuthProvider({ server: base })

    const credentials = await provider.login({
      onAuth: () => undefined,
      onPrompt: async () => "",
    })
    const rotated = await provider.refreshToken(credentials)
    await fetchConsoleConfig(base, { token: rotated.access, orgId: rotated.orgId })
    await zenChatCompletion(
      {
        model: "mimo-v2.6-pro",
        messages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "hi" },
        ],
        tools: [{ type: "function", function: { name: "tool", parameters: {} } }],
        maxCompletionTokens: 131072,
      },
      {
        token: rotated.access,
        base: `http://127.0.0.1:${PORT}/zen/go/v1`,
        session: {
          session: `ses_${"e".repeat(26)}`,
          affinity: `ses_${"e".repeat(26)}`,
          project: "a".repeat(40),
          client: "cli",
        },
      },
    )

    // Limits + models + registration through the real extension seam.
    const registered: { name?: string; config?: ProviderConfig } = {}
    const fakePi = {
      registerProvider: (name: string, config: ProviderConfig) => {
        registered.name = name
        registered.config = config
      },
      on: () => undefined,
    } as unknown as ExtensionAPI
    registerOpencodeGo(fakePi)
    const config = registered.config
    const localProblems: string[] = []
    if (registered.name !== "opencode-go") localProblems.push(`registered provider ${registered.name} != opencode-go`)
    if (!config) localProblems.push("registerProvider got no config")
    if (config && config.baseUrl !== "https://opencode.ai/zen/go/v1")
      localProblems.push(`baseUrl ${config.baseUrl} != https://opencode.ai/zen/go/v1`)
    const mimo = config?.models?.find((model) => model.id === "mimo-v2.6-pro")
    if (!config?.models || config.models.length !== 36)
      localProblems.push(`catalog models ${config?.models?.length} != 36`)
    if (!mimo) localProblems.push("mimo-v2.6-pro missing from catalog")
    if (mimo && (mimo.contextWindow !== 1048576 || mimo.maxTokens !== 131072))
      localProblems.push(`mimo limits ${mimo.contextWindow}/${mimo.maxTokens} != 1048576/131072`)
    if (mimo && (mimo.cost.input !== 0.435 || mimo.cost.cacheRead !== 0.003625))
      localProblems.push(`mimo cost ${JSON.stringify(mimo.cost)} mis-mapped`)
    if (mimo && mimo.reasoning !== true) localProblems.push("mimo reasoning flag lost")
    if (!config?.oauth || !config?.usage || !config?.fetchDynamicModels)
      localProblems.push("config missing oauth/usage/fetchDynamicModels")

    const report = config?.usage
      ? await config.usage.fetchUsage(
          {
            provider: "opencode-go",
            credential: { type: "oauth", accessToken: rotated.access },
            baseUrl: `http://127.0.0.1:${PORT}/zen/go`,
          },
          { fetch },
        )
      : undefined
    if (!report) localProblems.push("usage fetch returned no report")
    const limits = report?.limits ?? []
    if (limits.length !== 3) localProblems.push(`usage limits ${limits.length} != 3`)
    const windowIds = limits.map((limit) => limit.window?.id).join(",")
    if (windowIds !== "5h,7d,monthly") localProblems.push(`window ids ${windowIds} != 5h,7d,monthly`)
    if (limits[0] && (limits[0].amount.usedFraction !== 0.42 || limits[0].status !== "ok" || limits[0].window?.durationMs !== 5 * 3600000))
      localProblems.push(`rolling window mis-mapped: ${JSON.stringify(limits[0])}`)
    if (limits[1] && limits[1].status !== "warning") localProblems.push(`weekly 85% status ${limits[1].status} != warning`)
    if (limits[2] && limits[2].window?.durationMs !== undefined) localProblems.push("monthly window must carry no duration")
    if (limits[2] && limits[2].window?.resetsAt !== Date.parse("2026-11-01T00:00:00.000Z"))
      localProblems.push(`monthly resetsAt ${limits[2].window?.resetsAt} unparsed`)

    const got = readTrace(LOG_PATH)
    const golden = readTrace(GOLDEN_PATH)

    // Golden: [0..7] login+refresh+config from one run, [8] config from the
    // inference run, [9] harness title-gen call (harness-only), [10] main turn.
    const pairs: Array<[WireRequest, WireRequest, string]> = [
      ...Array.from({ length: 8 }, (_, index) => [golden[index], got[index], `request ${index}`] as const),
      [golden[10], got[8], "request 8 (inference)"],
    ] as Array<[WireRequest, WireRequest, string]>

    const problems = [...localProblems, ...fingerprintChecks(got, "omp"), ...fingerprintChecks(golden, "harness")]
    for (const [expected, actual, label] of pairs) {
      if (!expected || !actual) {
        problems.push(`${label}: missing request (golden ${!!expected}, omp ${!!actual})`)
        continue
      }
      const before = problems.length
      diff(normalizeRequest(expected), normalizeRequest(actual), label, problems)
      if (problems.length === before) console.log(`MATCH  ${label}  ${expected.method} ${expected.url}`)
    }

    // Usage request has no golden (the harness never calls this route); check
    // its shape explicitly instead.
    const usage = got.find((request) => request.url.endsWith("/usage"))
    if (!usage) problems.push("usage request missing from trace")
    if (usage && (usage.method !== "GET" || usage.headers["accept"] !== "application/json" || !usage.headers["authorization"]?.startsWith("Bearer ") || !usage.headers["x-opencode-session"]))
      problems.push(`usage request shape wrong: ${usage.method} ${usage.url} ${JSON.stringify(usage.headers)}`)

    console.log(`\ngolden requests: ${golden.length}, omp requests: ${got.length}`)
    if (problems.length > 0) {
      console.error(`\nPARITY FAIL (${problems.length} problems):`)
      for (const problem of problems) console.error(`  ${problem}`)
      return 1
    }
    console.log("PARITY OK: omp trace is wire-identical to the harness trace (modulo random ids); limits + models + registration verified")
    return 0
  } finally {
    stub.kill()
  }
}

process.exit(await main())
