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
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import path from "node:path"
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"
import type { SimpleStreamOptions } from "@oh-my-pi/pi-ai"
import { registerCustomApi } from "@oh-my-pi/pi-ai/api-registry"
import { registerOAuthProvider, getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth"
import { OpencodeOAuthProvider } from "../src/opencode-provider"
import { registerOpencodeGo } from "../src/register"
import { deadModels } from "../src/dead-models"
import { providerOverride } from "../src/console-config"
import { fetchConsoleConfig, opencodeChatCompletion, opencodeChatCompletion as freeChat, type SessionIdentity } from "../src/wire"

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
  // Every HOME-derived path the wrapper touches (console-config cache,
  // models.yml, verdicts, …) must resolve INSIDE this test: wiping the prod
  // ~/.omp under a live session already cost one debugging incident (the real
  // per-org Console snapshots vanished mid-run).
  const home = mkdtempSync(path.join(tmpdir(), "omp-go-parity-home-"))
  const previousHome = process.env.HOME
  process.env.HOME = home
  mkdirSync(path.join(home, ".omp", "agent"), { recursive: true })
  // The Console-config cache persists per profile with a 60s TTL; clear it so
  // the login-time config fetch is always exercised (the golden trace has it).
  try {
    rmSync(path.join(homedir(), ".omp", "agent", "omp-go-console-config.json"), { force: true })
  } catch {}
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
    // Mirror the wrapper's request assembly: the Console config dictates the
    // endpoint and pushed headers, the credential supplies the org attribution.
    const override = providerOverride(rotated.orgId, "opencode-go")
    await freeChat(
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
        base: override.baseURL ?? `http://127.0.0.1:${PORT}/zen/go/v1`,
        orgId: rotated.orgId,
        session: {
          session: `ses_${"e".repeat(26)}`,
          affinity: `ses_${"e".repeat(26)}`,
          project: "a".repeat(40),
          client: "cli",
        },
      },
    )

    // Free-tier (Zen) turn: same fingerprint, config-driven /inference/openai
    // endpoint, no `store` field (matches the harness's free-model body).
    const zenOverride = providerOverride(rotated.orgId, "opencode")
    await freeChat(
      {
        model: "mimo-v2.6-flash-free",
        messages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "hi" },
        ],
        tools: [{ type: "function", function: { name: "tool", parameters: {} } }],
        maxCompletionTokens: 32000,
        omitStore: true,
      },
      {
        token: rotated.access,
        base: zenOverride.baseURL ?? `http://127.0.0.1:${PORT}/zen/v1`,
        orgId: rotated.orgId,
        session: {
          session: `ses_${"e".repeat(26)}`,
          affinity: `ses_${"e".repeat(26)}`,
          project: "a".repeat(40),
          client: "cli",
        },
      },
    )

    // Limits + models + registration through the real extension seam. The fake
    // `pi` mirrors the host's registerProvider internals (model-registry.ts):
    // registerCustomApi + registerOAuthProvider — so pi-ai's real validation,
    // including "built-in API names are reserved", runs here too. A config that
    // crashes omp startup fails this test instead.
    const registered = new Map<string, ProviderConfig>()
    const registeredTools = new Map<string, { name: string; description: string }>()
    let activeTools = ["read", "edit", "glob", "grep", "write"]
    const fakePi = {
      registerProvider: (name: string, config: ProviderConfig) => {
        registered.set(name, config)
        if (config.streamSimple && config.api) {
          const streamSimpleFn = config.streamSimple
          registerCustomApi(config.api, streamSimpleFn, "parity-test", (model, context, options) =>
            streamSimpleFn(model, context, options as SimpleStreamOptions),
          )
        }
        if (config.oauth) registerOAuthProvider({ ...config.oauth, id: name, sourceId: "parity-test" })
      },
      registerTool: (tool: { name: string; description: string }) => {
        registeredTools.set(tool.name, { name: tool.name, description: tool.description })
      },
      getActiveTools: () => [...activeTools],
      setActiveTools: (names: string[]) => {
        activeTools = [...names]
      },
      on: () => undefined,
    } as unknown as ExtensionAPI
    registerOpencodeGo(fakePi)
    const config = registered.get("opencode-go")
    const freeConfig = registered.get("opencode-free")
    const localProblems: string[] = []
    if (!config) localProblems.push("registerProvider got no opencode-go config")
    if (config && config.baseUrl !== "https://opencode.ai/zen/go/v1")
      localProblems.push(`baseUrl ${config.baseUrl} != https://opencode.ai/zen/go/v1`)
    const mimo = config?.models?.find((model) => model.id === "mimo-v2.6-pro")
    const catalogJson = JSON.parse(
      readFileSync(new URL("../src/models-catalog.json", import.meta.url), "utf8"),
    ) as { models: Record<string, { status?: string }> }
    // `catalogModels()` also filters the runtime-learned dead set
    // (src/dead-models.ts); derive the expectation through the same set so a
    // retirement learned on this machine is expected, not a regression.
    const dead = deadModels()
    const liveCount = Object.entries(catalogJson.models).filter(([id, m]) => m.status !== "deprecated" && !dead.has(id)).length
    if (!config?.models || config.models.length !== liveCount)
      localProblems.push(`catalog models ${config?.models?.length} != live count ${liveCount} (deprecated/dead filtered)`)
    if (!mimo) localProblems.push("mimo-v2.6-pro missing from catalog")
    if (mimo && (mimo.contextWindow !== 1048576 || mimo.maxTokens !== 131072))
      localProblems.push(`mimo limits ${mimo.contextWindow}/${mimo.maxTokens} != 1048576/131072`)
    if (mimo && (mimo.cost.input !== 0.435 || mimo.cost.cacheRead !== 0.003625))
      localProblems.push(`mimo cost ${JSON.stringify(mimo.cost)} mis-mapped`)
    if (mimo && mimo.reasoning !== true) localProblems.push("mimo reasoning flag lost")
    if (!config?.usage || !config?.fetchDynamicModels)
      localProblems.push("config missing usage/fetchDynamicModels")
    const listed = getOAuthProviders().find((entry) => entry.id === "opencode-free")
    if (!listed) localProblems.push("auth-broker listing missing 'opencode-free' login")
    if (listed && listed.storeCredentialsAs !== "opencode-go")
      localProblems.push(`login stores as ${listed.storeCredentialsAs} != opencode-go`)
    const freeOauth = freeConfig?.oauth as { storeCredentialsAs?: string } | undefined
    if (!freeConfig) localProblems.push("registerProvider got no opencode-free config")
    if (freeConfig && freeConfig.apiKey !== "public")
      localProblems.push(`opencode-free apiKey ${freeConfig.apiKey} != public (keyless free tier)`)
    if (freeConfig && freeConfig.baseUrl !== "https://opencode.ai/inference/v1")
      localProblems.push(`opencode-free baseUrl ${freeConfig.baseUrl} != https://opencode.ai/inference/v1`)
    const freeIds = new Set((freeConfig?.models ?? []).map((model) => model.id))
    if (freeIds.size === 0) localProblems.push("opencode-free registers no models")
    for (const id of freeIds) {
      const cost = (catalogJson as { models: Record<string, { cost?: { input?: number } | Array<{ input?: number }> }> }).models[id]
      const tiers = Array.isArray(cost?.cost) ? cost.cost : [cost?.cost]
      if (tiers.some((tier) => Number(tier?.input ?? 0) > 0))
        localProblems.push(`opencode-free includes paid model ${id} (harness free tier is zero-cost only)`)
    }
    if (freeOauth && freeOauth.storeCredentialsAs !== "opencode-go")
      localProblems.push(`free oauth storeCredentialsAs ${freeOauth.storeCredentialsAs} != opencode-go`)

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

    // Golden: [0..5] login identity flow, [6..8] refresh + two config fetches
    // (login-time and session-start, order varies), [9] harness title-gen call
    // (harness-only), [10] main inference turn.
    const goldenFreeChats = golden.filter((row) => row.url.includes("/inference/openai/") && row.url.includes("chat"))
    const pairs: Array<[WireRequest, WireRequest, string]> = [
      ...Array.from({ length: 6 }, (_, index) => [golden[index], got[index], `request ${index}`] as const),
      [golden[10], got.find((row) => row.url.includes("/inference/go/")) as WireRequest, "request (go inference)"],
      [
        goldenFreeChats[0],
        got.filter((row) => row.url.includes("/inference/openai/")).at(-1) as WireRequest,
        "request (free-tier inference)",
      ],
    ] as Array<[WireRequest, WireRequest, string]>

    const problems = [...localProblems, ...fingerprintChecks(got, "omp"), ...fingerprintChecks(golden, "harness")]
    // The refresh + config segment is order-insensitive (login-time config warm
    // vs harness's refresh-first ordering); compare as a normalized multiset.
    const sortedSegment = (rows: WireRequest[]) =>
      rows.map((row) => JSON.stringify(normalizeRequest(row))).toSorted()
    diff(
      sortedSegment(golden.slice(6, 9)),
      sortedSegment(got.slice(6, 9)),
      "refresh+config segment",
      problems,
    )
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
    // The login flow persists the stub Console-config snapshot into the profile.
    // Left behind, it points a later real-gateway free-lane run at this dead
    // stub; drop it so the next run falls back to the catalog endpoints.
    try {
      rmSync(path.join(homedir(), ".omp", "agent", "omp-go-console-config.json"), { force: true })
    } catch {}
    process.env.HOME = previousHome
  }
}

process.exit(await main())
