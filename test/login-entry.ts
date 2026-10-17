// Registration-surface coverage for the single OpenCode /login entry.
//
// Deterministic, offline: it drives the real extension seam (fake `pi`
// mirroring the host's registerProvider internals) and asserts the surface
// /login renders from:
//   1. exactly ONE login row matching /opencode/i, named and id'd
//      "OpenCode Go" — the host prints the raw provider id in
//      "Logging in to …" / "Successfully logged in to …" and the dialog
//      title is `name ?? id`, so the id doubles as the label;
//   2. that row dispatches OUR device flow (the id must miss pi-catalog's
//      builtin registry, where builtin-first dispatch would run the
//      paste-a-key flow), stores the grant under "opencode-go" so both lanes
//      read it, and NO registration exposes an api-key-style login;
//   3. the go lane keeps oauth-backed refresh/getApiKey/modifyModels via the
//      custom-map KEY (untouched by the row retirement) and the free lane
//      keeps its keyless "public" fallback with no login row of its own;
//   4. the legacy rows are gone from the provider list while the builtin
//      registry DEFS stay intact (models and credential lookups resolve).
//
// Run: bun test/login-entry.ts

import assert from "node:assert/strict"
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry"
import { getOAuthProvider, getOAuthProviders, registerOAuthProvider } from "@oh-my-pi/pi-ai/registry/oauth"
import { LOGIN_PROVIDER_ID, registerOpencodeGo } from "../src/register"

// The fake `pi` mirrors the host's registerProvider internals
// (model-registry.ts): oauth configs land in pi-ai's real custom map — the
// same map the row-retirement step mutates and this test reads.
const registered = new Map<string, ProviderConfig>()
const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
const fakePi = {
  registerProvider: (name: string, config: ProviderConfig) => {
    registered.set(name, config)
    if (config.oauth) registerOAuthProvider({ ...config.oauth, id: name, sourceId: "login-entry-test" })
  },
  registerTool: () => undefined,
  getActiveTools: () => ["read", "edit", "glob", "grep", "write"],
  setActiveTools: () => undefined,
  on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
} as unknown as ExtensionAPI

registerOpencodeGo(fakePi)

// ── 1. exactly one OpenCode row, coherent everywhere ─────────────────────────
const opencodeRows = getOAuthProviders().filter((row) => /opencode/i.test(`${row.name} ${row.id}`))
assert.equal(
  opencodeRows.length,
  1,
  `expected one OpenCode login row, got: ${opencodeRows.map((row) => `${row.name} (${row.id})`).join(", ")}`,
)
const [entry] = opencodeRows
assert.equal(entry.name, LOGIN_PROVIDER_ID, "picker row display name is OpenCode Go")
assert.equal(entry.id, LOGIN_PROVIDER_ID, "row id doubles as the printed label (Logging in to …)")
assert.equal(entry.storeCredentialsAs, "opencode-go", "grant routes to both lanes")

// Gone by id as well, independent of any search text.
for (const gone of ["opencode-go", "opencode-zen", "opencode-free"]) {
  assert.equal(
    getOAuthProviders().find((row) => row.id === gone),
    undefined,
    `legacy row ${gone} still listed`,
  )
}

// ── 2. device-flow dispatch, no api-key-style entry from us ──────────────────
assert.equal(
  getProviderDefinition(LOGIN_PROVIDER_ID),
  undefined,
  "entry id must miss pi-catalog's builtin registry (builtin-first dispatch would run paste-a-key)",
)
const entryConfig = registered.get(LOGIN_PROVIDER_ID)
assert.ok(entryConfig?.oauth, "the OpenCode Go registration files the oauth")
const deviceLogin = entryConfig.oauth!.login
assert.equal(typeof deviceLogin, "function", "entry runs a login flow")
assert.equal(
  getOAuthProvider(LOGIN_PROVIDER_ID)?.login,
  deviceLogin,
  "custom map serves the device flow for dispatch",
)
for (const [name, config] of registered) {
  if (!config.oauth) continue
  assert.equal(config.oauth.login, deviceLogin, `${name} files a login that is not the shared device flow`)
}

// ── 3. both lanes fed from one credential store ──────────────────────────────
const goConfig = registered.get("opencode-go")
assert.ok(goConfig?.oauth, "go lane keeps oauth (validation + refresh/getApiKey/modifyModels)")
assert.ok(goConfig.oauth!.refreshToken, "go lane refresh present")
assert.ok(goConfig.oauth!.getApiKey, "go lane api-key conversion present")
assert.ok(goConfig.oauth!.modifyModels, "go lane catalog projection present")
const freeConfig = registered.get("opencode-free")
assert.equal(freeConfig?.apiKey, "public", "free lane keyless fallback")
assert.equal(freeConfig?.oauth, undefined, "free lane registers no login row")
// The go lane's registration retires its LISTED row (mutated id/name) but the
// custom map stays keyed "opencode-go", which is what refresh/getApiKey and
// credential lookups resolve by.
const goLaneEntry = getOAuthProvider("opencode-go")
assert.ok(goLaneEntry, "custom map key opencode-go intact after row retirement")
assert.equal(goLaneEntry!.refreshToken, goConfig.oauth!.refreshToken, "key lookup serves the device refresh")
assert.notEqual(goLaneEntry!.id, "opencode-go", "go lane row id retired off the opencode search")

// ── 4. registry defs untouched (models, logout credential mapping) ───────────
assert.ok(getProviderDefinition("opencode-go"), "builtin opencode-go def intact")
assert.ok(getProviderDefinition("opencode-zen"), "builtin opencode-zen def intact")

// ── 5. the host queue cycle: flush re-stores the entry, session hooks retire again ─
// During extension loading the host only QUEUES registerProvider; the session
// init flush spreads the oauth config fresh (id forced back to the provider
// name), and session_start fires afterwards. The retirement must re-apply.
registerOAuthProvider({
  ...registered.get("opencode-go")!.oauth!,
  id: "opencode-go",
  sourceId: "queue-replay",
})
assert.ok(
  getOAuthProviders().find((row) => row.id === "opencode-go"),
  "precondition: the flush reset the go lane row id",
)
await handlers.get("session_start")!({}, { modelRegistry: {} })
assert.equal(
  getOAuthProviders().find((row) => row.id === "opencode-go"),
  undefined,
  "session_start retirement re-applies after the registration flush",
)

console.log(
  "LOGIN-ENTRY OK: one OpenCode Go device-flow row, both lanes routed through opencode-go, legacy rows retired",
)
