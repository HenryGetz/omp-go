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
  ProviderConfig,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"
// Import from the package root, never `@oh-my-pi/pi-ai/stream`. omp's extension
// loader only rewrites host-bundled specifiers that appear as explicit package
// exports; `./stream` matches pi-ai's `./*` catch-all, so a compiled host cannot
// resolve it and the extension fails to load ("Cannot find package
// '@oh-my-pi/pi-ai'"). The root re-exports `streamSimple` (`export * from "./stream"`).
import { buildModel } from "@oh-my-pi/pi-catalog/build"
import { streamSimple } from "@oh-my-pi/pi-ai"
import { harnessFetch } from "./ordered-fetch"
import type { Api, Model, SimpleStreamOptions, Context, AssistantMessageEventStream } from "@oh-my-pi/pi-ai"
import { orgScopedHeaders, providerOverride, refreshConsoleConfig } from "./console-config"
import { mapRegionGateErrors } from "./region"
import { writeModelsOverride } from "./models-config"
import { indexTokenOrg, OpencodeOAuthProvider, orgForToken } from "./opencode-provider"
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

// The Console device-flow login is filed by the `opencode` registration's
// `config.oauth` (id = provider name; pi-catalog has no built-in `opencode`
// login to shadow it), with `storeCredentialsAs` routing the grant under
// `opencode-go` so both model providers pick it up.
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
    return mapRegionGateErrors(
      streamSimple(routed as Model<typeof UPSTREAM_API>, context as Context, {
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
      } as SimpleStreamOptions),
      token,
      orgId,
    )
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

export function registerOpencodeGo(
  pi: ExtensionAPI,
  options: { identity?: HarnessIdentity } = {},
): OpencodeOAuthProvider {
  const identity = options.identity ?? DEFAULT_IDENTITY
  const consoleBase = process.env[CONSOLE_BASE_ENV]
  const goBase = process.env[GO_BASE_ENV] ?? ZEN_GO_BASE
  const freeBase = process.env[FREE_BASE_ENV] ?? ZEN_BASE
  const oauth = new OpencodeOAuthProvider({ identity, server: consoleBase })
  const streamSimpleFor = (providerID: string) => wireStream(providerID, identity, consoleBase)

  const goConfig: ProviderConfig = {
    baseUrl: goBase,
    api: WIRE_API,

    authHeader: true,
    headers: { "user-agent": `opencode/${identity.channel}/${identity.version}/${identity.name}` },
    streamSimple: streamSimpleFor(OPENCODE_GO_PROVIDER),
    // `oauth` marks the provider OAuth-native: a credential saved by /login
    // wins and is the only key source — an `apiKey` fallback here would let a
    // stale OPENCODE_API_KEY in the shell hijack the chat path over the login
    // (the host validation accepts oauth alone).
    oauth: {
      name: "OpenCode Console (Go subscription)",
      login: oauth.login.bind(oauth),
      refreshToken: oauth.refreshToken.bind(oauth),
      getApiKey: oauth.getApiKey.bind(oauth),
      modifyModels: projectModels,
    },
    usage: opencodeGoUsageProvider({ session: sessionIdentity, identity }),
    models: catalogModels(),
    fetchDynamicModels: () => fetchCatalogModels({ session: sessionIdentity, identity }),
  }

  // OpenCode's free tier: same login, same fingerprint, free models only.
  // `apiKey: "public"` is the harness's own free-tier fallback (OpencodePlugin
  // sets it when no credential is present); a /login credential takes
  // precedence and is what the harness sends when connected.
  const freeConfig: ProviderConfig = {
    baseUrl: freeBase,
    api: WIRE_API,
    authHeader: true,
    headers: { "user-agent": `opencode/${identity.channel}/${identity.version}/${identity.name}` },
    streamSimple: streamSimpleFor(FREE_PROVIDER),
    apiKey: "public",
    // `storeCredentialsAs` is kept by the host's registration spread; the
    // published ProviderConfig.oauth type predates the field.
    oauth: {
      name: "OpenCode Console (shared account)",
      storeCredentialsAs: CREDENTIALS_ID,
      login: oauth.login.bind(oauth),
      refreshToken: oauth.refreshToken.bind(oauth),
      getApiKey: oauth.getApiKey.bind(oauth),
      modifyModels: projectModels,
    } as ProviderConfig["oauth"] & { storeCredentialsAs: string },
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
  // Wrappers register unconditionally ONCE (defaultInactive, and the harness's
  // lowercase names do not collide with omp's capitalized built-ins); the
  // free-lane ACTIVATION below is what turns them on. The tool-mirror rewrite
  // (src/tool-mirror.ts) swaps the request's `tools` array for the harness's
  // fingerprinted 12 — the wrappers carry those exact schemas and the real
  // behaviour — and the Go lane's traffic stays untouched.
  registerCollidingHarnessTools(pi)
  registerHarnessTools(pi)

  const ensureHarnessTools = async (ctx: { model?: Model<Api> }): Promise<boolean> => {
    const provider = ctx.model?.provider
    if (provider !== FREE_PROVIDER) return false
    // The colliding wrappers re-register omp's read/edit/glob/grep/write, so
    // this runs only on a free-lane session — the Go lane keeps the built-ins.
    // Registration happens at plugin setup now; only activation is gated.
    // includeColliding: the five colliding wrappers replace omp's built-ins,
    // so the active set must be rebuilt (not merely extended) or their calls
    // resolve to stale entries ("Tool read/write not found").
    // The boolean is the rewrite licence: true only when the harness surface
    // RESOLVES (freshly activated or already active).
    try {
      return await activateHarnessTools(pi, provider, true)
    } catch {
      return false
    }
  }
  // Returned (awaited by the harness), not fire-and-forget: the tool set must
  // be fully registered AND active before the agent's first tool call, or the
  // host answers the model's `write`/`shell` with "Tool ... not found".
  pi.on("session_start", async (_event, ctx) => {
    await ensureHarnessTools(ctx)
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
