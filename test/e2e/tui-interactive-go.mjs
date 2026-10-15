// Interactive reproduction of the reported divergence: launching omp with the
// default model works, but after the preset plugin's `/go` the SAME model fails
// with "account member out of service". Drives the real TUI via @microsoft/tui-test:
// launch -> /go -> turn -> turn, with per-step screens and OMP_ORG_DEBUG
// capturing the org attribution on every request.
//
// /go execution is detected by the definitive signal: the config's default role
// is set AWAY first, so the preset applying must bring it back.
//
// Run: node test/e2e/tui-interactive-go.mjs

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { TuiTest } from "@microsoft/tui-test"

const EXPECT_MODEL = "opencode-go/deepseek-v4.1-flash"
const cfgPath = path.join(homedir(), ".omp", "agent", "config.yml")
const orgDebug = path.join(homedir(), ".omp", "agent", "omp-go-org-debug.ndjson")
const verdictsPath = path.join(homedir(), ".omp", "agent", "omp-go-verdicts.json")
const trafficPath = path.join(homedir(), ".omp", "agent", "omp-go-traffic.ndjson")

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const snap = (label, screen) => {
  console.log(`\n===== ${label} =====`)
  console.log(screen.split("\n").filter((l) => l.trim()).slice(-18).join("\n"))
}

// 1. Away-state: /go applying MUST write the preset model back.
const original = readFileSync(cfgPath, "utf8")
const away = original.replace(new RegExp(`default: ${EXPECT_MODEL.replace("/", "\\/")}`, "g"), "default: opencode-free/mimo-v2.6-flash-free")
writeFileSync(cfgPath, away)
mkdirSync(path.dirname(orgDebug), { recursive: true })
rmSync(orgDebug, { force: true })

const before = { orgDebug: existsSync(orgDebug) ? readFileSync(orgDebug, "utf8") : "", traffic: readFileSync(trafficPath, "utf8") }
const deepseekLines = () => {
  try {
    return readFileSync(trafficPath, "utf8").split("\n").filter((l) => l.includes("deepseek-v4.1-flash")).length
  } catch {
    return 0
  }
}

const terminal = TuiTest.ephemeral("omp-interactive-go", { artifacts: { dir: path.join(homedir(), ".omp", "agent", "tui-interactive-go-artifacts"), onFailure: "all" } })
try {
  await terminal.run("omp", [], {
    cols: 140,
    rows: 42,
    timeout: 60_000,
    env: { ...process.env, OMP_ORG_DEBUG: orgDebug },
    cwd: homedir(),
  })
  await sleep(15_000)
  snap("LAUNCH", await terminal.text({ full: true }).catch(() => ""))

  // 2. /go — type + Enter, then watch for up to 30s.
  await terminal.submit("/go")
  let applied = false
  let screen = ""
  for (let i = 0; i < 15; i += 1) {
    await sleep(2_000)
    screen = await terminal.text({ full: true }).catch(() => "")
    applied = readFileSync(cfgPath, "utf8").includes(`default: ${EXPECT_MODEL}`)
    if (applied || /GO preset/i.test(screen)) break
  }
  snap(`/go (applied=${applied})`, screen)

  if (!applied) {
    // Fallback: raw bytes (bracketed-paste-safe Enter).
    await terminal.write("/go")
    await sleep(1_500)
    await terminal.write("\r")
    for (let i = 0; i < 10; i += 1) {
      await sleep(2_000)
      screen = await terminal.text({ full: true }).catch(() => "")
      applied = readFileSync(cfgPath, "utf8").includes(`default: ${EXPECT_MODEL}`)
      if (applied || /GO preset/i.test(screen)) break
    }
    snap(`/go raw fallback (applied=${applied})`, screen)
  }

  // 3. The turn after /go (the reported failure). NOTE: under the PTY the
  //    composer never submits (typed text accumulates in the prompt line), so
  //    the "turn ran" signal is TRAFFIC, never screen text - the un-submitted
  //    composer text contains the very phrases we look for.
  const t1Before = deepseekLines()
  await terminal.submit("reply with exactly: GO ONE OK")
  let turn1 = ""
  const deadline1 = Date.now() + 180_000
  while (Date.now() < deadline1) {
    await sleep(4_000)
    turn1 = await terminal.text({ full: true }).catch(() => "")
    if (/GO ONE OK/i.test(turn1) || /Retry failed|account member out of service|Insufficient account funds|member verdict/i.test(turn1)) break
  }
  snap("TURN 1 after /go", turn1)

  // 4. The next turn (the "one works, next dies" pattern).
  const t2Before = deepseekLines()
  await terminal.submit("reply with exactly: GO TWO OK")
  let turn2 = ""
  const deadline2 = Date.now() + 180_000
  while (Date.now() < deadline2) {
    await sleep(4_000)
    turn2 = await terminal.text({ full: true }).catch(() => "")
    if (/GO TWO OK/i.test(turn2) || /Retry failed|account member out of service|Insufficient account funds|member verdict/i.test(turn2)) break
  }
  snap("TURN 2 after /go", turn2)

  // 5. Diagnosis dump: org attribution + verdicts + traffic delta.
  const orgLines = existsSync(orgDebug) ? readFileSync(orgDebug, "utf8").split("\n").filter(Boolean) : []
  console.log("\n===== OMP_ORG_DEBUG (requests this run) =====")
  console.log(orgLines.slice(-8).join("\n") || "(none)")
  console.log("\n===== verdicts =====")
  try { console.log(readFileSync(verdictsPath, "utf8")) } catch { console.log("(none)") }
  const trafficAfter = readFileSync(trafficPath, "utf8")
  console.log("===== traffic delta =====")
  console.log(trafficAfter.slice(before.traffic.length).split("\n").filter(Boolean).slice(-6).join("\n") || "(none)")
  // Turn "ran" = the request actually reached the gateway (traffic recorded);
  // the screen phrases only prove the composer held the text.
  console.log("\n/go applied:", applied)
  console.log("turn1 ran:", deepseekLines() > t1Before, `(deepseek traffic ${t1Before} -> ${deepseekLines()})`)
  console.log("turn2 ran:", deepseekLines() > t2Before, `(deepseek traffic ${t2Before} -> ${deepseekLines()})`)
} finally {
  await terminal.closeQuiet()
  writeFileSync(cfgPath, original)
  console.log("config restored:", readFileSync(cfgPath, "utf8") === original)
}
