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
import { providerOverride, refreshConsoleConfig } from "./console-config"
import { mapRegionGateErrors } from "./region"
import { writeModelsOverride } from "./models-config"
import { OpencodeOAuthProvider } from "./opencode-provider"
import { catalogModels, fetchCatalogModels, fetchFreeModels, freeModels, usesResponsesAPI } from "./models"
import { OPENCODE_GO_PROVIDER, opencodeGoUsageProvider } from "./usage"
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

/** Per-request fingerprint + Console-config merge, shared by both providers. */
function wireStream(providerID: string, identity: HarnessIdentity, consoleBase: string | undefined) {
  return (model: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions): AssistantMessageEventStream => {
    // Per-request credential identity (org/region) rides on oauthIdentity.
    const orgId = streamOptions?.oauthIdentity?.orgId
    const override = providerOverride(orgId, providerID)
    const token = typeof streamOptions?.apiKey === "string" ? streamOptions.apiKey : undefined
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
    // resolver instead of carrying our sparse subset.
    const routed = usesResponsesAPI(model.id)
      ? buildModel({
          id: model.id,
          name: model.name,
          provider: model.provider,
          api: "openai-responses",
          baseUrl: override.baseURL ?? model.baseUrl,
          cost: model.cost,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          reasoning: model.reasoning,
          input: model.input,
          compat: {
            supportsStore: true,
            supportsUsageInStreaming: true,
            supportsReasoningEffort: false,
            reasoningContentField: "reasoning_content",
          },
        } as never)
      : (Object.assign(Object.create(Object.getPrototypeOf(model)), model, {
          api: UPSTREAM_API,
          ...(override.baseURL ? { baseUrl: override.baseURL, settings: existingSettings } : {}),
        }) as Model<typeof UPSTREAM_API>)
    return mapRegionGateErrors(
      streamSimple(routed as Model<typeof UPSTREAM_API>, context as Context, {
        ...streamOptions,
        // Harness-order transport (src/ordered-fetch.ts): the free-tier gateway
        // validates session-id encoding, and the harness's exact wire order keeps
        // the traffic byte-faithful on every lane.
        fetch: harnessFetch,
        // Fingerprint + Console-pushed headers win over anything static; the
        // org header attributes the request to the serving workspace exactly
        // as the harness's Console-driven provider does. Auth stays with the
        // pipeline (see authHeader).
        headers: {
          ...streamOptions?.headers,
          ...sessionHeaders(sessionIdentity, identity),
          ...override.headers,
          ...(orgId ? { "x-opencode-org-id": orgId } : {}),
        },
      } as SimpleStreamOptions),
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
    if (providerID !== OPENCODE_GO_PROVIDER && providerID !== FREE_PROVIDER) return model
    const override = providerOverride(credentials.orgId, providerID)
    return Object.assign(Object.create(Object.getPrototypeOf(model)), model, {
      api: WIRE_API,
      ...(override.baseURL ? { baseUrl: override.baseURL } : {}),
      headers: {
        ...model.headers,
        ...override.headers,
        ...(credentials.orgId ? { "x-opencode-org-id": credentials.orgId } : {}),
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

  return oauth
}
