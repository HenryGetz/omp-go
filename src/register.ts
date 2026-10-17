// omp-native registration for OpenCode's model lanes: two providers share one
// wire fingerprint and one Console login.
//
//   opencode-go   — the Go subscription catalog (36 models, /zen/go/v1)
//   opencode-free — OpenCode's free tier: only the zero-cost catalog models
//                   (inference/v1), keyless via the harness's `Bearer public`
//
// Everything routed through these providers leaves omp shaped like the opencode
// harness: `streamSimple` injects the harness fingerprint (User-Agent,
// x-opencode-*, b3/traceparent) per request via pi-ai's `StreamOptions.headers`
// merge; `authorization` stays with omp's auth pipeline (`authHeader: true`) so
// refresh/rotation and auth-retry keep working. Free-tier models fall back to
// `Bearer public`, exactly like the harness without credentials.
//
// `api` must NOT be a built-in name when `streamSimple` is set: the host calls
// `registerCustomApi(config.api, …)` and pi-ai reserves built-in API names
// (that is a startup crash, not a warning). Models run under a custom API id
// and the wrapper rewrites the model to the built-in `openai-completions`
// before delegating — the request is then built by the stock OpenAI-compatible
// protocol with our headers on top.

import { appendFileSync } from "node:fs"
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"
// Import from the package root, never `@oh-my-pi/pi-ai/stream`. omp's extension
// loader only rewrites host-bundled specifiers that appear as explicit package
// exports; `./stream` matches pi-ai's `./*` catch-all, so a compiled host cannot
// resolve it and the extension fails to load ("Cannot find package
// '@oh-my-pi/pi-ai'"). The root re-exports `streamSimple` (`export * from "./stream"`).
import { buildModel } from "@oh-my-pi/pi-catalog/build"
import { streamSimple } from "@oh-my-pi/pi-ai"
import { getOAuthProvider, getOAuthProviders } from "@oh-my-pi/pi-ai/oauth"
import { harnessFetch } from "./ordered-fetch"
import type { Api, Model, SimpleStreamOptions, Context, AssistantMessageEventStream } from "@oh-my-pi/pi-ai"
import { orgScopedHeaders, providerOverride, refreshConsoleConfig } from "./console-config"
import { mapRegionGateErrors } from "./region"
import { writeModelsOverride } from "./models-config"
import { indexTokenOrg, OpencodeOAuthProvider, orgForToken } from "./opencode-provider"
import { mapDeprecationErrors } from "./dead-models"
import { catalogModels, fetchCatalogModels, fetchFreeModels, freeModels, usesResponsesAPI } from "./models"
import { OPENCODE_GO_PROVIDER, opencodeGoUsageProvider } from "./usage"
import {
  activateHarnessTools,
  activeExtraTools,
  registerCollidingHarnessTools,
  registerHarnessTools,
  rewriteFreeLanePayload,
} from "./tool-mirror"
import {
  CONSOLE_BASE,
  DEFAULT_IDENTITY,
  projectID,
  sessionHeaders,
  sessionID,
  ZEN_BASE,
  ZEN_GO_BASE,
  type HarnessIdentity,
  type SessionIdentity,
} from "./wire"

/** Custom API id registered for these providers; not a built-in name (reserved). */
export const WIRE_API = "opencode-go-wire"
const UPSTREAM_API = "openai-completions"

/** OpenCode free-tier provider id — free models only, never asks for a key. */
export const FREE_PROVIDER = "opencode-free"

/**
 * The plugin's own provider ids — the lanes whose traffic must carry the
 * harness fingerprint. Routing for `streamSimple` is keyed on the PROVIDER,
 * never on `model.api`: a model resolved through the host's model REGISTRY
 * (pi-catalog's built-in `opencode-go` rows carry `api: "openai-completions"`,
 * and that is what a preset's `pi.setModel` hands over) would fail an
 * `api === WIRE_API` check and drop out of the wrapper — no per-request
 * `x-opencode-org-id`, no fingerprint, no region-gate mapping, so the gateway
 * attributes the request by bearer alone and answers
 * `402 Upstream request failed: Insufficient account funds`.
 */
