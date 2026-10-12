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
    streamSimple: (model, context, streamOptions): AssistantMessageEventStream =>
      streamSimple(
        Object.assign(Object.create(Object.getPrototypeOf(model)), model, { api: UPSTREAM_API }) as Model<
          typeof UPSTREAM_API
        >,
        context as Context,
        {
          ...streamOptions,
          // Per-request fingerprint wins over anything static: this is the point
          // of the wrapper. Auth stays with the pipeline (see authHeader).
          headers: { ...streamOptions?.headers, ...sessionHeaders(sessionIdentity, identity) },
        } as SimpleStreamOptions,
      ),
    // `oauth` marks the provider OAuth-native: a credential saved by /login
    // wins and is the only key source — an `apiKey` fallback here would let a
    // stale OPENCODE_API_KEY in the shell hijack the chat path over the login
    // (the host validation accepts oauth alone).
    oauth: {
      name: "OpenCode Go (service-account key)",
      login: oauth.login.bind(oauth),
      refreshToken: oauth.refreshToken.bind(oauth),
      getApiKey: oauth.getApiKey.bind(oauth),
    },
    usage: opencodeGoUsageProvider({ session: sessionIdentity, identity }),
    models: catalogModels(),
    fetchDynamicModels: () => fetchCatalogModels({ session: sessionIdentity, identity }),
  }
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
