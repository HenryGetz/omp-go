// Live acceptance for OpenCode's free tier (network required).
//
// The user-visible scenario: real `omp`, no login, `opencode-free/<model>` —
// a chat completes against the real gateway. The gateway fingerprint-checks
// traffic (header order/case + session-id encoding — see src/ordered-fetch.ts),
// so this passing end to end IS the feature working.
//
//   bun test/gateway-free.ts

import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const OMP = process.env.OMP_BIN ?? "omp"
const MODEL = process.env.FREE_MODEL ?? "opencode-free/mimo-v2.6-flash-free"
const home = mkdtempSync(path.join(tmpdir(), "omp-free-gate-"))

const env: Record<string, string | undefined> = {
  ...process.env,
  HOME: home,
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_STATE_HOME: path.join(home, ".local", "state"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
}
delete env.OPENCODE_API_KEY
delete env.OMP_GO_CONSOLE
delete env.OMP_GO_BASE
delete env.OMP_GO_FREE

const result = spawnSync(
  OMP,
  ["run", "--print", "--no-title", `--extension`, path.join(REPO, "src", "index.ts"), `--model=${MODEL}`, "Reply with exactly: FREE TIER OK"],
  { env, cwd: REPO, encoding: "utf8", timeout: Number(process.env.FREE_TIMEOUT ?? 90_000) },
)
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
console.log(output.trim())
const ok = result.status === 0 && output.includes("FREE TIER OK")
if (!ok) {
  console.error("GATEWAY FAIL: free-tier chat did not complete end to end")
  console.error(`profile kept at ${home} (omp logs: ${home}/.local/state/omp)`)
  process.exit(1)
}
console.log(`GATEWAY OK: ${MODEL} completed keyless against the real free tier`)
rmSync(home, { recursive: true, force: true })
