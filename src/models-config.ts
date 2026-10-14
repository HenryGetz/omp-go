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
import { withStateLock } from "./state-lock"
import { GO_CATALOG, OPENCODE_CATALOG, thinkingOverrides } from "./models"
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
const STAMP = "# generated: "
const END = "# <<< omp-go managed block <<<"
// Provider-level body compat. `supportsReasoningEffort` is deliberately NOT
// set here: the free lane's models come from the extension's own registration
// (src/models.ts), which carries the correct PER-MODEL value (true for
// catalog effort models with their max default; false otherwise). A
// provider-level key would out-rank it (mergeCompat: provider wins), and the
// `modelOverrides` that rescue the go lane do not reach extension-registered
// models. `supportsStore` differs per lane (golden captures).
const HARNESS_BODY_COMPAT = ["supportsReasoningEffort: false", "supportsStore: true"]
const FREE_BODY_COMPAT = ["supportsStore: false"]
const PROVIDERS = [
  {
    id: "opencode-go",
    fallbackURL: ZEN_GO_BASE,
    freeTier: false,
    compat: HARNESS_BODY_COMPAT,
    catalog: GO_CATALOG,
  },
  // The free tier: zero-cost catalog models, keyless (`Bearer public`).
  {
    id: "opencode-free",
    fallbackURL: ZEN_BASE,
    freeTier: true,
    compat: FREE_BODY_COMPAT,
    catalog: OPENCODE_CATALOG,
  },
] as const

// Respect $HOME like every other tool (Bun's homedir() prefers /etc/passwd,
// which breaks profile-isolated runs and tests).
function agentHome(): string {
  return process.env.HOME || homedir()
}

function modelsFile(): string {
  return path.join(agentHome(), ".omp", "agent", "models.yml")
}

// Stable identity for static attribution headers; persisted so it does not
// churn between runs (the harness's ids are stable per session/project too).
function stableIds(): { session: string; project: string } {
  const file = path.join(agentHome(), ".omp", "agent", "omp-go-wire-ids.json")
  try {
    return JSON.parse(readFileSync(file, "utf8")) as { session: string; project: string }
  } catch {
    const ids = { session: sessionID(), project: projectID() }
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      // Create-exclusive: when two fresh processes race, one writes and the
      // other re-reads, so every process shares one stable pair.
      writeFileSync(file, JSON.stringify(ids), { mode: 0o600, flag: "wx" })
      return ids
    } catch {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as { session: string; project: string }
      } catch {
        // Best-effort; ids regenerate per run when persistence fails.
        return ids
      }
    }
  }
}

/**
 * Session-start fast path: rewrite only when the managed block is missing or
 * stale. The full rewrite takes the state lock and rewrites the file — too
 * heavy for every session start (a slow start pushes sibling extension
 * handlers past their timeout budget).
 */
export function ensureModelsOverride(
  input: { orgId?: string; identity?: HarnessIdentity } = {},
  maxAgeMs = 60 * 60 * 1000,
): void {
  try {
    const content = readFileSync(modelsFile(), "utf8")
    const at = content.indexOf(BEGIN)
    const stop = content.indexOf(END, at)
    if (at >= 0 && stop > at) {
      const stamp = new RegExp(`${STAMP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)`).exec(content.slice(at, stop))
      if (stamp && Date.now() - Number(stamp[1]) < maxAgeMs) return
    }
  } catch {
    // Missing or unreadable: regenerate below.
  }
  writeModelsOverride(input)
}

export function writeModelsOverride(input: { orgId?: string; identity?: HarnessIdentity } = {}): void {
  const identity = input.identity ?? DEFAULT_IDENTITY
  const ids = stableIds()
  // Fresh trace ids per process — the harness groups one run's requests under
  // one trace with a span per request; a static file can't vary per request,
  // but per-process ids keep every run's ids new (never a permanent constant).
  const trace = spanHeaders(newTrace())
  const entries = PROVIDERS.map(({ id, fallbackURL, freeTier, compat, catalog }) => {
    const override = providerOverride(input.orgId, id)
    const orgId = input.orgId ?? override.headers["x-opencode-org-id"]
    const thinking = thinkingOverrides(catalog)
    return [
      `  ${id}:`,
      `    baseUrl: ${(override.baseURL ?? fallbackURL).replace(/\/+$/, "")}`,
      // The harness's unauthenticated free-tier key (OpencodePlugin sets
      // `apiKey: "public"` when no credential is present); the gateway accepts
      // it with the harness fingerprint, and a /login credential wins anyway.
      // The fingerprint itself (header order + session ids) is stamped at the
      // transport layer by src/ordered-fetch.ts; these values cover the
      // non-stream paths.
      ...(freeTier ? [`    apiKey: "public"`] : []),
      `    compat:`,
      ...compat.map((line) => `      ${line}`),
      // Per-model reasoning surface (out-ranks the provider compat above):
      // effort-capable models carry `reasoning_effort` — or
      // `reasoning: {effort, summary:"auto"}` on the Responses protocol —
      // defaulted to the model's HIGHEST rung. The harness's own default
      // variant is its lightest (`values[0]`, what the Console shows as
      // `effort · low`); "max out quality" pins ours to the top of each
      // ladder. Models without an effort surface get no entry and stay
      // fieldless, like the harness.
      ...(thinking.length > 0
        ? [
            `    modelOverrides:`,
            ...thinking.flatMap(({ id: modelID, thinking: config }) => [
              `      "${modelID}":`,
              `        thinking:`,
              `          mode: ${config.mode}`,
              `          efforts: [${config.efforts.join(", ")}]`,
              `          defaultLevel: ${config.defaultLevel ?? config.efforts[config.efforts.length - 1]}`,
              `        compat:`,
              `          supportsReasoningEffort: true`,
            ]),
          ]
        : []),
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
      // NO x-opencode-org-id here, ever: a static org stamp outlives the
      // per-request credential, and the gateway answers a token that is not a
      // member of that org with `403 Workspace access denied` (verified against
      // both real accounts). The org rides the serving credential only — see
      // wireStream's per-attempt injection.
    ].join("\n")
  })
  const block = [BEGIN, `${STAMP}${Date.now()}`, "providers:", ...entries, END].join("\n")

  const file = modelsFile()
  withStateLock(() => {
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
  })
}
