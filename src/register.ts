// omp-native registration for the opencode Go subscription: one
// `pi.registerProvider("opencode-go", …)` call wiring OAuth login (the Console
// device flow), the 36-model catalog, wire-identical inference headers, and
// usage/limits reporting.
//
// Everything routed through this provider leaves omp shaped like the opencode
// harness: `streamSimple` injects the harness fingerprint (User-Agent,
// x-opencode-*, b3/traceparent) per request via pi-ai's `StreamOptions.headers`
// merge ("merged on top of model-defined headers"); `authorization: Bearer` is
// left to omp's auth pipeline (`authHeader: true`) so refresh/rotation and
// auth-retry keep working.
//
// `api` must NOT be a built-in name when `streamSimple` is set: the host calls
// `registerCustomApi(config.api, …)` and pi-ai reserves built-in API names
// (that is a startup crash, not a warning). So models run under a custom API id
// and the wrapper rewrites the model to the built-in `openai-completions` before
// delegating — the request is then built by the stock OpenAI-compatible
// protocol with our headers on top.

import type {
  ExtensionAPI,
  ProviderConfig,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"
import type { Model, SimpleStreamOptions, Context, AssistantMessageEventStream } from "@oh-my-pi/pi-ai"
// Import from the package root, never `@oh-my-pi/pi-ai/stream`. omp's extension
// loader only rewrites host-bundled specifiers that appear as explicit package
// exports; `./stream` matches pi-ai's `./*` catch-all, so a compiled host cannot
// resolve it and the extension fails to load ("Cannot find package
// '@oh-my-pi/pi-ai'"). The root re-exports `streamSimple` (`export * from "./stream"`).
import { streamSimple } from "@oh-my-pi/pi-ai"
import { providerOverride, refreshConsoleConfig } from "./console-config"
import { mapRegionGateErrors } from "./region"
import { writeModelsOverride } from "./models-config"
import { OpencodeOAuthProvider } from "./opencode-provider"
import { catalogModels, fetchCatalogModels } from "./models"
import { OPENCODE_GO_PROVIDER, opencodeGoUsageProvider } from "./usage"
import {
  DEFAULT_IDENTITY,
  projectID,
  sessionHeaders,
  sessionID,
  ZEN_GO_BASE,
  type HarnessIdentity,
  type SessionIdentity,
} from "./wire"

/** Custom API id registered for this provider; not a built-in name (those are reserved). */
export const WIRE_API = "opencode-go-wire"
const UPSTREAM_API = "openai-completions"

/**
 * Login id for the Console device flow. Must NOT collide with a built-in
 * provider id: `authStorage.oauth.login` resolves "built-in registry first,
 * then runtime-registered extension providers", and pi-catalog's built-in
 * `opencode-go` login is the paste-a-key flow. `storeCredentialsAs` files the
 * grant under `opencode-go` so the model provider picks it up.
 */
export const LOGIN_ID = "opencode"
const CREDENTIALS_ID = "opencode-go"

/** Test hooks: point the Console and gateway at a stub without touching code. */
export const CONSOLE_BASE_ENV = "OMP_GO_CONSOLE"
export const ZEN_BASE_ENV = "OMP_GO_ZEN"

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

export function registerOpencodeGo(
  pi: ExtensionAPI,
  options: { identity?: HarnessIdentity } = {},
): OpencodeOAuthProvider {
  const identity = options.identity ?? DEFAULT_IDENTITY
  const consoleBase = process.env[CONSOLE_BASE_ENV]
  const zenBase = process.env[ZEN_BASE_ENV] ?? ZEN_GO_BASE
  const oauth = new OpencodeOAuthProvider({ identity, server: consoleBase })
  const config: ProviderConfig = {
    baseUrl: zenBase,
    api: WIRE_API,
    authHeader: true,
    headers: { "user-agent": `opencode/${identity.channel}/${identity.version}/${identity.name}` },
    streamSimple: (model, context, streamOptions): AssistantMessageEventStream => {
      // Per-request credential identity (org/region) rides on oauthIdentity.
      const orgId = streamOptions?.oauthIdentity?.orgId
      const override = providerOverride(orgId, OPENCODE_GO_PROVIDER)
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
      const routed = Object.assign(Object.create(Object.getPrototypeOf(model)), model, {
        api: UPSTREAM_API,
        ...(override.baseURL ? { baseUrl: override.baseURL, settings: existingSettings } : {}),
      }) as Model<typeof UPSTREAM_API>
      return mapRegionGateErrors(
        streamSimple(routed, context as Context, {
          ...streamOptions,
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
    },
    // `oauth` marks the provider OAuth-native: a credential saved by /login
    // wins and is the only key source — an `apiKey` fallback here would let a
    // stale OPENCODE_API_KEY in the shell hijack the chat path over the login
    // (the host validation accepts oauth alone).
    oauth: {
      name: "OpenCode Go (service-account key)",
      login: oauth.login.bind(oauth),
      refreshToken: oauth.refreshToken.bind(oauth),
      getApiKey: oauth.getApiKey.bind(oauth),
      // Re-applied on every catalog reload: resolved models must carry our
      // custom API id (which routes requests through the fingerprint wrapper)
      // plus the Console-driven endpoint and per-org header. Without this the
      // built-in catalog models keep `openai-completions` and every request
      // bypasses the wrapper entirely.
      modifyModels: (models, credentials) => {
        const override = providerOverride(credentials.orgId, OPENCODE_GO_PROVIDER)
        return models.map((model) => {
          if (model.provider !== OPENCODE_GO_PROVIDER) return model
          return Object.assign(Object.create(Object.getPrototypeOf(model)), model, {
            api: WIRE_API,
            ...(override.baseURL ? { baseUrl: override.baseURL } : {}),
            headers: {
              ...model.headers,
              ...override.headers,
              ...(credentials.orgId ? { "x-opencode-org-id": credentials.orgId } : {}),
            },
            // Per-request dynamic fingerprint (b3/traceparent, session set,
            // User-Agent): resolveHeaders runs immediately before every request
            // and its result is merged into the request headers.
            resolveHeaders: async () => sessionHeaders(sessionIdentity, identity),
          })
        })
      },
    },
    usage: opencodeGoUsageProvider({ session: sessionIdentity, identity }),
    models: catalogModels(),
    fetchDynamicModels: () => fetchCatalogModels({ session: sessionIdentity, identity }),
  }
  // The request path honors ~/.omp/agent/models.yml overrides on every model
  // resolution lane; keep our fingerprint block current there too. The org
  // header comes from the cached Console config when available (registration
  // runs in every process and must not regress the block to defaults).
  const configOverride = providerOverride(undefined, OPENCODE_GO_PROVIDER)
  writeModelsOverride({
    baseURL: configOverride.baseURL,
    orgId: configOverride.headers["x-opencode-org-id"],
    identity,
  })
  pi.registerProvider(OPENCODE_GO_PROVIDER, config)
  // The device-flow login is registered through a second, login-only provider
  // under LOGIN_ID. Two constraints force this shape:
  // 1. `authStorage.oauth.login` resolves "built-in registry first, then
  //    runtime-registered", and pi-catalog's built-in `opencode-go` definition
  //    owns a paste-a-key login — a registration under that id is shadowed.
  // 2. The host files `config.oauth` in its own pi-ai registry (the extension's
  //    direct `registerOAuthProvider` import can land on a different module
  //    instance than the bundled host, which `/login` reads).
  // The spread keeps `storeCredentialsAs`, so the grant files under
  // `opencode-go` and the model provider picks it up.
  pi.registerProvider(LOGIN_ID, {
    // The host's registration spreads this object and keeps `storeCredentialsAs`;
    // the published type predates the field.
    oauth: {
      name: oauth.name,
      storeCredentialsAs: CREDENTIALS_ID,
      login: oauth.login.bind(oauth),
      refreshToken: oauth.refreshToken.bind(oauth),
      getApiKey: oauth.getApiKey.bind(oauth),
    } as ProviderConfig["oauth"] & { storeCredentialsAs: string },
  })
  return oauth
}
