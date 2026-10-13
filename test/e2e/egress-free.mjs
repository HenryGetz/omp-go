// Free tier + egress, end to end in a real `omp` TUI (microsoft/tui-test).
//
// The complete integration: the plugin opens the SSH tunnel itself from the
// seeded host list, a real free-model chat completes in the terminal, and the
// wire log proves the chat request was CARRIED BY THE TUNNEL (not silently
// sent direct).
//
//   node test/e2e/egress-free.mjs
//   EGRESS_TUNNEL_TARGET=wrcadmin@100.93.105.17 node test/e2e/egress-free.mjs

import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { TuiTest } from "@microsoft/tui-test"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const OMP = process.env.OMP_BIN ?? "omp"
const TARGET = process.env.EGRESS_TUNNEL_TARGET ?? "student@100.125.193.75"

const home = mkdtempSync(path.join(tmpdir(), "omp-egress-free-"))
const cwd = mkdtempSync(path.join(tmpdir(), "omp-egress-free-cwd-"))
const wireLog = path.join(home, "wire.ndjson")

mkdirSync(path.join(home, ".omp", "agent"), { recursive: true })
writeFileSync(path.join(home, ".omp", "agent", "config.yml"), "setupVersion: 2\n")
// The onboarding artifact: a host list the plugin turns into tunnels.
writeFileSync(path.join(home, ".omp", "agent", "omp-go-egress.json"), `${JSON.stringify({ hosts: [{ target: TARGET, enabled: true }] }, null, 2)}\n`)

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

const terminal = TuiTest.ephemeral("omp-egress-free")
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

  note(await waitFor("v18.", 90_000), "omp starts with the free model (fresh profile)")

  // A real chat on the free tier — the answer cannot echo the prompt.
  await terminal.type("What is 17*13? Reply with just the product.")
  await terminal.submit()
  note(await waitFor("221", 120_000), "free-tier chat completes in the TUI")

  // The tunnel was opened by the plugin from the seeded host list...
  await new Promise((r) => setTimeout(r, 2_000))
  const entries = existsSync(wireLog)
    ? readFileSync(wireLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : []
  const chat = entries.filter((entry) => entry.url.includes("/chat/completions"))
  note(chat.length > 0, "wire log recorded the chat request")
  const viaTunnel = chat.filter((entry) => entry.hop.startsWith("socks5://"))
  note(viaTunnel.length > 0, `chat carried by the SSH tunnel (${viaTunnel[0]?.hop ?? "none"})`)
  note(chat.every((entry) => !entry.hop.includes("direct")), "no chat request leaked to a direct connection")
} finally {
  await terminal.closeQuiet()
}

if (problems.length > 0) {
  console.log(`EGRESS-FREE FAIL (${problems.length}):`)
  for (const problem of problems) console.log(`  ${problem}`)
  console.log(`wire log: ${wireLog}`)
  process.exit(1)
}
console.log(`EGRESS-FREE OK: free-tier chat completed through the ${TARGET} tunnel (verified in the wire log)`)
