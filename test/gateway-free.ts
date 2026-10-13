// Live acceptance for OpenCode's free tier (network required).
//
// The user-visible scenario: real `omp`, no login, `opencode-free/<model>` —
// a chat completes against the real gateway. The gateway fingerprint-checks
// traffic (header order/case + session-id encoding — see src/ordered-fetch.ts),
// so this passing end to end IS the feature working.
//
//   bun test/gateway-free.ts

import { spawn } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
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

// EGRESS_CONFIG=1 seeds the real egress host list so omp opens the ssh
// tunnels itself (the pure product path: /egress add + auto-tunneling).
const egressConfig = `${process.env.HOME ?? ""}/.omp/agent/omp-go-egress.json`
if (process.env.EGRESS_CONFIG === "1" && existsSync(egressConfig)) {
  mkdirSync(`${home}/.omp/agent`, { recursive: true })
  copyFileSync(egressConfig, `${home}/.omp/agent/omp-go-egress.json`)
}

const timeoutMs = Number(process.env.FREE_TIMEOUT ?? 90_000)
const { promise: finished, resolve: settle, reject: fail } = Promise.withResolvers<{ code: number | null; output: string }>()
const child = spawn(
  OMP,
  ["run", "--print", "--no-title", "--extension", path.join(REPO, "src", "index.ts"), `--model=${MODEL}`, "Reply with exactly: FREE TIER OK"],
  { env, cwd: REPO, detached: true },
)
let output = ""
child.stdout?.on("data", (chunk) => (output += chunk))
child.stderr?.on("data", (chunk) => (output += chunk))
const killer = setTimeout(() => {
  // Kill the whole process group: omp's service daemon keeps stdio open and
  // would otherwise outlive the timeout with the pipes pinned.
  try { process.kill(-child.pid!, "SIGKILL") } catch { child.kill("SIGKILL") }
}, timeoutMs)
child.on("error", fail)
child.on("exit", (code) => {
  clearTimeout(killer)
  settle({ code, output })
})
const { code, output: result } = await finished
console.log(result.trim())
const ok = code === 0 && result.includes("FREE TIER OK")
if (!ok) {
  console.error("GATEWAY FAIL: free-tier chat did not complete end to end")
  console.error(`profile kept at ${home} (omp logs: ${home}/.local/state/omp)`)
  process.exit(1)
}
console.log(`GATEWAY OK: ${MODEL} completed keyless against the real free tier`)
rmSync(home, { recursive: true, force: true })
