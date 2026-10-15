// Console config mirror: the harness polls GET {console}/api/v2/config every
// minute (OpencodePlugin.fetchConfig) and merges each provider's pushed
// `headers` / `settings.baseURL` into its requests. omp does the same here so
// both stay on the wire the Console dictates — today that means per-org
// `x-opencode-org-id` and the /inference/go/openai/v1 endpoint, and it keeps
// matching the harness automatically if the Console ever pushes more.
//
// The snapshot is persisted per profile (omp runs are short-lived processes,
// so an in-memory cache would serve every first request cold) with a 60s TTL:
// stale entries are served immediately while a background refresh runs, and a
// failed refresh keeps the last known config — exactly like the harness keeps
// its last snapshot.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { withStateLock } from "./state-lock"
import { homedir } from "node:os"
import path from "node:path"
import { fetchConsoleConfig, type HarnessIdentity } from "./wire"

export type ProviderOverride = {
  headers: Record<string, string>
  baseURL: string | undefined
}

export type ConsoleConfigSnapshot = {
  providers: Record<string, { headers?: Record<string, string>; settings?: { baseURL?: string } }>
  fetchedAt: number
}

const TTL_MS = 60_000
const snapshots = new Map<string, ConsoleConfigSnapshot>()

function cacheFile(): string {
  return path.join(homedir(), ".omp", "agent", "omp-go-console-config.json")
}

/**
 * One org's cached Console config plus whether it really belongs to the
 * requested key. A `false` here means the freshest-snapshot fallback matched
 * ANOTHER account's entry: callers may use its org-neutral values (endpoint,
 * harness fingerprint) but never its org attribution.
 */
type LoadedSnapshot = { snapshot: ConsoleConfigSnapshot; exact: boolean }

function loadSnapshot(key: string): LoadedSnapshot | undefined {
  const cached = snapshots.get(key)
  if (cached) return { snapshot: cached, exact: true }
  try {
    const parsed = JSON.parse(readFileSync(cacheFile(), "utf8")) as Record<string, ConsoleConfigSnapshot>
    // Exact org first; otherwise the freshest entry — callers without an org
    // (registration-time writes) must still see the Console-driven endpoint
    // instead of silently regressing to the catalog URL.
    const exact = parsed[key]
    if (exact?.providers) {
      snapshots.set(key, exact)
      return { snapshot: exact, exact: true }
    }
    const freshestKey = Object.keys(parsed)
      .filter((candidate) => parsed[candidate]?.providers)
      .toSorted((a, b) => parsed[b].fetchedAt - parsed[a].fetchedAt)[0]
    const entry = freshestKey === undefined ? undefined : parsed[freshestKey]
    if (!entry?.providers) return undefined
    // Memoize under the key it came from — memoizing it under ours would make
    // the next refresh call believe this org has a fresh config and skip it.
    snapshots.set(freshestKey, entry)
    return { snapshot: entry, exact: false }
  } catch {
    // No cache yet; callers fall back to defaults and a refresh fills it.
  }
  return undefined
}

function saveSnapshot(key: string, snapshot: ConsoleConfigSnapshot): void {
  snapshots.set(key, snapshot)
  try {
    mkdirSync(path.dirname(cacheFile()), { recursive: true })
    let all: Record<string, ConsoleConfigSnapshot> = {}
    try {
      all = JSON.parse(readFileSync(cacheFile(), "utf8")) as Record<string, ConsoleConfigSnapshot>
    } catch {
      all = {}
    }
    all[key] = snapshot
    withStateLock(() => writeFileSync(cacheFile(), JSON.stringify(all), { mode: 0o600 }))
  } catch {
    // Cache persistence is best-effort; the in-memory copy still serves.
  }
}

/**
 * Attribution rule for a cached Console snapshot. Only the snapshot matching
 * the requested org (`exact`) may contribute `x-opencode-org-id`; the
 * freshest-entry fallback belongs to a FOREIGN account, whose org-neutral
 * values (endpoint, harness fingerprint) are safe to reuse but whose org stamp
 * is not — a bearer paired with an org it is not a member of is the gateway's
 * `402 … Insufficient account funds`.
 */
export function orgScopedHeaders(headers: Record<string, string>, exact: boolean): Record<string, string> {
  if (exact) return headers
  const kept: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers))
    if (name.toLowerCase() !== "x-opencode-org-id") kept[name] = value
  return kept
}

export function providerOverride(orgId: string | undefined, providerID: string): ProviderOverride {
  const loaded = loadSnapshot(orgId ?? "default")
  // The Console names the free/zen lane "opencode" (the harness's provider
  // id); we register it as "opencode-free". Missing the push means falling
  // back to the wrong endpoint path, which the free gateway rejects with
  // `FreeTierError` ("can only be used from within OpenCode").
  const key = providerID === "opencode-free" ? "opencode" : providerID
  const provider = loaded?.snapshot.providers[key]
  return {
    headers: orgScopedHeaders(provider?.headers ?? {}, loaded?.exact !== false),
    baseURL: provider?.settings?.baseURL,
  }
}

/**
 * Refresh one org's config and cache the result. Callers proceed immediately;
 * the next request picks up the merge. The cache serves stale entries past the
 * TTL until a refresh lands, so a cold process never waits on the network.
 */
export function refreshConsoleConfig(input: {
  consoleBase: string
  token: string
  orgId: string | undefined
  identity?: HarnessIdentity
  cacheKey?: string
  fetch?: typeof fetch
}): Promise<void> {
  const key = input.cacheKey ?? input.orgId ?? "default"
  const previous = loadSnapshot(key)
  // Only the org's OWN snapshot proves it is fresh; a foreign fallback means
  // this key has never been fetched and must be.
  if (previous?.exact && Date.now() - previous.snapshot.fetchedAt < TTL_MS) return Promise.resolve()
  return fetchConsoleConfig(input.consoleBase, { token: input.token, orgId: input.orgId }, {
    identity: input.identity,
    fetch: input.fetch,
  })
    .then(async (response) => {
      if (!response.ok) return
      const body = (await response.json().catch(() => undefined)) as
        | { providers?: ConsoleConfigSnapshot["providers"] }
        | undefined
      if (!body?.providers) return
      saveSnapshot(key, { providers: body.providers, fetchedAt: Date.now() })
    })
    .catch(() => undefined)
}