export function isOurWireProvider(providerID: string | undefined): boolean {
  // `opencode-zen` is the built-in alias family for the same upstream Go
  // subscription (pi-catalog's bundled provider; its models-v3 cache row is
  // what a REGISTRY-resolved `opencode-go/<id>` reference can land on). Those
  // rows must ride the wire wrapper too, or they leave attribution behind.
  return providerID === OPENCODE_GO_PROVIDER || providerID === FREE_PROVIDER || providerID === "opencode-zen"
}

// ONE /login entry for everything OpenCode.
//
// The Console device-flow login is filed by a login-only registration whose
// id AND display name are `OpenCode Go`: the host prints the raw provider id
// in `Logging in to …` / `Successfully logged in to …` and the dialog title
// is `name ?? id`, so the id doubles as the label — one name everywhere. The
// id is deliberately NOT a pi-catalog id: dispatch is builtin-first
// (`getProviderDefinition ?? getOAuthProvider`), so a built-in id would run
// pi-catalog's paste-a-key flow instead (OpenCode Go has no API keys
// anymore), and `storeCredentialsAs` routes the grant under `opencode-go` so
// both model providers pick it up.
//
// The three legacy rows (builtin "OpenCode Go"/"OpenCode Zen" paste-key
// logins + the go lane's own registration row) leave the picker through
// retireLegacyLoginRows() below.
export const LOGIN_PROVIDER_ID = "OpenCode Go"
const CREDENTIALS_ID = "opencode-go"

/** Test hooks: point the Console and gateways at a stub without touching code. */
export const CONSOLE_BASE_ENV = "OMP_GO_CONSOLE"
export const GO_BASE_ENV = "OMP_GO_BASE"
export const FREE_BASE_ENV = "OMP_GO_FREE"

/**
 * Session identity emitted on the wire. omp exposes the live session through
 * extension event contexts; update these fields from there for exact
 * per-session attribution. The defaults are harness-shaped (`ses_…`, 40-hex
 * project) so the request shape matches even before a session exists.
 */
export const sessionIdentity: SessionIdentity = {
  session: sessionID(),
  affinity: "",
  project: projectID(),
  client: DEFAULT_IDENTITY.name,
}
sessionIdentity.affinity = sessionIdentity.session

/**
 * Single-source org attribution for one request. The serving credential's own
 * org (resolved per attempt in `wireStream`) is the ONLY `x-opencode-org-id`
 * that may reach the wire: the Console-config cache is per org but its
 * `headers` carry that org's stamp, and a bearer paired with an org it is not a
 * member of is exactly what the gateway answers with
 * `402 … Insufficient account funds` / `403 Workspace access denied`. Any
 * foreign stamp (another account's cached snapshot, a pipeline default) is
 * dropped, and no org header is sent at all when none resolves.
 */
export function withServingOrg(
  headers: Record<string, string | undefined>,
  orgId: string | undefined,
): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (name.toLowerCase() === "x-opencode-org-id" && value !== orgId) continue
    merged[name] = value
  }
  if (orgId) merged["x-opencode-org-id"] = orgId
  return merged
}

// The host's model-registry handle, captured from the first event context that
// carries one (`session_start` always runs before a turn; `before_provider_request`
// backs it up). It is the roster-heal door: a deprecation failure must move the
// retired model out of the PICKER immediately, not at the host's next
// discovery refresh.
let rosterRegistry: ExtensionContext["modelRegistry"] | undefined

const HEAL_THROTTLE_MS = 30_000
const lastHealAt = new Map<string, number>()

/**
 * Roster heal after a deprecation mark. `refreshDiscoverableProviders` drives
 * this plugin's own `fetchDynamicModels` managers directly, and the "online"
 * strategy bypasses the host's 24h discovery cache (pi-catalog's
 * shouldFetchRemoteSources always fetches for "online"): the fresh roster —
 * already filtered through the dead set — replaces the provider's model rows,
 * so the retired model leaves every picker surface this process serves.
 * Fire-and-forget and best-effort: the failing turn stays loud and specific;
 * on fetch failure the host keeps its cached rows until the next successful
 * refresh, while every surface omp derives still filters the dead set.
 */
