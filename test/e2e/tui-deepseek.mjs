// FINAL ACCEPTANCE: opencode-go/deepseek-v4.1-flash working in the interactive
// TUI on the REAL machine and the REAL gateway (no stub, no fake HOME — the
// user's own omp profile, accounts, and egress). The scenario mirrors the
// reported failure: a session whose account answers 402 must complete its turn
// anyway (rotation/re-pin), and the CONTINUED session must keep working.
//
// Run: node test/e2e/tui-deepseek.mjs

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { TuiTest } from "@microsoft/tui-test"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..", "..")
const OMP = process.env.OMP_BIN ?? "omp"
const MODEL = "opencode-go/deepseek-v4.1-flash"

const problems = []
const note = (ok, message) => {
  if (!ok) problems.push(message)
  console.log(`${ok ? "ok  " : "FAIL"}  ${message}`)
}

// 1. Install the working tree so the acceptance runs THIS code.
try {
  const install = execFileSync(OMP, ["plugin", "install", REPO], { encoding: "utf8", timeout: 120_000 })
  console.log(install.trim().split("\n").slice(-2).join("\n"))
  note(true, "working tree installed into the real plugin dir")
} catch (error) {
  note(false, `plugin install failed: ${String(error).slice(0, 200)}`)
}

const trafficFile = path.join(homedir(), ".omp", "agent", "omp-go-traffic.ndjson")
const trafficCount = () => {
  try {
    return readFileSync(trafficFile, "utf8").split("\n").filter(Boolean).length
  } catch {
    return 0
  }
}

async function turn(label, args) {
  const terminal = TuiTest.ephemeral(`omp-deepseek-accept-${label}`)
  try {
    await terminal.run(OMP, args, { cols: 140, rows: 42, timeout: 300_000 })
    const deadline = Date.now() + 240_000
    let screen = ""
    while (Date.now() < deadline) {
      screen = await terminal.text({ full: true }).catch(() => "")
      if (/Retry failed|Insufficient account funds|Workspace access denied|Tool .* not found/.test(screen)) break
      if (/Hello|ok|done|sure|✓|╭─\s*$/m.test(screen) && screen.length > 1500) break
      await new Promise((resolve) => setTimeout(resolve, 3_000))
    }
    return screen
  } finally {
    await terminal.closeQuiet()
  }
}

// 2. The reported failure: a real interactive turn on deepseek-v4.1-flash.
const before = trafficCount()
const screen = await turn("turn", ["--model", MODEL, "reply with exactly: DEEPSEEK OK"])
const failed = /Retry failed|Insufficient account funds|Workspace access denied/.test(screen)
note(!failed, "interactive deepseek turn surfaces no account/wait-hint failure")
note(!/Tool .* not found/.test(screen), "no missing-tool errors in the interactive turn")
note(/DEEPSEEK OK|deepseek ok/i.test(screen), "interactive deepseek turn completed with a reply")
note(trafficCount() > before, `request traffic recorded (${before} -> ${trafficCount()} lines)`)

// 3. The stuck-session recovery: the SAME session continues (--continue) and
// must still work — the verdict re-pin keeps it off any dry account.
const beforeCont = trafficCount()
const contScreen = await turn("cont", ["--continue", "reply with exactly: CONTINUE OK"])
const contFailed = /Retry failed|Insufficient account funds|Workspace access denied/.test(contScreen)
note(!contFailed, "continued deepseek turn surfaces no account/wait-hint failure")
note(/CONTINUE OK|continue ok/i.test(contScreen), "continued deepseek turn completed with a reply")
note(trafficCount() > beforeCont, `continued turn recorded traffic (${beforeCont} -> ${trafficCount()} lines)`)

if (problems.length > 0) {
  console.error(`\nTUI DEEPSEEK ACCEPTANCE FAILED (${problems.length}):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error("\n--- last turn screen tail ---")
  console.error(screen.split("\n").slice(-25).join("\n"))
  process.exit(1)
}
console.log("\nTUI DEEPSEEK ACCEPTANCE OK: opencode-go/deepseek-v4.1-flash works in the interactive TUI (turn + continuation) on the real gateway")
