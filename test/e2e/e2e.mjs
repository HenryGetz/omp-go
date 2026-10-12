// E2E: real omp + omp-go plugin + stub Console, driven through the TUI with
// @microsoft/tui-test. Proves end to end: the plugin installs, omp starts
// without crashing, `/login` runs the device flow against the stub, a chat turn
// routes through the Go gateway, and the wire carries the harness fingerprint.
//
// Run: node test/e2e/e2e.mjs   (E2E_DUMP=1 to print screens at each step)

import { spawn, execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
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
const screen = async (terminal, label) => {
  const text = await terminal.text({ full: true })
  if (DUMP || problems.length > 0) console.log(`--- screen: ${label} ---\n${text}\n---`)
  return text
}
const stubRequests = () =>
  existsSync(stubLog)
    ? readFileSync(stubLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

const terminal = TuiTest.ephemeral("omp-go-e2e")
try {
  // 1. Plugin installs into an isolated profile via omp's own command.
  const install = execFileSync(OMP, ["plugin", "install", REPO], { env, encoding: "utf8" })
  console.log(install.trim().split("\n").slice(-3).join("\n"))
  const listed = execFileSync(OMP, ["plugin", "list"], { env, encoding: "utf8" })
  note(listed.includes("omp-go"), "omp plugin list shows omp-go")

  // 2. The TUI starts with the plugin loaded (this crashed before the fix).
  await terminal.run(OMP, [], { env, cwd: workdir, cols: 140, rows: 42, timeout: 60_000 })
  await terminal.waitIdle({ timeout: 30_000 }).catch(() => undefined)
  const startup = await screen(terminal, "startup")
  note(!startup.includes("Cannot register custom API"), "omp starts without custom-API crash")
  note(startup.toLowerCase().includes("opencode-go"), "status bar shows the opencode-go model")

  // 3. /login runs the device flow against the stub.
  await terminal.submit("/login opencode-go")
  await terminal.waitIdle({ timeout: 15_000 }).catch(() => undefined)
  const picker = await screen(terminal, "login picker")
  note(picker.includes(PROVIDER), "login selector lists the Go subscription")
  await terminal.press("Enter")
  await terminal.getByText(" logged in", { timeout: 45_000 }).expect().catch(async () => {
    await screen(terminal, "login did not reach 'logged in'")
  })
  const afterLogin = await screen(terminal, "after login")
  note(afterLogin.includes(" logged in"), "device flow completed: 'logged in'")
  await terminal.press("Escape").catch(() => undefined)

  // 4. A chat turn through the gateway returns the stub completion.
  await terminal.submit("hi")
  await terminal.getByText("Hello from stub", { timeout: 45_000 }).expect().catch(async () => {
    await screen(terminal, "chat did not complete")
  })
  const afterChat = await screen(terminal, "after chat")
  note(afterChat.includes("Hello from stub"), "chat turn returns gateway completion")

  // 5. The wire carries the harness fingerprint.
  const requests = stubRequests()
  const device = requests.find((request) => request.url.endsWith("/auth/device/code"))
  note(Boolean(device), "login hit POST /auth/device/code")
  if (device) {
    note(device.headers["user-agent"] === "opencode/latest/2.0.26/cli", `device UA ${device.headers["user-agent"]}`)
    note(device.body.includes('"client_id":"opencode-cli"'), "device body carries opencode-cli client_id")
  }
  const chat = requests.filter((request) => request.url.endsWith("/chat/completions")).at(-1)
  note(Boolean(chat), "chat hit POST /zen/go/v1/chat/completions")
  if (chat) {
    note(chat.headers["user-agent"] === "opencode/latest/2.0.26/cli", `chat UA ${chat.headers["user-agent"]}`)
    note(typeof chat.headers["x-opencode-session"] === "string" && chat.headers["x-opencode-session"].startsWith("ses_"), `chat session ${chat.headers["x-opencode-session"]}`)
    note(/^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/.test(chat.headers["b3"] ?? ""), "chat b3 header shaped")
    note(chat.headers["authorization"]?.startsWith("Bearer ") ?? false, "chat carries bearer auth")
    note(!("x-org-id" in chat.headers), "chat omits x-org-id (harness behavior)")
    const body = JSON.parse(chat.body)
    note(body.stream === true && body.store === false && body.stream_options?.include_usage === true, "chat body: stream/store/stream_options match harness shape")
  }

  // 6. `omp usage` reports the limit windows for the stored credential.
  const usage = execFileSync(OMP, ["usage", "-p", "opencode-go", "--json"], { env, encoding: "utf8", timeout: 60_000 })
  note(usage.includes("5h") && usage.includes("7d") && usage.includes("monthly"), "omp usage reports 5h/weekly/monthly windows")
} catch (error) {
  problems.push(`e2e crashed: ${error?.message ?? error}`)
  try {
    await screen(terminal, "crash")
  } catch {}
  console.error(error)
} finally {
  await terminal.closeQuiet()
  stub.kill()
}

console.log(`\nprofile kept at ${home}`)
if (problems.length > 0) {
  console.error(`E2E FAIL (${problems.length}):`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log("E2E OK")