function healRoster(providerID: string): void {
  const registry = rosterRegistry
  if (!registry) return
  const now = Date.now()
  // A user hammering the dead model must not turn each turn into a catalog
  // fetch; one heal per provider per window is enough to replace the rows.
  if (now - (lastHealAt.get(providerID) ?? 0) < HEAL_THROTTLE_MS) return
  lastHealAt.set(providerID, now)
  void registry.refreshDiscoverableProviders([providerID], "online").catch(() => {
    // Best-effort by design (see the docstring).
  })
}

/** Per-request fingerprint + Console-config merge, shared by both providers. */
function wireStream(providerID: string, identity: HarnessIdentity, consoleBase: string | undefined) {
  return (model: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions): AssistantMessageEventStream => {
    // Our OWN providers' models always ride this wrapper, whatever `model.api`
    // carries: the projected `WIRE_API` on the default path, or the built-in
    // `openai-completions` / `openai-responses` a REGISTRY-resolved row keeps
    // (see isOurWireProvider). An `api`-based guard here is exactly what
    // dropped those rows out of the fingerprint. Foreign providers are never
    // swallowed — delegate them untouched to the built-in protocol. A model
    // carrying no provider id at all belongs to this closure's lane.
    if (!isOurWireProvider(model.provider ?? providerID)) return streamSimple(model, context, streamOptions)
    // The org MUST be the serving credential's own: the gateway rejects a
    // token paired with an org it is not a member of ("Workspace access
    // denied"). Prefer the pipeline's identity; fall back to the credential
    // resolution index (orgForToken) which is keyed by the exact bearer sent.
    const token = typeof streamOptions?.apiKey === "string" ? streamOptions.apiKey : undefined
    const orgId = streamOptions?.oauthIdentity?.orgId ?? orgForToken(token)
    // Remember the exact bearer -> org pair for every later derivation
    // (verdicts, re-pinning, debug): the catch path only has the token.
    if (token && orgId) indexTokenOrg(token, orgId)
    if (process.env.OMP_ORG_DEBUG)
      try {
        appendFileSync(
          process.env.OMP_ORG_DEBUG,
          `${JSON.stringify({ apiKeyType: typeof streamOptions?.apiKey, token: token ? `...${token.slice(-6)}` : "none", org: orgId ?? "none" })}\n`,
        )
      } catch {}
    // The custom-API registry is keyed by the shared WIRE_API id, so this
    // closure is whichever of the two providers registered last — resolve the
    // Console override (endpoint + pushed headers) from the MODEL's own lane.
    const override = providerOverride(orgId, model.provider ?? providerID)
    // Keep the Console config mirror warm: the harness polls /api/v2/config
    // every minute and merges pushed headers/endpoints; we do the same.
    if (token)
      void refreshConsoleConfig({
        consoleBase: consoleBase ?? CONSOLE_BASE,
        token,
        orgId,
        identity,
      })
    const existingSettings =
      model !== null && typeof model === "object" && "settings" in model && model.settings !== null && typeof model.settings === "object"
        ? model.settings
        : {}
    // pi-ai resolves the wire URL from `model.baseUrl` (openai-shared.ts);
    // settings is kept intact for compat fields.
    // Per-model protocol: Responses-API models are rejected on
    // chat/completions (ModelProtocolUnsupported) — the catalog marks them
    // with `provider.npm: "@ai-sdk/openai"`. Their compat must be fully
    // resolved (the responses path reads fields like
    // connectionBoundNativeHistory), so build them through pi-catalog's
    // resolver instead of carrying our sparse subset. A REGISTRY-resolved row
    // already carrying the built-in `openai-responses` api takes this path too.
    const viaResponses = usesResponsesAPI(model.id) || model.api === "openai-responses"
    const routed = viaResponses
      ? buildModel({
          id: model.id,
          name: model.name,
          provider: model.provider,
          api: "openai-responses",
          // Mirror the harness: inference targets the catalog URL (zen/go/v1),
          // never the Console-pushed /inference/go/... proxy path.
          baseUrl: model.baseUrl ?? override.baseURL,
          cost: model.cost,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          reasoning: model.reasoning,
          input: model.input,
          // Per-model reasoning surface (src/models.ts): effort-capable models
          // carry `reasoning: {effort, summary:"auto"}` plus the
          // encrypted-reasoning include on the Responses protocol.
          thinking: model.thinking,
          compat: {
            supportsStore: true,
            supportsUsageInStreaming: true,
            supportsReasoningEffort: model.thinking !== undefined,
            supportsReasoningSummary: true,
            includeEncryptedReasoning: true,
            reasoningContentField: "reasoning_content",
          },
        } as never)
      : (Object.assign(Object.create(Object.getPrototypeOf(model)), model, {
          api: UPSTREAM_API,
          // The protocol merges `model.headers` UNDER `StreamOptions.headers`;
          // a projection-time stamp there would outlive this request's filter
          // whenever no serving org resolved. The filtered merge below already
          // folded them in, so the routed copy carries none of its own.
          headers: undefined,
          resolveHeaders: undefined,
          ...(existingSettings ? { settings: existingSettings } : {}),
        }) as Model<typeof UPSTREAM_API>)
    const source = streamSimple(routed as Model<typeof UPSTREAM_API>, context as Context, {
      ...streamOptions,
      // Harness `responsesEffort` shape: summary "auto" rides every engaged
      // reasoning request on the Responses protocol.
      ...(viaResponses && !(streamOptions && "reasoningSummary" in streamOptions)
        ? { reasoningSummary: "auto" as const }
        : {}),
      // Harness-order transport (src/ordered-fetch.ts): the free-tier gateway
      // validates session-id encoding, and the harness's exact wire order keeps
      // the traffic byte-faithful on every lane.
      fetch: harnessFetch,
      // Fingerprint + Console-pushed headers win over anything static; the
      // org header attributes the request to the serving workspace exactly
      // as the harness's Console-driven provider does (capture/golden-
      // requests.ndjson: every inference carries the pushed
      // x-opencode-org-id). Auth stays with the pipeline (see authHeader).
      // The org is single-sourced here: `model.headers` (the RESOLVED
      // projection layers — these ride the wire under us and carried the
      // previous account's stamp) and every other `x-opencode-org-id` in the
      // merge (pipeline default, another account's cached Console snapshot)
      // are dropped unless they belong to THIS attempt's serving credential.
      headers: withServingOrg(
        {
          ...model.headers,
          ...streamOptions?.headers,
          ...sessionHeaders(sessionIdentity, identity),
          ...override.headers,
        },
        orgId,
      ),
    } as SimpleStreamOptions)
    // Outermost wrapper: a deprecation failure marks the model dead at runtime
    // (src/dead-models.ts) and rewrites the user-visible error to say so —
    // outside mapRegionGateErrors so it sees exactly what the caller gets,
    // while the account-verdict machinery stays untouched inside.
    const lane = model.provider ?? providerID
    return mapDeprecationErrors(mapRegionGateErrors(source, token, orgId), {
      modelId: model.id,
      // Read lazily AFTER the mark lands, so the roster in the note is already
      // clean of the retired model.
      alternatives: () => (lane === FREE_PROVIDER ? freeModels() : catalogModels()).map((entry) => entry.id),
      freeUsageHint: lane === FREE_PROVIDER,
      onRetired: () => healRoster(lane),
    })
  }
}

