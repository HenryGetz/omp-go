// E2E: real omp + omp-go plugin + stub Console, driven with @microsoft/tui-test.
// Proves end to end: the plugin installs, omp starts with it (this crashed
// before the custom-API fix), `omp login` runs the Console device flow against
// the stub, a real chat turn routes through the Go gateway, the wire carries
// the harness fingerprint, and `omp usage` reports the limit windows.
//
// Notes on environment: omp loads plugins from the real ~/.omp/plugins
// regardless of $HOME (agent state isolates, plugins do not), so the install
// step runs against the real plugin dir while login/chat/usage run against an
// isolated profile. The TUI composer keystroke path is not exercised: its
// bootstrap submit gate never lifts under this PTY harness, with or without
// the plugin.
//
// Run: node test/e2e/e2e.mjs   (E2E_DUMP=1 to print screens at each step)

import { spawn, execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { TuiTest } from "@microsoft/tui-test"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..", "..")
const OMP = process.env.OMP_BIN ?? "omp"
const PORT = Number(process.env.E2E_STUB_PORT ?? 18990)
const STUB_URL = `http://127.0.0.1:${PORT}`
const DUMP = process.env.E2E_DUMP === "1"
const PROVIDER = "OpenCode Console (shared account)"

const home = mkdtempSync(path.join(tmpdir(), "omp-go-e2e-"))
const workdir = path.join(home, "project")
const stubLog = path.join(home, "stub-requests.ndjson")
mkdirSync(workdir, { recursive: true })

const env = {
  ...process.env,
  HOME: home,
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_STATE_HOME: path.join(home, ".local", "state"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  OMP_GO_CONSOLE: `${STUB_URL}/console`,
  OMP_GO_BASE: `${STUB_URL}/zen/go/v1`,
  // Bootstrap key so a model exists before the OAuth login (omp's composer is
  // inert with "No model selected"). Stored /login credentials take precedence
  // over env keys, so the chat still exercises the OAuth path.
  OPENCODE_API_KEY: "stub-env-key",
}

// Fresh profile config: skip onboarding, default the session to a Go model.
mkdirSync(path.join(home, ".omp", "agent"), { recursive: true })
writeFileSync(
  path.join(home, ".omp", "agent", "config.yml"),
  ["setupVersion: 2", "modelRoles:", "  default: opencode-go/mimo-v2.6-pro", ""].join("\n"),
)

const stub = spawn("node", [path.join(REPO, "capture", "stub-console.mjs")], {
  env: { ...env, STUB_LOG: stubLog, STUB_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "inherit"],
})
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("stub did not start")), 10_000)
  stub.stdout.on("data", (chunk) => {
    if (chunk.toString().includes("listening")) {
      clearTimeout(timer)
      resolve()
    }
  })
})

