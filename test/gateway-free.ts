// Live acceptance for OpenCode's free tier (network required).
//
// The user-visible scenario: real `omp`, no login, `opencode-free/<model>` —
// chats complete against the real gateway AND a real tool call executes end to
// end. The gateway fingerprint-checks the request's `tools` array (the harness
// surface — see src/tool-mirror.ts) on top of header order/case and session-id
// encoding (src/ordered-fetch.ts), so this passing IS the feature working: the
// keyless free lane must gate-pass with omp's tools fully functional.
//
//   bun test/gateway-free.ts

import { spawn } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const OMP = process.env.OMP_BIN ?? "omp"
const MODEL = process.env.FREE_MODEL ?? "opencode-free/mimo-v2.6-flash-free"
const home = mkdtempSync(path.join(tmpdir(), "omp-free-gate-"))

// A prior stub-driven test (parity/e2e) can leave a Console-config snapshot
// pointing at a dead local stub endpoint; the free lane would then dial that
// stub instead of the real gateway. Clear it wherever the extension may read it.
for (const dir of [home, homedir()]) {
  rmSync(path.join(dir, ".omp", "agent", "omp-go-console-config.json"), { force: true })
}

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

const timeoutMs = Number(process.env.FREE_TIMEOUT ?? 210_000)
const attempts = Number(process.env.FREE_ATTEMPTS ?? 2)

/** One keyless free-tier turn against the real gateway. */
async function runOmp(label: string, prompt: string, extraArgs: string[] = []): Promise<{ code: number | null; output: string }> {
  const outPath = path.join(home, `omp-output-${label}.txt`)
  const outFd = openSync(outPath, "w")
  const { promise: finished, resolve: settle } = Promise.withResolvers<number | null>()
  const child = spawn(
    OMP,
    ["run", "--print", "--no-title", "--extension", path.join(REPO, "src", "index.ts"), `--model=${MODEL}`, ...extraArgs, prompt],
    { env, cwd: REPO, detached: true, stdio: ["ignore", outFd, outFd] },
  )
  const killer = setTimeout(() => {
    // Group-kill: omp's service daemon outlives the run and would hold pipes.
    try { process.kill(-child.pid!, "SIGKILL") } catch { child.kill("SIGKILL") }
  }, timeoutMs)
  child.on("exit", (code) => {
    clearTimeout(killer)
    settle(code)
  })
  const code = await finished
  return { code, output: readFileSync(outPath, "utf8").trim() }
}

const failures: string[] = []

// One run proves both halves: the gateway accepts the free-lane request (the
// harness tool surface gate) and a real tool call executes end to end. The
// marker reaches the reply only when omp's shell executor actually ran. Free
// models occasionally answer without calling the tool, so retry the attempt.
const prompt =
  'Run the shell tool exactly once with command "echo FREE_TOOL_OK" (do not call any other tool). ' +
  "Then reply with the command's stdout verbatim and nothing else."
let last: { code: number | null; output: string } | undefined
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  last = await runOmp(`tool-${attempt}`, prompt)
  console.log(`[tool ${attempt}] ${last.output}`)
  if (last.code === 0 && last.output.includes("FREE_TOOL_OK")) break
}
if (!last || last.code !== 0 || !last.output.includes("FREE_TOOL_OK"))
  failures.push("free-tier tool call (shell) did not execute end to end")
if (last?.output.includes("FreeTierError")) failures.push("gateway rejected the free-lane request (FreeTierError)")

if (failures.length > 0) {
  for (const failure of failures) console.error(`GATEWAY FAIL: ${failure}`)
  console.error(`profile kept at ${home}`)
  process.exit(1)
}
console.log(`GATEWAY OK: ${MODEL} completed keyless against the real free tier, including a shell tool call`)
rmSync(home, { recursive: true, force: true })
