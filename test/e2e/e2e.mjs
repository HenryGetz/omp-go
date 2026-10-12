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
const PROVIDER = "OpenCode Console (Go subscription)"

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
  OMP_GO_ZEN: `${STUB_URL}/zen/go/v1`,
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
    await terminal.getByText("v18.9.1", { timeout: 30_000 }).expect()
    await terminal.getByText("MiMo-V2.6-Pro", { timeout: 30_000 }).expect().catch(() => undefined)
    const startup = await dump()
    note(!startup.includes("Cannot register custom API"), "omp starts without custom-API crash")
    note(startup.includes("MiMo-V2.6-Pro") && !startup.includes("no-model"), "status bar shows the opencode-go model")
  })

  // 3. OAuth login: omp's terminal counterpart of /login (same AuthStorage
  // dispatch, loads extension providers) against the stub Console.
  await inTerminal("login", [], async (terminal, dump) => {
    await terminal.run(OMP, ["login", "opencode"], { env, cwd: REPO, cols: 140, rows: 42, timeout: 120_000 })
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
  const chat = requests.filter((request) => request.url.endsWith("/chat/completions")).at(-1)
  note(Boolean(chat), "chat hit POST /zen/go/v1/chat/completions")
  if (chat) {
    note(chat.headers["user-agent"] === "opencode/latest/2.0.26/cli", `chat UA ${chat.headers["user-agent"]}`)
    note(
      typeof chat.headers["x-opencode-session"] === "string" && chat.headers["x-opencode-session"].startsWith("ses_"),
      `chat session ${chat.headers["x-opencode-session"]}`,
    )
    note(/^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/.test(chat.headers["b3"] ?? ""), "chat b3 header shaped")
    note(chat.headers["authorization"]?.startsWith("Bearer ") ?? false, "chat carries bearer auth")
    note(!("x-org-id" in chat.headers), "chat omits x-org-id (harness behavior)")
    const body = JSON.parse(chat.body)
    note(
      body.stream === true && body.store === false && body.stream_options?.include_usage === true,
      "chat body: stream/store/stream_options match harness shape",
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
