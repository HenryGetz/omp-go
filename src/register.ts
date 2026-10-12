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

import type {
  ExtensionAPI,
  ProviderConfig,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"
import { streamSimple } from "@oh-my-pi/pi-ai/stream"
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
  const oauth = new OpencodeOAuthProvider({ identity })
  const config: ProviderConfig = {
    baseUrl: ZEN_GO_BASE,
    api: "openai-completions",
    authHeader: true,
    headers: { "user-agent": `opencode/${identity.channel}/${identity.version}/${identity.name}` },
    streamSimple: (model, context, streamOptions) =>
      streamSimple(model, context, {
        ...streamOptions,
        // Per-request fingerprint wins over anything static: this is the point
        // of the wrapper. Auth stays with the pipeline (see authHeader).
        headers: { ...streamOptions?.headers, ...sessionHeaders(sessionIdentity, identity) },
      }),
    oauth: {
      name: oauth.name,
      login: oauth.login.bind(oauth),
      refreshToken: oauth.refreshToken.bind(oauth),
      getApiKey: oauth.getApiKey.bind(oauth),
    },
    usage: opencodeGoUsageProvider({ session: sessionIdentity, identity }),
    models: catalogModels(),
    fetchDynamicModels: () => fetchCatalogModels({ session: sessionIdentity, identity }),
  }
  pi.registerProvider(OPENCODE_GO_PROVIDER, config)
  return oauth
}
