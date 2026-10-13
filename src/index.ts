// omp extension entry: registers the opencode Go subscription end to end —
// `pi.registerProvider("opencode-go", …)` wires /login OAuth, the model
// catalog, the inference fingerprint, usage/limits, and (through the host)
// the `omp auth-broker` provider entry.

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"
import { registerOpencodeGo, sessionIdentity } from "./register"

export * from "./wire"
export * from "./opencode-provider"
export * from "./models"
export * from "./usage"
export * from "./register"

export default function opencodeAuthExtension(pi: ExtensionAPI): void {
  registerOpencodeGo(pi)
  // Best-effort live session attribution; omp exposes sessionManager through
  // extension event contexts when one is active.
  pi.on("message.updated" as never, ((_event: unknown, ctx: unknown) => {
    const sessionId = (ctx as { sessionManager?: { getSessionId?: () => unknown } } | undefined)?.sessionManager
      ?.getSessionId?.()
    if (typeof sessionId === "string" && sessionId.length > 0) {
      sessionIdentity.session = sessionId
      sessionIdentity.affinity = sessionId
    }
  }) as never)
}
