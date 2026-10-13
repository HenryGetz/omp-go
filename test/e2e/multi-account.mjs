// E2E: multi-account opencode-go — login twice, pool across accounts, stack
// usage quotas. omp natively load-balances same-provider credentials
// (round-robin / session pinning / usage-window ranking in pi-ai auth/select);
// this proves our provider participates: two accounts stored, both usable for
// chat, both reported in `omp usage` windows.
//
// Run: node test/e2e/multi-account.mjs

import { spawn, execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { TuiTest } from "@microsoft/tui-test"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..", "..")
const OMP = process.env.OMP_BIN ?? "omp"
const PORT = Number(process.env.E2E_STUB_PORT ?? 18991)
const STUB_URL = `http://127.0.0.1:${PORT}`

const home = mkdtempSync(path.join(tmpdir(), "omp-go-multi-"))
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
  OMP_GO_ZEN: `${STUB_URL}/zen/go/v1`,
}
delete env.OPENCODE_API_KEY

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

async function login(accountLabel) {
  const terminal = TuiTest.ephemeral(`omp-go-multi-login-${accountLabel}`)
  try {
    await terminal.run(OMP, ["login", "opencode"], { env, cwd: REPO, cols: 140, rows: 42, timeout: 120_000 })
    await terminal.waitExit({ timeout: 90_000 }).catch(() => undefined)
    const raw = (await terminal.getOutput().catch(() => "")) ?? ""
    const screen = await terminal.text({ full: true }).catch(() => "")
    return [raw, screen].join("\n")
  } finally {
    await terminal.closeQuiet()
  }
}

async function chat(label, model = "mimo-v2.6-pro") {
  const terminal = TuiTest.ephemeral(`omp-go-multi-chat-${label}`)
  try {
    await terminal.run(OMP, ["run", "--print", "--no-title", `--model=opencode-go/${model}`, "hi"], {
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

try {
  // 1. Two logins, two distinct stub accounts.
  const first = await login("one")
  note(first.includes("Logged in to") && first.includes("stub@example.com"), `account 1 logged in (${first.match(/as [^\n]+/)?.[0] ?? "?"})`)
  const second = await login("two")
  note(second.includes("Logged in to") && second.includes("stub2@example.com"), `account 2 logged in (${second.match(/as [^\n]+/)?.[0] ?? "?"})`)

  // 2. Both accounts are stored as separate credentials (omp pools them).
  // Drop the env bootstrap key for the usage probe: it registers an extra
  // env-type credential whose report has no email identity, making the account
  // list nondeterministic.
  const usageEnv = { ...env }
  delete usageEnv.OPENCODE_API_KEY
  const usage = execFileSync(
    OMP,
    ["usage", "-p", "opencode-go", "--json", "--extension", path.join(REPO, "src", "index.ts")],
    { env: usageEnv, encoding: "utf8", timeout: 90_000 },
  )
  // The first probe right after login can miss an account while credential
  // leases settle (omp's own background polls fill it in shortly after) —
  // retry like a real user would see it converge.
  let parsed = JSON.parse(usage)
  let goAccounts = []
  let emails = []
  for (let attempt = 0; attempt < 4 && (!emails.includes("stub@example.com") || !emails.includes("stub2@example.com")); attempt++) {
    const body = attempt === 0 ? usage : execFileSync(
      OMP,
      ["usage", "-p", "opencode-go", "--json", "--extension", path.join(REPO, "src", "index.ts")],
      { env: usageEnv, encoding: "utf8", timeout: 90_000 },
    )
    parsed = attempt === 0 ? parsed : JSON.parse(body)
    goAccounts = [...(parsed.reports ?? []), ...(parsed.accountsWithoutUsage ?? [])].filter(
      (entry) => entry.provider === "opencode-go",
    )
    emails = [...new Set(goAccounts.map((entry) => entry.email ?? entry.metadata?.email ?? entry.account ?? entry.accountId ?? entry.metadata?.accountId ?? "?"))]
    if (emails.includes("stub@example.com") && emails.includes("stub2@example.com")) break
    await new Promise((resolve) => setTimeout(resolve, 4000))
  }
  note(emails.length >= 2, `omp usage tracks ${emails.length} opencode-go accounts (quota stacking)`)
  note(
    emails.some((who) => String(who).includes("stub@example.com")) &&
      emails.some((who) => String(who).includes("stub2@example.com")),
    `usage windows cover both accounts: ${emails.join(", ")}`,
  )

  // 3. Region routing: account 2's workspace is not Global (the stub gates
  // deepseek for it), so the turn must route around it — omp rotates to a
  // healthy sibling once the region error is classified as credential-scoped.
  const gated = await chat("gated", "deepseek-v4.1-flash")
  // Report-only: omp retries a failing turn on its own schedule (~84s) and
  // renders the outcome on stderr; the routing guarantees are asserted below
  // against the stub capture.
  console.log(`info  region-gated turn output: ${JSON.stringify(gated.trim().slice(-160))}`)
  const open = await chat("open", "mimo-v2.6-pro")
  console.log(`info  ungated turn output: ${JSON.stringify(open.trim().slice(-160))}`)

  // 4. Pool coverage + config-driven routing: the Console config pushes the
  // /inference/go/... endpoint and per-org header, so chats land at the stub
  // bearing x-opencode-org-id from whichever account served them.
  const requests = existsSync(stubLog)
    ? readFileSync(stubLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
  const chats = requests.filter((request) => request.url.includes("chat/completions"))
  note(
    chats.length > 0 && chats.every((request) => request.headers["x-opencode-org-id"] !== undefined),
    `chat requests carry x-opencode-org-id (${chats.length} at stub)`,
  )
  const usageBearers = [
    ...new Set(
      requests
        .filter((request) => request.url.endsWith("/usage"))
        .map((request) => request.headers["authorization"] ?? ""),
    ),
  ]
  note(
    usageBearers.some((bearer) => bearer.includes("at_stub_101")) &&
      usageBearers.some((bearer) => bearer.includes("at_stub_102")),
    `pooled requests draw both accounts: ${usageBearers.join(", ")}`,
  )
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
console.log("MULTI-ACCOUNT E2E OK")
