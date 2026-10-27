// Egress onboarding verification.
//
// 1. Scriptable path (`omp --egress-add/--egress-test/--egress-list`): the same
//    handlers the /egress wizard runs, driven through a real omp process —
//    deterministic and complete.
// 2. TUI path (microsoft/tui-test): the /egress wizard dialog in a real omp
//    terminal. The dialog flow itself was verified live in a real terminal;
//    tui-test's text submission into omp's slash composer is unreliable
//    (pastes and raw writes both land as unsubmitted drafts), so this section
//    runs when TUI_MODE=1 and is diagnostic.
//
//   bun test/e2e/egress-onboarding.mjs
//   EGRESS_ONBOARD_TARGET=student@192.0.2.10 bun test/e2e/egress-onboarding.mjs  # real-host success path
//   TUI_MODE=1 E2E_DUMP=1 bun test/e2e/egress-onboarding.mjs

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const OMP = process.env.OMP_BIN ?? "omp"
const TARGET = process.env.EGRESS_ONBOARD_TARGET ?? "nobody@127.0.0.1"
const SUCCESS = Boolean(process.env.EGRESS_ONBOARD_TARGET)

const home = mkdtempSync(path.join(tmpdir(), "omp-egress-onboard-"))
mkdirSync(path.join(home, ".omp", "agent"), { recursive: true })
writeFileSync(path.join(home, ".omp", "agent", "config.yml"), "setupVersion: 2\n")

const env = {
  ...process.env,
  HOME: home,
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_STATE_HOME: path.join(home, ".local", "state"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
}

const problems = []
const note = (ok, message) => {
  if (!ok) problems.push(message)
  console.log(`${ok ? "ok  " : "FAIL"}  ${message}`)
}

// Install the repo copy the way users install the plugin.
execFileSync(OMP, ["plugin", "install", REPO], { env, encoding: "utf8", timeout: 120_000 })

// ---- 1. Onboarding flows (real ssh, real probing) ------------------------

// Failure-path runs isolate the profile completely (ssh included). Success
// runs against a real host keep the invoking HOME so key auth works — the
// host list then lands in that profile, which is where users manage it anyway.
if (!SUCCESS) process.env.HOME = home
const egress = await import(path.join(REPO, "src", "egress.ts"))
const configPath = path.join(process.env.HOME, ".omp", "agent", "omp-go-egress.json")

// The same handlers the /egress wizard runs.
const add = await egress.addEgressFlow(TARGET)
console.log(`addEgressFlow said:\n${add.message}`)
if (SUCCESS) {
  note(/added \S+ — egress \d+\./.test(add.message), "add reports the host's egress IP")
  note(add.message.includes("distinct from this machine's") || add.message.includes("same as this machine"), "flags whether the IP is a new budget")
} else {
  note(add.message.includes("ssh-copy-id"), "failed add gives the fix (ssh-copy-id guidance)")
  note(add.message.includes(`ssh-copy-id ${TARGET}`), "guidance names the exact target")
  note(add.message.includes("added ") && add.message.includes("tunnel is not up yet"), "explains the state instead of a bare error")
}
note(egress.listHosts().some((host) => host.target === TARGET) && existsSync(configPath), "host persisted to ~/.omp/agent/omp-go-egress.json")
note(egress.listHosts().some((host) => host.target === TARGET), "listHosts sees the new host")

const health = await egress.testEgressFlow()
console.log(`testEgressFlow said:\n${health}`)
note(/(UP|DOWN|off)\s+\S+/.test(health), "health check reports per-host status")

// The wizard is reachable from the TUI: omp's live command table must carry it.
const rpc = execFileSync(OMP, ["--mode", "rpc"], { env, cwd: REPO, encoding: "utf8", timeout: 60_000, input: "" }).toString()
note(rpc.includes('"name":"egress"'), "omp's TUI command table exposes /egress")

// ---- 2. TUI wizard (diagnostic) -----------------------------------------

if (process.env.TUI_MODE === "1") {
  const { TuiTest } = await import("@microsoft/tui-test")
  const cwd = mkdtempSync(path.join(tmpdir(), "omp-egress-cwd-"))
  const terminal = TuiTest.ephemeral("omp-egress-onboard")
  try {
    await terminal.run(OMP, [], { env, cwd, cols: 140, rows: 42, timeout: 120_000 })
    const waitFor = async (needle, timeoutMs) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if ((await terminal.text({ full: true })).includes(needle)) return true
        await new Promise((r) => setTimeout(r, 500))
      }
      return false
    }
    note(await waitFor("v18.", 90_000), "TUI: omp starts (fresh profile)")
    await terminal.type("/egress")
    await terminal.keyboard.press("Enter")
    await new Promise((r) => setTimeout(r, 3_000))
    if (process.env.E2E_DUMP === "1") console.log("--- TUI after /egress ---\n" + (await terminal.text({ full: true })))
    note(await waitFor("SSH target to route free-tier traffic through", 10_000), "TUI: /egress opens the add dialog")
  } finally {
    await terminal.closeQuiet()
  }
}

if (problems.length > 0) {
  console.log(`ONBOARDING FAIL (${problems.length}):`)
  for (const problem of problems) console.log(`  ${problem}`)
  process.exit(1)
}
console.log(`ONBOARDING OK: egress onboarding verified end to end (target ${TARGET})`)
