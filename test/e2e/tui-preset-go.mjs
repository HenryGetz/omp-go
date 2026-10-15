// E2E: the GO PRESET path - the user's preset-changing plugin (ompreset) puts
// the session on opencode-go/deepseek-v4.1-flash via `/go`, and the turn AFTER
// the preset switch is where things were breaking.
//
// The TUI's slash dispatch needs real keys (the PTY harness cannot submit the
// composer - the same gate as message turns), so the preset is applied through
// ompreset's OWN code path (the exact functions `/go` invokes: parse presets.yml
// -> normalizePreset -> updateAgentConfigFile). The session-level `pi.setModel`
// effect is reproduced by routing on the preset's roles: the turns carry NO
// --model flag, so the model comes from modelRoles.default exactly as it would
// after `/go`.
//
// Run: node test/e2e/tui-preset-go.mjs

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { TuiTest } from "@microsoft/tui-test"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..", "..")
const OMP = process.env.OMP_BIN ?? "omp"
const EXPECT_MODEL = "opencode-go/deepseek-v4.1-flash"

const problems = []
const note = (ok, message) => {
  if (!ok) problems.push(message)
  console.log(`${ok ? "ok  " : "FAIL"}  ${message}`)
}

// 1. Install the working tree so the turns run THIS code.
try {
  const install = execFileSync(OMP, ["plugin", "install", REPO], { encoding: "utf8", timeout: 120_000 })
  console.log(install.trim().split("\n").slice(-1).join("\n"))
  note(true, "working tree installed into the real plugin dir")
} catch (error) {
  note(false, `plugin install failed: ${String(error).slice(0, 200)}`)
}

// 2. Apply the `go` preset through ompreset's own code path.
let applied
try {
  const out = execFileSync("bun", [path.join(HERE, "apply-preset.ts"), "go"], { encoding: "utf8", timeout: 60_000 })
  applied = JSON.parse(out.trim().split("\n").pop())
  note(applied?.model === EXPECT_MODEL, `ompreset applied the GO preset (model ${applied?.model})`)
  note(applied?.roles?.default === EXPECT_MODEL, `preset roles route default -> ${applied?.roles?.default}`)
} catch (error) {
  note(false, `apply-preset failed: ${String(error).slice(0, 300)}`)
}
const cfg = readFileSync(path.join(homedir(), ".omp", "agent", "config.yml"), "utf8")
note(cfg.includes(`default: ${EXPECT_MODEL}`), "config.yml modelRoles carry the preset model (persisted)")

// 3. The turns after the preset switch - NO --model flag: the model must come
//    from the preset's roles, exactly as after `/go`.
const trafficFile = path.join(homedir(), ".omp", "agent", "omp-go-traffic.ndjson")
const deepseekLines = () => {
  try {
    return readFileSync(trafficFile, "utf8").split("\n").filter((l) => l.includes("deepseek-v4.1-flash")).length
  } catch {
    return 0
  }
}

async function turn(label, args) {
  const terminal = TuiTest.ephemeral(`omp-preset-go-${label}`)
  try {
    await terminal.run(OMP, args, { cols: 140, rows: 42, timeout: 300_000 })
    const deadline = Date.now() + 240_000
    let screen = ""
    while (Date.now() < deadline) {
      screen = await terminal.text({ full: true }).catch(() => "")
      if (/Retry failed|Insufficient account funds|Workspace access denied|Tool .* not found|member out of service/.test(screen)) break
      if (screen.length > 1500 && /GO (ONE|TWO) OK/i.test(screen)) break
      await new Promise((resolve) => setTimeout(resolve, 3_000))
    }
    return screen
  } finally {
    await terminal.closeQuiet()
  }
}

const before1 = deepseekLines()
const screen1 = await turn("one", ["reply with exactly: GO ONE OK"])
note(!/Retry failed|Insufficient account funds|Workspace access denied|member out of service/.test(screen1), "post-preset turn 1 surfaces no account/wait-hint failure")
note(!/Tool .* not found/.test(screen1), "post-preset turn 1 has no missing-tool errors")
note(/GO ONE OK/i.test(screen1), "post-preset turn 1 completed with a reply")
note(deepseekLines() > before1, `turn 1 routed to ${EXPECT_MODEL} (traffic ${before1} -> ${deepseekLines()} deepseek lines)`)

const before2 = deepseekLines()
const screen2 = await turn("two", ["--continue", "reply with exactly: GO TWO OK"])
note(!/Retry failed|Insufficient account funds|Workspace access denied|member out of service/.test(screen2), "post-preset turn 2 (continued session) surfaces no account/wait-hint failure")
note(/GO TWO OK/i.test(screen2), "post-preset turn 2 completed with a reply")
note(deepseekLines() > before2, `turn 2 routed to ${EXPECT_MODEL} (traffic ${before2} -> ${deepseekLines()} deepseek lines)`)

if (problems.length > 0) {
  console.error(`\nTUI PRESET-GO FAILED (${problems.length}):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error("\n--- last turn screen tail ---")
  console.error(screen2.split("\n").slice(-25).join("\n"))
  process.exit(1)
}
console.log("\nTUI PRESET-GO OK: the GO preset (ompreset's own code path) routes both turns to opencode-go/deepseek-v4.1-flash through omp-go, turn 1 AND the continued session")