/**
 * Credential-aware model projection, shared by both registrations: resolved
 * models must carry our custom API id (which routes requests through the
 * fingerprint wrapper) plus the Console-driven endpoint and per-org header.
 * Without it the built-in catalog models keep `openai-completions` and every
 * request bypasses the wrapper entirely.
 */
function projectModels(models: Model<Api>[], credentials: { orgId?: string }) {
  return models.map((model) => {
    const providerID = model.provider
    if (!isOurWireProvider(providerID)) return model
    const override = providerOverride(credentials.orgId, providerID)
    return Object.assign(Object.create(Object.getPrototypeOf(model)), model, {
      api: WIRE_API,

      headers: {
        ...model.headers,
        // The org is NOT stamped here: projection-time credentials outlive the
        // request, and a static org paired with the pool's OTHER token is what
        // the gateway rejects with "Workspace access denied" — the 17 straight
        // 403s of 2026-10-16 were this stamp riding model.headers past the
        // request-time merge. Org-neutral pushed values (endpoint, fingerprint)
        // still ride; wireStream injects the serving credential's own org per
        // attempt.
        ...orgScopedHeaders(override.headers, false),
      },
      resolveHeaders: async () => sessionHeaders(sessionIdentity, DEFAULT_IDENTITY),
    })
  })
}

