// User-level models.yml maintainer.
//
// omp's request path honors `~/.omp/agent/models.yml` provider overrides — the
// one lane that applies to every model resolution path (extension projections
// are skipped by some runners). This module keeps an `opencode-go` override
// block in that file so inference always carries:
//   - the Console-config endpoint (falls back to the catalog URL),
//   - the harness User-Agent (`opencode/<channel>/<version>/<name>`),
//   - the session/project attribution headers with harness-shaped stable ids,
//   - the org attribution header of the primary workspace.
//
// The block is ours; anything else in the file (other providers, user edits
// outside the block) is preserved. Dynamic per-request values (b3/traceparent,
// per-account org) cannot live in a static file — the bearer token carries the
// account identity server-side, and trace headers are deliberately omitted
// rather than frozen into a detectable constant.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { DEFAULT_IDENTITY, projectID, sessionID, userAgent, ZEN_GO_BASE, type HarnessIdentity } from "./wire"

const BEGIN = "# >>> omp-go managed block (do not edit) >>>"
const END = "# <<< omp-go managed block <<<"

function modelsFile(): string {
  return path.join(homedir(), ".omp", "agent", "models.yml")
}

// Stable identity for static attribution headers; persisted so it does not
// churn between runs (the harness's ids are stable per session/project too).
function stableIds(): { session: string; project: string } {
  const file = path.join(homedir(), ".omp", "agent", "omp-go-wire-ids.json")
  try {
    return JSON.parse(readFileSync(file, "utf8")) as { session: string; project: string }
  } catch {
    const ids = { session: sessionID(), project: projectID() }
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(ids), { mode: 0o600 })
    } catch {
      // Best-effort; ids regenerate per run when persistence fails.
    }
    return ids
  }
}

export function writeModelsOverride(input: {
  baseURL?: string
  orgId?: string
  identity?: HarnessIdentity
}): void {
  const identity = input.identity ?? DEFAULT_IDENTITY
  const ids = stableIds()
  const base = (input.baseURL ?? ZEN_GO_BASE).replace(/\/+$/, "")
  const block = [
    BEGIN,
    "providers:",
    `  ${OPENCODE_GO}:`,
    `    baseUrl: ${base}`,
    "    headers:",
    `      user-agent: ${userAgent(identity)}`,
    `      accept: "*/*"`,
    `      x-opencode-client: ${identity.name}`,
    `      x-opencode-project: ${ids.project}`,
    `      x-opencode-session: ${ids.session}`,
    `      x-opencode-session-id: ${ids.session}`,
    `      x-session-affinity: ${ids.session}`,
    `      x-session-id: ${ids.session}`,
    ...(input.orgId ? [`      x-opencode-org-id: ${input.orgId}`] : []),
    END,
  ].join("\n")

  const file = modelsFile()
  let content = ""
  try {
    content = readFileSync(file, "utf8")
  } catch {
    content = ""
  }
  // Index-based removal (the markers contain regex metacharacters): strip every
  // managed block, then append exactly one fresh block. Duplicate `providers:`
  // maps make YAML readers fall back to whichever key wins, so staleness here
  // is not cosmetic.
  let withoutOurs = content
  for (let at = withoutOurs.indexOf(BEGIN); at >= 0; at = withoutOurs.indexOf(BEGIN)) {
    const stop = withoutOurs.indexOf(END, at)
    withoutOurs = stop < 0 ? withoutOurs.slice(0, at) : withoutOurs.slice(0, at) + withoutOurs.slice(stop + END.length)
  }
  withoutOurs = withoutOurs.replace(/\n{3,}/g, "\n\n").trimEnd()
  // Our block carries its own `providers:` opener; when the file already has
  // one for other providers, merge the entry instead of nesting a second map.
  const entry = block.slice(block.indexOf("\n") + 1).replace(/^providers:\n/, "")
  const merged = withoutOurs.includes("providers:")
    ? `${withoutOurs}\n${entry}\n`
    : `${withoutOurs}${withoutOurs ? "\n\n" : ""}${block}\n`
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, merged, { mode: 0o600 })
  } catch {
    // Best-effort: the plugin still works without the static override.
  }
}

const OPENCODE_GO = "opencode-go"
