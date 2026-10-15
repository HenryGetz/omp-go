// REPRODUCTION of the reported divergence, in the interactive TUI via
// @microsoft/tui-test (the retry saga - and its "Provider requested ...ms
// wait, exceeds retry.maxDelayMs" fail-fast - only exists on the interactive
// surface):
//
//   Path A: launch omp with the model already active      -> turn works
//   Path B: the same, but pi.setModel switches through the REGISTRY entry
//           at session start (OMP_TEST_SETMODEL - the exact call ompreset's
//           /go makes)                                     -> turn fails
//
// The turn is kicked by the launcher's first-turn argument (the composer
// never submits under the harness). OMP_ORG_DEBUG records the org attribution
// of every request so the wire-level difference is visible.
//
// Run: node test/e2e/tui-setmodel-repro.mjs

import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { TuiTest } from "@microsoft/tui-test"

const EXPECT_MODEL = "opencode-go/deepseek-v4.1-flash"
const agentDir = path.join(homedir(), ".omp", "agent")
const orgDebug = path.join(agentDir, "omp-go-org-debug.ndjson")
const verdictsPath = path.join(agentDir, "omp-go-verdicts.json")
const trafficPath = path.join(agentDir, "omp-go-traffic.ndjson")

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deepseekLines = () => {
  try {
    return readFileSync(trafficPath, "utf8").split("\n").filter((l) => l.includes("deepseek-v4.1-flash")).length
  } catch {
    return 0
  }
}
const orgLines = () => {
  try {
    return readFileSync(orgDebug, "utf8").split("\n").filter(Boolean)
  } catch {
    return []
  }
}

async function runTurn(label, marker, extraEnv) {
  mkdirSync(agentDir, { recursive: true })
  rmSync(orgDebug, { force: true })
  const trafficBefore = deepseekLines()
  let trafficBeforeRaw = 0
  try {
    trafficBeforeRaw = readFileSync(trafficPath, "utf8").split("\n").filter(Boolean).length
  } catch {}

  const terminal = TuiTest.ephemeral(`omp-setmodel-${label}`)
  let screen = ""
  try {
    await terminal.run("omp", [`reply with exactly: ${marker}`], {
      cols: 140,
      rows: 42,
      timeout: 300_000,
      env: { ...process.env, OMP_ORG_DEBUG: orgDebug, ...extraEnv },
    })
    // Completion is the REPLACED marker as a STANDALONE line - the echoed
    // prompt ("reply with exactly: ...") contains the marker text and must
    // never count (it matched instantly and killed the turn before it ran).
    // The session TITLE copies the prompt's marker text and appears while the
    // turn is still running, so a marker line alone is NOT completion. A turn
    // counts only when the marker stands alone AND the screen is idle AND a
    // deepseek request was actually recorded.
    const standalone = new RegExp(`^\\s*${marker}\\s*$`, "mi")
    const errored = /Retry failed|member out of service|member verdict|Insufficient account funds|Workspace access denied/
    const busy = /Working…|Retrying \(|Still starting/
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      await sleep(5_000)
      screen = await terminal.text({ full: true }).catch(() => "")
      if (errored.test(screen)) break
      if (standalone.test(screen) && !busy.test(screen) && deepseekLines() > trafficBefore) break
    }
  } finally {
    await terminal.closeQuiet()
  }
  const errored = /Retry failed|member out of service|member verdict|Insufficient account funds|Workspace access denied/
  const failed = errored.test(screen)
  const completed =
    new RegExp(`^\\s*${marker}\\s*$`, "mi").test(screen) && !failed && deepseekLines() > trafficBefore
  console.log(`\n===== ${label}: completed=${completed} failed=${failed} (deepseek traffic ${trafficBefore} -> ${deepseekLines()}) =====`)
  console.log(screen.split("\n").filter((l) => l.trim()).slice(-16).join("\n"))
  console.log(`--- ${label} org attribution / seam ---`)
  console.log(orgLines().slice(-8).join("\n") || "(none)")
  const trafficNow = (() => {
    try {
      return readFileSync(trafficPath, "utf8")
    } catch {
      return ""
    }
  })()
  const delta = trafficNow.split("\n").filter(Boolean).slice(trafficBeforeRaw).join("\n")
  console.log(`--- ${label} traffic delta ---`)
  console.log(delta.split("\n").slice(-4).join("\n") || "(none)")
  return { screen, completed, failed }
}

console.log("=== verdicts before ===")
try { console.log(readFileSync(verdictsPath, "utf8")) } catch { console.log("(none)") }

// Path A: the model is already active (config roles) - reported to work.
const a = await runTurn("A-default-model", "AA-11", {})

// Path B: pi.setModel through the REGISTRY entry (the /go effect) - reported to fail.
const b = await runTurn("B-setmodel-switch", "BB-22", { OMP_TEST_SETMODEL: EXPECT_MODEL })

console.log("\n===== verdicts after =====")
try { console.log(readFileSync(verdictsPath, "utf8")) } catch { console.log("(none)") }

console.log(`\nRESULT: A worked=${a.completed && !a.failed} | B failed=${b.failed} | divergence reproduced=${(a.completed && !a.failed) && b.failed}`)