const problems = []
const note = (ok, message) => {
  if (!ok) problems.push(message)
  console.log(`${ok ? "ok  " : "FAIL"}  ${message}`)
}
const stubRequests = () =>
  existsSync(stubLog)
    ? readFileSync(stubLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

// Each step gets its own terminal: tui-test's run() does not replace the
// program of an already-running session.
async function inTerminal(label, args, fn) {
  const terminal = TuiTest.ephemeral(`omp-go-e2e-${label}`)
  try {
    return await fn(terminal, async () => {
      const text = await terminal.text({ full: true })
      if (DUMP || problems.length > 0) console.log(`--- ${label} ---\n${text}\n---`)
      return text
    })
  } finally {
    await terminal.closeQuiet()
  }
}

try {
  // 1. Plugin installs via omp's own command into the real plugin dir.
  const install = execFileSync(OMP, ["plugin", "install", REPO], { encoding: "utf8" })
  console.log(install.trim().split("\n").slice(-3).join("\n"))
  const listed = execFileSync(OMP, ["plugin", "list"], { encoding: "utf8" })
  note(listed.includes("omp-go"), "omp plugin list shows omp-go")

  // 2. The TUI starts with the plugin loaded and the Go model selected.
  await inTerminal("startup", [], async (terminal, dump) => {
    await terminal.run(OMP, [], { env, cwd: workdir, cols: 140, rows: 42, timeout: 60_000 })
    // Poll rather than getByText: catalog materialization (our modifyModels)
    // makes cold startup exceed the locator's default text timeout.
    const waitFor = async (needle, timeoutMs) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if ((await terminal.text({ full: true })).includes(needle)) return true
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      return false
    }
    await waitFor("v18.9.1", 60_000)
    await waitFor("MiMo-V2.6-Pro", 30_000)
    const startup = await dump()
    note(!startup.includes("Cannot register custom API"), "omp starts without custom-API crash")
    note(startup.includes("MiMo-V2.6-Pro") && !startup.includes("no-model"), "status bar shows the opencode-go model")
  })

  // 3. OAuth login: omp's terminal counterpart of /login (same AuthStorage
  // dispatch, loads extension providers) against the stub Console.
  await inTerminal("login", [], async (terminal, dump) => {
    await terminal.run(OMP, ["login", "opencode-free"], { env, cwd: REPO, cols: 140, rows: 42, timeout: 120_000 })
    await terminal.waitExit({ timeout: 90_000 }).catch(() => undefined)
    const out = (await terminal.getOutput().catch(() => "")) ?? (await terminal.text({ full: true }))
    if (!out.trim()) await dump()
    note(out.includes("Enter code: ABCD-1234"), "device flow shows the user code")
    note(out.includes("Logged in to") && out.includes(PROVIDER), `login completed: 'Logged in to ${PROVIDER}'`)
    note(out.includes("stub@example.com"), "login reports the authenticated account")
  })

  // 4. A real chat turn through the Go gateway (omp run = the non-interactive
  // session path; same model pipeline the TUI uses).
  await inTerminal("chat", [], async (terminal, dump) => {
    await terminal.run(OMP, ["run", "--print", "--no-title", "--model=opencode-go/mimo-v2.6-pro", "hi"], {
      env,
      cwd: REPO,
      cols: 140,
      rows: 42,
      timeout: 120_000,
    })
    await terminal.waitExit({ timeout: 90_000 }).catch(() => undefined)
    const out = (await terminal.getOutput().catch(() => "")) ?? (await terminal.text({ full: true }))
    if (!out.trim()) await dump()
    note(out.includes("Hello from stub"), "chat turn returns gateway completion")
  })

  // 4b. Free-lane reasoning mapping: an effort-capable free model carries the
  // max rung; a model without an effort surface carries nothing (harness).
  // The free models resolve through the extension's own registration (unlike
  // the bundled go lane), so this is its own wire proof.
  for (const [label, model] of [
    ["chat-free-effort", "space-bunny-free"],
    ["chat-free-plain", "mimo-v2.6-flash-free"],
  ]) {
    await inTerminal(label, [], async (terminal, dump) => {
      await terminal.run(OMP, ["run", "--print", "--no-title", `--model=opencode-free/${model}`, "hi"], {
        env,
        cwd: REPO,
        cols: 140,
        rows: 42,
        timeout: 120_000,
      })
      await terminal.waitExit({ timeout: 90_000 }).catch(() => undefined)
      const out = (await terminal.getOutput().catch(() => "")) ?? (await terminal.text({ full: true }))
      if (!out.trim()) await dump()
    })
  }

  // 5. The wire carries the harness fingerprint.
  const requests = stubRequests()
  const device = requests.find((request) => request.url.endsWith("/auth/device/code"))
  note(Boolean(device), "login hit POST /auth/device/code")
  if (device) {
    note(device.headers["user-agent"] === "opencode/latest/2.0.26/cli", `device UA ${device.headers["user-agent"]}`)
    note(device.body.includes('"client_id":"opencode-cli"'), "device body carries opencode-cli client_id")
  }
  const polls = requests.filter((request) => request.url.endsWith("/auth/device/token"))
  note(polls.length >= 3, `device token polled ${polls.length}x (pending → success)`)
  // The Go-lane chat, not the free-lane chats added below (which omit `store`).
  const chat = requests
    .filter((request) => request.url.endsWith("/chat/completions") && request.url.includes("/go/"))
    .at(-1)
  note(Boolean(chat), "chat hit POST /zen/go/v1/chat/completions")
  if (chat) {
    note(chat.headers["user-agent"] === "opencode/latest/2.0.26/cli", `chat UA ${chat.headers["user-agent"]}`)
    // pi-ai force-sets x-opencode-session to omp's own session UUID (its
    // native attribution; the gateway accepts it) — shape differs from the
    // harness's ses_ but is present, consistent, and required-by-upstream.
    const session = chat.headers["x-opencode-session"]
    note(
      typeof session === "string" && (session.startsWith("ses_") || /^[0-9a-f-]{36}$/.test(session)),
      `chat session ${session}`,
    )
    note(/^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/.test(chat.headers["b3"] ?? ""), "chat b3 header shaped")
    note(chat.headers["authorization"]?.startsWith("Bearer ") ?? false, "chat carries bearer auth")
    note(!("x-org-id" in chat.headers), "chat omits x-org-id (harness behavior)")
    const body = JSON.parse(chat.body)
    note(
      body.stream === true && body.store === false && body.stream_options?.include_usage === true,
      "chat body: stream/store/stream_options match harness shape",
    )
    note(body.reasoning_effort === undefined, "go non-effort model carries no reasoning fields")
  }

  // Free-lane reasoning bodies (models resolved via the extension's own
  // registration): the effort model carries its MAX rung, the rest stay clean.
  const bodies = requests
    .filter((request) => request.url.endsWith("/chat/completions"))
    .map((request) => JSON.parse(request.body))
  const freeEffort = bodies.find((body) => body.model === "space-bunny-free")
  note(
    freeEffort?.reasoning_effort === "max",
    `free effort model carries reasoning_effort=max (got ${JSON.stringify(freeEffort?.reasoning_effort)})`,
  )
  const freePlain = bodies.find((body) => body.model === "mimo-v2.6-flash-free")
  note(
    freePlain !== undefined &&
      freePlain.reasoning_effort === undefined &&
      freePlain.reasoning === undefined,
    "free non-effort model carries no reasoning fields",
  )

  // Free-lane tool surface: the keyless gateway fingerprints the request's
  // `tools` array, so every free chat must carry exactly the harness's 12
  // definitions (src/tool-mirror.ts). Compare against the captured asset so a
  // drift fails here rather than as a live FreeTierError.
  const harnessTools = JSON.parse(readFileSync(path.join(REPO, "capture", "harness-tools.json"), "utf8"))
  const freeBodies = bodies.filter((body) => typeof body.model === "string" && body.model.endsWith("-free"))
  note(freeBodies.length >= 2, `free-lane chat bodies captured (${freeBodies.length})`)
  for (const body of freeBodies) {
    note(
      body.tools !== undefined && JSON.stringify(body.tools) === JSON.stringify(harnessTools),
      `free body ${body.model} carries the exact 12-tool harness surface`,
    )
  }

  // 6. `omp usage` reports the limit windows (extension loaded explicitly so
  // the CLI process uses our usage fetcher rather than only the cache).
  try {
    const usage = execFileSync(
      OMP,
      ["usage", "-p", "opencode-go", "--json", "--extension", path.join(REPO, "src", "index.ts")],
      { env, encoding: "utf8", timeout: 60_000 },
    )
    note(
      usage.includes("5h") && usage.includes("7d") && usage.includes("monthly"),
      "omp usage reports 5h/weekly/monthly windows",
    )
  } catch (error) {
    note(false, `omp usage failed: ${String(error.stderr ?? error.message).split("\n").filter(Boolean).at(-1)}`)
  }
} catch (error) {
  problems.push(`e2e crashed: ${error?.message ?? error}`)
  console.error(error)
} finally {
  stub.kill()
}

console.log(`\nprofile kept at ${home}`)
if (problems.length > 0) {
  console.error(`E2E FAIL (${problems.length}):`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log("E2E OK")
