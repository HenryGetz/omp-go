// E2E (interactive TUI, via @microsoft/tui-test): account verdicts must route
// around a billing-dry account INSIDE the interactive surface, where the
// turn-recovery retry saga lives (its "Retry failed: Provider requested …ms
// wait" path never runs under `omp run --print` — see test/e2e/routing.mjs for
// the non-interactive proof).
//
// The composer's submit gate does not lift under the PTY harness, so the
// turn is kicked off the way the launcher supports: `omp "<message>"` starts
// the interactive TUI WITH a first turn.
//
// Run: node test/e2e/tui-funds.mjs

import { spawn, execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { TuiTest } from "@microsoft/tui-test"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..", "..")
const OMP = process.env.OMP_BIN ?? "omp"
const PORT = Number(process.env.E2E_STUB_PORT ?? 19131)
const STUB_URL = `http://127.0.0.1:${PORT}`

const home = mkdtempSync(path.join(tmpdir(), "omp-go-tuifunds-"))
const stubLog = path.join(home, "stub-requests.ndjson")
mkdirSync(path.join(home, "project"), { recursive: true })

const env = {
  ...process.env,
  HOME: home,
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_STATE_HOME: path.join(home, ".local", "state"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  OMP_GO_CONSOLE: `${STUB_URL}/console`,
  OMP_GO_BASE: `${STUB_URL}/zen/go/v1`,
}
delete env.OPENCODE_API_KEY

mkdirSync(path.join(home, ".omp", "agent"), { recursive: true })
writeFileSync(
  path.join(home, ".omp", "agent", "config.yml"),
  ["setupVersion: 2", "modelRoles:", "  default: opencode-go/mimo-v2.6-pro", ""].join("\n"),
)

const stub = spawn("node", [path.join(REPO, "capture", "stub-console.mjs")], {
  env: {
    ...env,
    STUB_LOG: stubLog,
    STUB_PORT: String(PORT),
    STUB_USAGE_BY_ACCOUNT: JSON.stringify({
      1: { rolling: 5, weekly: 10, monthly: 10 },
      2: { rolling: 5, weekly: 10, monthly: 10 },
    }),
    // deepseek-v4.1-flash is the acceptance model here; the region gate is
    // multi-account's scenario and must not interfere.
    STUB_REGION_GATED_ACCOUNT: "99",
  },
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

async function login(label) {
  const terminal = TuiTest.ephemeral(`omp-go-tuifunds-login-${label}`)
  try {
    await terminal.run(OMP, ["login", "opencode-free"], { env, cwd: REPO, cols: 140, rows: 42, timeout: 120_000 })
    await terminal.waitExit({ timeout: 90_000 }).catch(() => undefined)
    return ((await terminal.getOutput().catch(() => "")) ?? "") + (await terminal.text({ full: true }).catch(() => ""))
  } finally {
    await terminal.closeQuiet()
  }
}

// Interactive TUI with a kickoff turn (the composer's submit gate does not
// lift under the harness; the launcher message starts the turn itself).
// `cont` resumes the PREVIOUS session (--continue) — the acceptance case is a
// session whose pinned account goes dry mid-conversation.
async function tuiTurn(label, cont = false) {
  const terminal = TuiTest.ephemeral(`omp-go-tuifunds-${label}`)
  const args = cont
    ? ["--continue", "say ok again"]
    : ["--model=opencode-go/deepseek-v4.1-flash", "say ok"]
  try {
    await terminal.run(OMP, args, {
      env,
      cwd: path.join(home, "project"),
      cols: 140,
      rows: 42,
      timeout: 240_000,
    })
    // The turn runs inside the TUI: wait for the stub's reply to land on screen.
    const deadline = Date.now() + 180_000
    let screen = ""
    while (Date.now() < deadline) {
      screen = await terminal.text({ full: true }).catch(() => "")
      if (screen.includes("Hello from stub") || screen.includes("Retry failed")) break
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
    return screen
  } finally {
    await terminal.closeQuiet()
  }
}

async function setUsage(account, percent) {
  await fetch(`${STUB_URL}/control/usage`, {
    method: "POST",
    body: JSON.stringify({ account, rolling: percent, weekly: percent, monthly: percent }),
  })
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      execFileSync(
        OMP,
        ["usage", "-p", "opencode-go", "--json", "--extension", path.join(REPO, "src", "index.ts")],
        { env, encoding: "utf8", timeout: 90_000 },
      )
    } catch {}
    if (routingUsed(account) === percent / 100) return
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
}

function routingUsed(account) {
  const file = path.join(home, ".omp", "agent", "omp-go-routing.json")
  if (!existsSync(file)) return undefined
  const org = account === 1 ? "org_42" : "org_44"
  try {
    const state = JSON.parse(readFileSync(file, "utf8"))
    return state[org]?.usedPct
  } catch {
    return undefined
  }
}

function chatBearers(from) {
  const rows = existsSync(stubLog)
    ? readFileSync(stubLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
  return rows
    .slice(from)
    .filter((request) => request.url.includes("chat/completions"))
    .map((request) => String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, ""))
}
const mark = () => (existsSync(stubLog) ? readFileSync(stubLog, "utf8").split("\n").filter(Boolean).length : 0)

try {
  const first = await login("one")
  note(first.includes("stub@example.com"), `account 1 logged in (${first.match(/as [^\n]+/)?.[0] ?? "?"})`)
  const second = await login("two")
  note(second.includes("stub2@example.com"), `account 2 logged in (${second.match(/as [^\n]+/)?.[0] ?? "?"})`)

  // Force the routing pin onto account 1, then dry its billing mid-pool.
  await setUsage(1, 5)
  await setUsage(2, 95)
  await fetch(`${STUB_URL}/control/funds`, { method: "POST", body: JSON.stringify({ account: 1, dry: true }) })

  // 1. The acceptance case: opencode-go/deepseek-v4.1-flash in the interactive
  // TUI must ROUTE AROUND the dry account instead of surfacing the
  // turn-recovery "Retry failed: Provider requested …ms wait" abort.
  const beforeTurn = mark()
  const screen = await tuiTurn("turn")
  const turn = chatBearers(beforeTurn)
  note(
    !screen.includes("Retry failed"),
    "deepseek TUI turn surfaces no 'Retry failed' wait-hint abort",
  )
  note(screen.includes("Hello from stub"), "deepseek TUI turn completes with the stub's reply")
  note(
    turn.length >= 2 && turn.some((bearer) => bearer === "at_stub_101") && turn.at(-1) === "at_stub_102",
    `deepseek TUI turn rotates to the healthy sibling (${turn.join(", ") || "none"})`,
  )

  // 2. A fresh interactive process also starts on the healthy account —
  // the verdict persisted across processes even though the dry account's
  // quota looks fine.
  const beforeFresh = mark()
  await tuiTurn("fresh")
  const fresh = chatBearers(beforeFresh)
  note(
    fresh.length > 0 && fresh[0] === "at_stub_102",
    `fresh TUI process avoids the verdict'd account (${fresh.join(", ") || "none"})`,
  )
} finally {
  stub.kill()
}

if (problems.length > 0) {
  console.error(`\nTUI FUNDS E2E FAILED (${problems.length}):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log("\nTUI FUNDS E2E OK: interactive turns rotate around a dry account and stay rotated")
