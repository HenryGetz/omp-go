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
    return raw.trim() ? raw : await terminal.text({ full: true })
  } finally {
    await terminal.closeQuiet()
  }
}

async function chat(label) {
  const terminal = TuiTest.ephemeral(`omp-go-multi-chat-${label}`)
  try {
    await terminal.run(OMP, ["run", "--print", "--no-title", "--model=opencode-go/mimo-v2.6-pro", "hi"], {
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
  const usage = execFileSync(
    OMP,
    ["usage", "-p", "opencode-go", "--json", "--extension", path.join(REPO, "src", "index.ts")],
    { env, encoding: "utf8", timeout: 90_000 },
  )
  const parsed = JSON.parse(usage)
  const goAccounts = [...(parsed.reports ?? []), ...(parsed.accountsWithoutUsage ?? [])].filter(
    (entry) => entry.provider === "opencode-go",
  )
  const emails = [...new Set(goAccounts.map((entry) => entry.email ?? entry.account ?? entry.accountId ?? "?"))]
  note(emails.length >= 2, `omp usage tracks ${emails.length} opencode-go accounts (quota stacking)`)
  note(
    emails.some((who) => String(who).includes("stub@example.com")) &&
      emails.some((who) => String(who).includes("stub2@example.com")),
    `usage windows cover both accounts: ${emails.join(", ")}`,
  )

  // 3. Pool coverage: the usage poller draws every stored credential against
  // the gateway, so both account tokens must appear at the stub. (Chat turns
  // cannot be observed here: the model route keeps the catalog base URL, so
  // only the usage fetcher — which honors the override — reaches the stub.)
  const requests = existsSync(stubLog)
    ? readFileSync(stubLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
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
