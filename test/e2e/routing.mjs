// E2E: cache-strategic account routing (src/routing.ts) against the real omp
// credential pool. Three behaviors, in order:
//
//   1. Consolidation — new sessions join the warm leader (the account that
//      served last) even when the sibling has more headroom. Scattering chats
//      across accounts re-cold-starts the prompt cache on each hop.
//   2. Drain — once pinned, a session keeps its account even after that
//      account passes the spill threshold: its prompt cache is warm there.
//   3. Spill — brand-new sessions start on the sibling once the leader is
//      near-full (90% of its worst window), so they never build cache on an
//      account about to stop serving.
//
// Run: node test/e2e/routing.mjs

import { spawn, execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { TuiTest } from "@microsoft/tui-test"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..", "..")
const OMP = process.env.OMP_BIN ?? "omp"
const PORT = Number(process.env.E2E_STUB_PORT ?? 18993)
const STUB_URL = `http://127.0.0.1:${PORT}`

const home = mkdtempSync(path.join(tmpdir(), "omp-go-routing-"))
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

// Both accounts start with plenty of headroom (worst window 10% used).
const stub = spawn("node", [path.join(REPO, "capture", "stub-console.mjs")], {
  env: {
    ...env,
    STUB_LOG: stubLog,
    STUB_PORT: String(PORT),
    STUB_USAGE_BY_ACCOUNT: JSON.stringify({
      1: { rolling: 5, weekly: 10, monthly: 10 },
      2: { rolling: 5, weekly: 10, monthly: 10 },
    }),
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
  const terminal = TuiTest.ephemeral(`omp-go-routing-login-${label}`)
  try {
    await terminal.run(OMP, ["login", "opencode-free"], { env, cwd: REPO, cols: 140, rows: 42, timeout: 120_000 })
    await terminal.waitExit({ timeout: 90_000 }).catch(() => undefined)
    const raw = (await terminal.getOutput().catch(() => "")) ?? ""
    const screen = await terminal.text({ full: true }).catch(() => "")
    return [raw, screen].join("\n")
  } finally {
    await terminal.closeQuiet()
  }
}

async function chat(label, prompt = "hi") {
  const terminal = TuiTest.ephemeral(`omp-go-routing-chat-${label}`)
  try {
    await terminal.run(OMP, ["run", "--print", "--no-title", "--model=opencode-go/mimo-v2.6-pro", prompt], {
      env,
      cwd: REPO,
      cols: 140,
      rows: 42,
      timeout: 120_000,
    })
    await terminal.waitExit({ timeout: 110_000 }).catch(() => undefined)
    return (await terminal.getOutput().catch(() => "")) ?? ""
  } finally {
    await terminal.closeQuiet()
  }
}

async function chatContinue(label, prompt) {
  const terminal = TuiTest.ephemeral(`omp-go-routing-cont-${label}`)
  try {
    await terminal.run(OMP, ["run", "--print", "--no-title", "--continue", prompt], {
      env,
      cwd: REPO,
      cols: 140,
      rows: 42,
      timeout: 120_000,
    })
    await terminal.waitExit({ timeout: 110_000 }).catch(() => undefined)
    return (await terminal.getOutput().catch(() => "")) ?? ""
  } finally {
    await terminal.closeQuiet()
  }
}

// Flip an account's billing to dry (402 + the gateway's ~27-min wait hint).
async function setFunds(account, dry) {
  await fetch(`${STUB_URL}/control/funds`, {
    method: "POST",
    body: JSON.stringify({ account, dry }),
  })
}

// Change one account's windows at the stub, then refresh usage so the router's
// state (written by the provider's own usage poll) reflects it.
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
    } catch {
      // transient probe failure: retry below
    }
    if (routingUsed(account) === percent / 100) return
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  problems.push(`usage for account ${account} never reached ${percent}%`)
}

// The router's persisted state (src/routing.ts sidecar) in this test's HOME.
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
const mark = () =>
  existsSync(stubLog) ? readFileSync(stubLog, "utf8").split("\n").filter(Boolean).length : 0

try {
  // 1. Two accounts in the pool.
  const first = await login("one")
  note(first.includes("stub@example.com"), `account 1 logged in (${first.match(/as [^\n]+/)?.[0] ?? "?"})`)
  const second = await login("two")
  note(second.includes("stub2@example.com"), `account 2 logged in (${second.match(/as [^\n]+/)?.[0] ?? "?"})`)

  // 2. Seed the router's usage state for both accounts.
  await setUsage(1, 10)
  await setUsage(2, 10)
  note(routingUsed(1) === 0.1 && routingUsed(2) === 0.1, "router knows both accounts' usage")

  // 3. Consolidation: the first chat establishes the warm leader; the second
  // follows it onto the SAME account even after the sibling is made emptier —
  // the emptiest-first pooler would have hopped to account 2 here.
  // Report-only: output capture under the PTY harness is unreliable (the
  // routing guarantees are asserted against the stub capture below).
  const warm1 = await chat("warm-1")
  console.log(`info  chat 1 output: ${JSON.stringify(warm1.trim().slice(-80))}`)
  const afterWarm1 = mark()
  await setUsage(2, 2)
  await chat("warm-2")
  const warmBearers = chatBearers(afterWarm1)
  note(
    warmBearers.length > 0 && warmBearers.every((bearer) => bearer === "at_stub_101"),
    `new sessions consolidate on the warm leader (${[...new Set(warmBearers)].join(", ") || "none"})`,
  )

  // 4. Drain: a session already pinned to the leader keeps serving on it after
  // the leader crosses the spill threshold — its prompt cache is warm there.
  const drain1 = await chat("drain-1")
  console.log(`info  drain turn 1 output: ${JSON.stringify(drain1.trim().slice(-80))}`)
  const afterDrain1 = mark()
  await setUsage(1, 95)
  await chatContinue("drain-2", "and one more")
  const drainBearers = chatBearers(afterDrain1)
  note(
    drainBearers.length > 0 && drainBearers.every((bearer) => bearer === "at_stub_101"),
    `pinned session drains the near-full account (${[...new Set(drainBearers)].join(", ") || "none"})`,
  )

  // 5. Spill: a brand-new session now starts on the sibling instead of
  // building prompt cache on an account about to stop serving.
  const afterDrain2 = mark()
  await chat("spill-1")
  const spillBearers = chatBearers(afterDrain2)
  note(
    spillBearers.length > 0 && spillBearers.every((bearer) => bearer === "at_stub_102"),
    `new sessions spill to the sibling at 90% (${[...new Set(spillBearers)].join(", ") || "none"})`,
  )

  // 6. Account verdicts (402 funds): the turn must rotate to the healthy
  // sibling instead of dying on the gateway's ~27-min wait hint, and the
  // verdict must survive across processes — every chat here is a fresh omp,
  // and the dry account's quota still looks fine.
  await setUsage(1, 5)
  await setUsage(2, 95) // force the next pin onto the (about to be) dry account
  await setFunds(1, true)
  const afterFundsOn = mark()
  await chat("funds-1")
  const fundsTurn = chatBearers(afterFundsOn)
  note(
    fundsTurn.length >= 2 && fundsTurn[0] === "at_stub_101" && fundsTurn.at(-1) === "at_stub_102",
    `funds turn rotates to the healthy sibling (${fundsTurn.join(", ") || "none"})`,
  )
  const afterFundsOff = mark()
  await chat("funds-2")
  const freshTurn = chatBearers(afterFundsOff)
  note(
    freshTurn.length > 0 && freshTurn[0] === "at_stub_102",
    `new session avoids the verdict'd account across processes (${freshTurn.join(", ") || "none"})`,
  )
  await setFunds(1, false)
} finally {
  stub.kill()
}

if (problems.length > 0) {
  console.error(`\nROUTING E2E FAILED (${problems.length}):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log("\nROUTING E2E OK: consolidation, drain-by-pin, and spill at threshold")
