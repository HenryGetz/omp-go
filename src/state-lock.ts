// Cross-process advisory lock for the plugin's shared state files.
//
// Several omp processes run concurrently (every `omp run`, every TUI, every
// subagent) and all of them update the same sidecars: routing state, account
// verdicts, session pins, the token->org index, and the managed models.yml
// block. Each update is read-modify-write; without coordination two writers
// interleave and one's change is silently lost (or the file is torn).
//
// The lock is a create-exclusive lockfile (`wx`) held around each mutation.
// Writes are microseconds and contention is rare, so a short synchronous spin
// is enough; a lock older than STALE_MS is stolen (a crashed process must not
// wedge the pool). The critical sections must stay small and must never
// perform network I/O.

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const STALE_MS = 5_000
const SPIN_MS = 2
const MAX_WAIT_MS = 2_000

function lockFile(): string {
  return path.join(process.env.HOME || homedir(), ".omp", "agent", "omp-go-state.lock")
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Run `fn` while holding the shared-state lock. Synchronous by design (the
// writers are sync call sites deep in the request path); spins briefly under
 * contention and steals a stale lock left by a crashed process.
 */
export function withStateLock<T>(fn: () => T): T {
  const file = lockFile()
  try {
    mkdirSync(path.dirname(file), { recursive: true })
  } catch {
    // Fall through: the open below reports the real failure.
  }
  const deadline = Date.now() + MAX_WAIT_MS
  let held: number | undefined
  for (;;) {
    try {
      held = openSync(file, "wx")
      break
    } catch {
      // Steal a stale lock (holder crashed) or spin briefly.
      try {
        const raw = readFileSync(file, "utf8")
        const since = Number(raw) || 0
        if (Date.now() - since > STALE_MS) rmSync(file, { force: true })
      } catch {
        // Racing another stealer; the loop retries.
      }
      if (Date.now() > deadline) break
      sleep(SPIN_MS)
    }
  }
  if (held === undefined) {
    // Could not take the lock in time: run anyway (availability over
    // serialization — the mutation stays rename-atomic, only lost updates
    // are possible, and a wedged pool is worse).
    return fn()
  }
  try {
    writeFileSync(file, String(Date.now()))
    return fn()
  } finally {
    try {
      closeSync(held)
    } catch {
      // Already closed.
    }
    try {
      unlinkSync(file)
    } catch {
      // Another process may have stolen it; nothing to do.
    }
  }
}
