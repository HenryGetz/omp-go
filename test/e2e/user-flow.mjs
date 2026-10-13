// Definitive user-flow test: install from GitHub into a fresh profile, then
// drive real `omp` from a NEUTRAL cwd (not the repo) and chat on the free tier.
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { TuiTest } from "@microsoft/tui-test"

const home = mkdtempSync(tmpdir() + "/userflow-home-")
const neutral = mkdtempSync(tmpdir() + "/userflow-cwd-") // NOT the repo
writeFileSync(neutral + "/notes.txt", "just a scratch dir with no package.json")


const env = {
  ...process.env,
  HOME: home,
  XDG_DATA_HOME: home + "/.local/share",
  XDG_CONFIG_HOME: home + "/.config",
  XDG_STATE_HOME: home + "/.local/state",
  XDG_CACHE_HOME: home + "/.cache",
}
delete env.OPENCODE_API_KEY

// Pre-seed the profile config: skip omp's first-run onboarding so the terminal
// opens straight into chat (same trick the repo e2e uses).
mkdirSync(home + "/.omp/agent", { recursive: true })
writeFileSync(home + "/.omp/agent/config.yml", "setupVersion: 2\n")

// 1. The exact install command from the README, against GitHub.
const install = spawnSync("omp", ["plugin", "install", "github:HenryGetz/omp-go"], {
  env, encoding: "utf8", timeout: 180_000,
})
console.log("== install ==");
console.log(`${install.stdout ?? ""}${install.stderr ?? ""}`.trim().split("\n").slice(-3).join("\n"))

const list = spawnSync("omp", ["plugin", "list"], { env, encoding: "utf8", timeout: 60_000 })
console.log("== plugin list ==");
console.log((list.stdout ?? "").trim().split("\n").filter((l) => l.includes("omp-go") || l.includes("omp@")).join("\n"))

// 2. Real omp in a real terminal, from the neutral cwd.
const t = TuiTest.ephemeral("userflow-free")
await t.run("omp", ["--model", "opencode-free/mimo-v2.6-flash-free"], {
  env, cwd: neutral, cols: 140, rows: 42, timeout: 120_000,
})
const waitFor = async (needle, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await t.text({ full: true })).includes(needle)) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}
await waitFor("v18.", 90_000)
await t.type("What is 17*13? Reply with just the product.")
await t.submit()
// "221" cannot appear in the prompt echo — it is only producible by the model.
const got = await waitFor("221", 120_000)
if (!got) {
  console.log("USERFLOW FAIL: no completion rendered")
  console.log((await t.text({ full: true })).split("\n").slice(-14).join("\n"))
  await t.closeQuiet()
  process.exit(1)
}
const screen = await t.text({ full: true })
console.log("== terminal ==");
console.log(screen.split("\n").filter((l) => l.trim()).slice(-12).join("\n"))
console.log("USERFLOW OK: github:HenryGetz/omp-go install + real omp (neutral cwd) + keyless free chat rendered (answer 221)")
await t.closeQuiet()
process.exit(0)
