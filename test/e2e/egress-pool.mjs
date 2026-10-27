// Egress pool behavior in a real `omp` TUI (microsoft/tui-test): two hosts,
// automatic distribution, and failover when one tunnel dies mid-session.
//
// 1. Seed BOTH hosts; three free-tier chats run in one omp session.
// 2. The wire log must show requests riding MORE THAN ONE tunnel hop
//    (round-robin distribution across your machines).
// 3. Between chats, one tunnel is killed; the next chat must still complete
//    and stay on a tunnel hop (failover, no direct leak).
//
//   node test/e2e/egress-pool.mjs
//   EGRESS_POOL_TARGETS="student@192.0.2.10,wrcadmin@100.93.105.17" node test/e2e/egress-pool.mjs

import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { TuiTest } from "@microsoft/tui-test"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const OMP = process.env.OMP_BIN ?? "omp"
const TARGETS = (process.env.EGRESS_POOL_TARGETS ?? "student@192.0.2.10,wrcadmin@100.93.105.17")
  .split(",")
  .map((target) => target.trim())
  .filter(Boolean)

const home = mkdtempSync(path.join(tmpdir(), "omp-egress-pool-"))
const cwd = mkdtempSync(path.join(tmpdir(), "omp-egress-pool-cwd-"))
const wireLog = path.join(home, "wire.ndjson")

mkdirSync(path.join(home, ".omp", "agent"), { recursive: true })
writeFileSync(path.join(home, ".omp", "agent", "config.yml"), "setupVersion: 2\n")
writeFileSync(
  path.join(home, ".omp", "agent", "omp-go-egress.json"),
  `${JSON.stringify({ hosts: TARGETS.map((target) => ({ target, enabled: true })) }, null, 2)}\n`,
)

const env = {
  ...process.env,
  HOME: home,
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_STATE_HOME: path.join(home, ".local", "state"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  OMP_GO_WIRE_LOG: wireLog,
}
delete env.OPENCODE_API_KEY

const problems = []
const note = (ok, message) => {
  if (!ok) problems.push(message)
  console.log(`${ok ? "ok  " : "FAIL"}  ${message}`)
}

execFileSync(OMP, ["plugin", "install", REPO], { env, encoding: "utf8", timeout: 120_000 })

const terminal = TuiTest.ephemeral("omp-egress-pool")
try {
  await terminal.run(OMP, ["--model", "opencode-free/mimo-v2.6-flash-free"], {
    env, cwd, cols: 140, rows: 42, timeout: 120_000,
  })
  const waitFor = async (needle, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await terminal.text({ full: true })).includes(needle)) return true
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  }
  const chat = async (prompt, answer) => {
    await terminal.type(prompt)
    await terminal.submit()
    return waitFor(answer, 120_000)
  }
  const hops = () =>
    existsSync(wireLog)
      ? readFileSync(wireLog, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((entry) => entry.path.includes("/chat/completions"))
      : []

  note(await waitFor("v18.", 90_000), "omp starts (fresh profile, two egress hosts seeded)")

  note(await chat("What is 17*13? Reply with just the product.", "221"), "chat 1 completes")
  note(await chat("What is 19*11? Reply with just the product.", "209"), "chat 2 completes")

  const first = hops()
  const distinct = [...new Set(first.map((entry) => entry.hop))]
  note(distinct.length > 1, `requests distribute across tunnels (${distinct.join(", ")})`)
  note(first.every((entry) => !entry.hop.includes("direct")), "no request leaked to a direct connection")

  // Kill whichever tunnel carried traffic; the pool must route around it.
  // Kill by the PID that owns the listening port — pkill -f misses ssh
  // processes that daemonized via ForkAfterAuthentication.
  const victim = distinct[0]
  const port = victim.split(":")[2]
  const ss = spawnSync("ss", ["-ltnp", "sport", "=", `:${port}`], { encoding: "utf8" }).stdout ?? ""
  const pid = Number(/pid=(\d+)/.exec(ss)?.[1] ?? 0)
  if (pid > 0) {
    try {
      process.kill(pid, "SIGKILL")
      console.log(`killed ${victim} (pid ${pid})`)
    } catch (error) {
      console.log(`kill failed for ${victim}: ${error.message}`)
    }
  } else {
    console.log(`killed ${victim} (no listener found!)`)
  }

  note(await chat("What is 23*7? Reply with just the product.", "161"), "chat 3 completes after a tunnel died")

  const all = hops()
  const after = all.slice(first.length)
  note(after.length > 0 && after.every((entry) => !entry.hop.includes("direct")), "failover stayed on tunnels (no direct leak)")
  note(after.some((entry) => entry.hop !== victim), `failover moved off the dead hop (${[...new Set(after.map((e) => e.hop))].join(", ")})`)
} finally {
  await terminal.closeQuiet()
}

if (problems.length > 0) {
  console.log(`EGRESS-POOL FAIL (${problems.length}):`)
  for (const problem of problems) console.log(`  ${problem}`)
  console.log(`wire log: ${wireLog}`)
  process.exit(1)
}
console.log(`EGRESS-POOL OK: pool distributes across ${TARGETS.length} tunnels and fails over when one dies`)