/**
 * Retire the three legacy OpenCode rows from the /login picker, leaving only
 * LOGIN_PROVIDER_ID.
 *
 * The mechanism, and why it is the simplest one that meets the criteria:
 *
 * - Same-id shadowing does NOT win. pi-ai's `getOAuthProviders()` is
 *   `[...builtins, ...customs]` with no dedupe (both an id-`opencode-go`
 *   builtin and the go lane's registration list today), and login dispatch is
 *   builtin-first (`getProviderDefinition ?? getOAuthProvider`), which is why
 *   selecting that row ran pi-catalog's paste-a-key flow instead of the
 *   device flow.
 * - The picker's only hide filter is `disabled.has(id) || disabled.has
 *   (storeCredentialsAs)` over the user's `disabledProviders`. Putting
 *   `opencode-go` there hides the builtin row but also kills the lane's model
 *   availability and this entry (its storeCredentialsAs is `opencode-go`), so
 *   the settings route cannot express "exactly one row".
 * - Builtins are snapshotted at pi-ai module init (`provider.login &&
 *   showInLoginList !== false`), so nothing unregisters them.
 *
 * What remains is field mutation on the host's own row objects: this
 * extension shares the host module instance (the loader rewrites explicit
 * package exports such as `@oh-my-pi/pi-ai/oauth` to the bundled copy — the
 * same objects /login reads). Renaming `id` + `name` off the `opencode`
 * search text hides a row from the picker's `getProviderSearchText`
 * (`${name} ${id} …`) without touching any functional key:
 *
 * - builtin rows: display fields only; their paste-key flows retire with them.
 * - the go lane's registration: the custom map is keyed by the id it was
 *   REGISTERED under, not the mutable `id` field, so `getOAuthProvider(
 *   "opencode-go")` still serves refresh/getApiKey and
 *   `getOAuthCredentialProvider("opencode-go")` falls back to the raw id for
 *   credential lookups — routing and `/logout opencode-go` stay correct.
 *   (Its listed row retires: selection would miss the mutated id; the working
 *   flow is LOGIN_PROVIDER_ID's.)
 *
 * The host QUEUES `pi.registerProvider` during extension loading
 * (`pendingProviderRegistrations`) and flushes it at session initialization,
 * where the spread re-stores the go lane's entry — resetting its mutable `id`
 * — so the retirement also runs from the session_start/session_switch
 * handlers (after each flush). Every pass finds rows by their ORIGINAL ids,
 * so re-runs are no-op on rows already retired.
 */
function retireLegacyLoginRows(): void {
  const retired = new Map<string, { id: string; name: string }>([
    // pi-catalog's builtin paste-a-key rows: OpenCode ships no API keys, so
    // both flows are dead ends (the user-visible problem this replaces).
    ["opencode-go", { id: "go-api-key-login", name: "Go subscription (API key)" }],
    ["opencode-zen", { id: "zen-api-key-login", name: "Zen (API key)" }],
  ])
  for (const row of getOAuthProviders()) {
    const rename = retired.get(row.id)
    if (!rename) continue
    // Builtins are the shared objects getOAuthProviders() spreads; a custom
    // wrap is rebuilt per call, so mutating it is a harmless no-op (the
    // stored entry is retired through its key below).
    ;(row as { id: string }).id = rename.id
    ;(row as { name: string }).name = rename.name
  }
  const goLaneRegistration = getOAuthProvider(OPENCODE_GO_PROVIDER) as
    | { id: string; name: string }
    | undefined
  if (goLaneRegistration) {
    // Readonly on the interface only; the mutable field is what the row wraps
    // read on every getOAuthProviders() call (see the doc comment).
    goLaneRegistration.name = "Go subscription (retired login)"
    goLaneRegistration.id = "go-subscription-login"
  }
}

