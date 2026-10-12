// omp extension entry: registers the opencode Go subscription end to end —
// `pi.registerProvider("opencode-go", …)` (models + inference fingerprint +
// usage/limits + /login OAuth) and `registerOAuthProvider` so the auth-broker
// (`omp auth-broker login opencode`) runs the same device flow.

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth"
import { OpencodeOAuthProvider } from "./opencode-provider"
import { registerOpencodeGo, sessionIdentity } from "./register"

export * from "./wire"
export * from "./opencode-provider"
export * from "./models"
export * from "./usage"
export * from "./register"

export const SOURCE_ID = "omp-opencode-auth"

export const provider = new OpencodeOAuthProvider()

export function install(): OpencodeOAuthProvider {
  registerOAuthProvider(provider)
  return provider
}

export function uninstall(): void {
  unregisterOAuthProviders(SOURCE_ID)
}

export default function opencodeAuthExtension(pi: ExtensionAPI): void {
  install()
  registerOpencodeGo(pi)
  // Best-effort live session attribution; omp exposes sessionManager through
  // extension event contexts when one is active.
  pi.on("message.updated", ((_event: unknown, ctx: unknown) => {
    const sessionId = (ctx as { sessionManager?: { getSessionId?: () => unknown } } | undefined)?.sessionManager
      ?.getSessionId?.()
    if (typeof sessionId === "string" && sessionId.length > 0) {
      sessionIdentity.session = sessionId
      sessionIdentity.affinity = sessionId
    }
  }) as never)
}
