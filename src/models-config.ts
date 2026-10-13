// User-level models.yml maintainer.
//
// omp's request path honors `~/.omp/agent/models.yml` provider overrides — the
// one lane that applies to every model resolution path (extension projections
// are skipped by some runners). This module keeps managed blocks for BOTH
// OpenCode providers so inference always carries:
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
import { providerOverride } from "./console-config"
import {
  DEFAULT_IDENTITY,
  newTrace,
  projectID,
  sessionID,
  spanHeaders,
  userAgent,
  ZEN_BASE,
  ZEN_GO_BASE,
  type HarnessIdentity,
} from "./wire"

const BEGIN = "# >>> omp-go managed block (do not edit) >>>"
const END = "# <<< omp-go managed block <<<"
const HARNESS_BODY_COMPAT = ["supportsReasoningEffort: false", "supportsStore: true"]
const ZEN_BODY_COMPAT = ["supportsReasoningEffort: false", "supportsStore: false"]
const PROVIDERS = [
  { id: "opencode-go", fallbackURL: ZEN_GO_BASE, freeTier: false, compat: HARNESS_BODY_COMPAT },
  // The free tier serves both id spellings (models.dev `opencode`, runtime
  // alias `opencode-zen`); key both so the override lands either way.
  { id: "opencode", fallbackURL: ZEN_BASE, freeTier: true, compat: ZEN_BODY_COMPAT },
  { id: "opencode-zen", fallbackURL: ZEN_BASE, freeTier: true, compat: ZEN_BODY_COMPAT },
] as const

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

export function writeModelsOverride(input: { orgId?: string; identity?: HarnessIdentity } = {}): void {
  const identity = input.identity ?? DEFAULT_IDENTITY
  const ids = stableIds()
  // Fresh trace ids per process — the harness groups one run's requests under
  // one trace with a span per request; a static file can't vary per request,
  // but per-process ids keep every run's ids new (never a permanent constant).
  const trace = spanHeaders(newTrace())
  const entries = PROVIDERS.map(({ id, fallbackURL, freeTier, compat }) => {
    const override = providerOverride(input.orgId, id)
    const orgId = input.orgId ?? override.headers["x-opencode-org-id"]
    return [
      `  ${id}:`,
      `    baseUrl: ${(override.baseURL ?? fallbackURL).replace(/\/+$/, "")}`,
      // The harness's unauthenticated free-tier key (OpencodePlugin sets
      // `apiKey: "public"` when no credential is present); the gateway accepts
      // it with the harness fingerprint, and a /login credential wins anyway.
      ...(freeTier ? [`    apiKey: "public"`] : []),
      `    compat:`,
      ...compat.map((line) => `      ${line}`),
      "    headers:",
      `      user-agent: ${userAgent(identity)}`,
      `      accept: "*/*"`,
      `      x-opencode-client: ${identity.name}`,
      `      x-opencode-project: ${ids.project}`,
      `      x-opencode-session: ${ids.session}`,
      `      x-opencode-session-id: ${ids.session}`,
      `      x-session-affinity: ${ids.session}`,
      `      x-session-id: ${ids.session}`,
      ...Object.entries(trace).map(([name, value]) => `      ${name}: ${value}`),
      ...(orgId ? [`      x-opencode-org-id: ${orgId}`] : []),
    ].join("\n")
  })
  const block = [BEGIN, "providers:", ...entries, END].join("\n")

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
  // one for other providers, merge the entries instead of nesting a second map.
  const entriesOnly = block.slice(block.indexOf("\n") + 1).replace(/^providers:\n/, "")
  const merged = withoutOurs.includes("providers:")
    ? `${withoutOurs}\n${entriesOnly}\n`
    : `${withoutOurs}${withoutOurs ? "\n\n" : ""}${block}\n`
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, merged, { mode: 0o600 })
  } catch {
    // Best-effort: the plugin still works without the static override.
  }
}