export function registerOpencodeGo(
  pi: ExtensionAPI,
  options: { identity?: HarnessIdentity } = {},
): OpencodeOAuthProvider {
  const identity = options.identity ?? DEFAULT_IDENTITY
  const consoleBase = process.env[CONSOLE_BASE_ENV]
  const goBase = process.env[GO_BASE_ENV] ?? ZEN_GO_BASE
  const freeBase = process.env[FREE_BASE_ENV] ?? ZEN_BASE
  const oauth = new OpencodeOAuthProvider({ identity, server: consoleBase })
  // One bound device flow for every registration below (the test surface
  // asserts every OpenCode oauth is this handler, never an api-key prompt).
  const deviceLogin = oauth.login.bind(oauth)
  const deviceRefresh = oauth.refreshToken.bind(oauth)
  const deviceGetApiKey = oauth.getApiKey.bind(oauth)
  const streamSimpleFor = (providerID: string) => wireStream(providerID, identity, consoleBase)

  const goConfig: ProviderConfig = {
    baseUrl: goBase,
    api: WIRE_API,

    authHeader: true,
    headers: { "user-agent": `opencode/${identity.channel}/${identity.version}/${identity.name}` },
    streamSimple: streamSimpleFor(OPENCODE_GO_PROVIDER),
    // This block is NOT a login entry — retireLegacyLoginRows() renames the
    // row it lists out of the /login search. What the registration itself must
    // keep providing, keyed by the `opencode-go` provider name the custom map
    // stores under (the map key, unlike the mutable `id` field):
    //   - validation: models need `apiKey` or `oauth`, and an apiKey here would
    //     override stored login credentials on the chat path;
    //   - refresh/getApiKey for the grant stored under `opencode-go`
    //     (pi-ai's refresh pipeline resolves custom entries by provider id);
    //   - `modifyModels` projects the credential-aware catalog (api + pushed
    //     headers) for every OpenCode wire lane while creds live here.
    oauth: {
      name: "Go subscription (retired login)",
      login: deviceLogin,
      refreshToken: deviceRefresh,
      getApiKey: deviceGetApiKey,
      modifyModels: projectModels,
    },
    usage: opencodeGoUsageProvider({ session: sessionIdentity, identity }),
    models: catalogModels(),
    fetchDynamicModels: () => fetchCatalogModels({ session: sessionIdentity, identity }),
  }

  // OpenCode's free tier: same fingerprint, free models only, keyless. NO
  // `oauth` block: its login row was the confusing "OpenCode Console (shared
  // account)" entry, and the lane never resolves oauth credentials itself —
  // grants are stored under CREDENTIALS_ID (the go lane reads them from
  // there) while this lane rides `apiKey: "public"`, the harness's own
  // free-tier fallback (OpencodePlugin sets it when no credential is
  // present). Without oauth the key installs as the provider's config key,
  // which is the same value either way: nothing is ever stored under
  // `opencode-free` for it to outrank.
  const freeConfig: ProviderConfig = {
    baseUrl: freeBase,
    api: WIRE_API,
    authHeader: true,
    headers: { "user-agent": `opencode/${identity.channel}/${identity.version}/${identity.name}` },
    streamSimple: streamSimpleFor(FREE_PROVIDER),
    apiKey: "public",
    models: freeModels(),
    fetchDynamicModels: () => fetchFreeModels({ session: sessionIdentity, identity }),
  }

  // The request path honors ~/.omp/agent/models.yml overrides on every model
  // resolution lane; keep our fingerprint block current there too. The org
  // header comes from the cached Console config when available (registration
  // runs in every process and must not regress the block to defaults).
  writeModelsOverride({ identity })
  pi.registerProvider(OPENCODE_GO_PROVIDER, goConfig)
  pi.registerProvider(FREE_PROVIDER, freeConfig)
  // The single /login entry — after the lane registrations so every legacy row
  // it supersedes exists before retirement. Login-only: no models, no baseUrl
  // (the host validation accepts an oauth-only registration), so nothing ever
  // sends a request as this id; `apiKey: "public"` is the picker badge
  // fallback mirroring the free lane (credentials live under CREDENTIALS_ID,
  // not this id, so keys.source/validateAuth resolve the config source).
  pi.registerProvider(LOGIN_PROVIDER_ID, {
    apiKey: "public",
    oauth: {
      name: LOGIN_PROVIDER_ID,
      storeCredentialsAs: CREDENTIALS_ID,
      login: deviceLogin,
      refreshToken: deviceRefresh,
      getApiKey: deviceGetApiKey,
    } as ProviderConfig["oauth"] & { storeCredentialsAs: string },
  })
  retireLegacyLoginRows()
  // The seven harness-only wrappers (shell, subagent, execute, websearch,
  // webfetch, question, skill) share no name with an omp built-in, so
  // registering them here is inert until the free lane activates them.
  registerHarnessTools(pi)

  // The five COLLIDING wrappers (read, edit, glob, grep, write) are a different
  // story: registering a same-named tool REPLACES the built-in in the host
  // registry whether or not the wrapper ends up active. Registering them here
  // therefore deletes `read`/`write`/`edit`/`glob`/`grep` from EVERY lane, the
  // Go lane included. That is not cosmetic — omp allocates its `xd://` device
  // layer only when the session holds a `write` tool
  // (`xdevEnabled = xdevRequested && tools.some(t => t.name === "write")`), so
  // losing it silently ships every MCP tool schema top-level on every request.
  // Register them lazily, on the free lane only, immediately before activation.
  let collidingRegistered = false
  const ensureCollidingHarnessTools = (): void => {
    if (collidingRegistered) return
    registerCollidingHarnessTools(pi)
    collidingRegistered = true
  }

  const ensureHarnessTools = async (ctx: { model?: Model<Api> }): Promise<boolean> => {
    const provider = ctx.model?.provider
    if (provider !== FREE_PROVIDER) return false
    // The colliding wrappers re-register omp's read/edit/glob/grep/write, so
    // registration is confined to this free-lane path — every other lane keeps
    // the built-ins, and with them the xd:// device layer.
    // includeColliding: the five colliding wrappers replace omp's built-ins,
    // so the active set must be rebuilt (not merely extended) or their calls
    // resolve to stale entries ("Tool read/write not found").
    // The boolean is the rewrite licence: true only when the harness surface
    // RESOLVES (freshly activated or already active).
    try {
      ensureCollidingHarnessTools()
      return await activateHarnessTools(pi, provider, true)
    } catch {
      return false
    }
  }
  // Returned (awaited by the harness), not fire-and-forget: the tool set must
  // be fully registered AND active before the agent's first tool call, or the
  // host answers the model's `write`/`shell` with "Tool ... not found".
  pi.on("session_start", async (_event, ctx) => {
    // The queued provider registrations flushed at session init (re-storing
    // the go lane's entry with its original id) — retire the rows again.
    retireLegacyLoginRows()
    rosterRegistry ??= ctx.modelRegistry
    await ensureHarnessTools(ctx)
  })
  // Session switches can flush registrations again in the same process; the
  // pass is find-by-original-id, so an already-retired surface no-ops.
  pi.on("session_switch", () => {
    retireLegacyLoginRows()
  })
  pi.on("before_agent_start", async (_event, ctx) => {
    await ensureHarnessTools(ctx)
  })
  // The free lane's built payload carries the harness's own `tools` array; the
  // Go lane keeps whatever omp built. Activation is AWAITED here — the earlier
  // fire-and-forget activation raced the first turn, so the model saw `shell`
  // in its tool list while the host registry still lacked it ("Tool shell not
  // found"). Ordering is now guaranteed: active tools before the request.
  pi.on("before_provider_request", async (event, ctx) => {
    rosterRegistry ??= ctx.modelRegistry
    if (ctx.model?.provider !== FREE_PROVIDER) return undefined
    const activated = await ensureHarnessTools(ctx)
    // Never advertise the harness names without a confirmed harness surface:
    // when the active set never established, the rewrite would offer tools the
    // host cannot resolve ("Tool write not found" on turn 1) — the host's own
    // payload resolves its own names, so it ships unchanged. When activated,
    // the ACTIVE tools outside the offered 12 keep their schemas visible in the
    // request context (src/tool-mirror.ts): dropped from `tools[]` by the
    // rewrite but still executable, a model that never sees them improvises
    // their argument shapes and fails host validation.
    return rewriteFreeLanePayload(event.payload, {
      activated,
      extraTools: activated ? activeExtraTools(pi) : [],
    })
  })

  return oauth
}
