// omp extension entry: registers the opencode Go subscription end to end —
// `pi.registerProvider("opencode-go", …)` wires /login OAuth, the model
// catalog, the inference fingerprint, usage/limits, and (through the host)
// the `omp auth-broker` provider entry.

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"
import { registerOpencodeGo, sessionIdentity } from "./register"
import { addHost, listHosts, removeHost, setHostEnabled, tunnelStatus } from "./egress"

export * from "./wire"
export * from "./opencode-provider"
export * from "./models"
export * from "./usage"
export * from "./register"

export default function opencodeAuthExtension(pi: ExtensionAPI): void {
  registerOpencodeGo(pi)
  pi.registerCommand("egress", {
    description: "Manage free-tier egress hosts (ssh tunnels) — /egress [list|add <ssh-target>|remove <ssh-target>|on|off <ssh-target>]",
    getArgumentCompletions: (prefix) =>
      ["list", "add", "remove", "on", "off"].filter((word) => word.startsWith(prefix)).map((word) => ({ value: word, label: word })),
    handler: async (args, ctx) => {
      const [verb = "list", ...rest] = args.trim().split(/\s+/)
      const target = rest.join(" ")
      const describe = () =>
        tunnelStatus()
          .map((host) => `${host.enabled ? (host.tunnel ? "UP  " : "DOWN") : "off "} ${host.target}${host.port ? ` (127.0.0.1:${host.port})` : ""}`)
          .join("\n") || "no egress hosts configured"
      switch (verb) {
        case "list":
        case "":
          ctx.ui.notify(`egress hosts:\n${describe()}`, "info")
          break
        case "add":
          if (!target) return ctx.ui.notify("usage: /egress add <ssh-target> (e.g. student@100.125.193.75)", "warning")
          addHost(target)
          ctx.ui.notify(`added ${target}; tunnel opens on the next request\n${describe()}`, "info")
          break
        case "remove":
        case "rm":
          if (!target) return ctx.ui.notify("usage: /egress remove <ssh-target>", "warning")
          removeHost(target)
          ctx.ui.notify(`removed ${target}\n${describe()}`, "info")
          break
        case "on":
        case "off":
          if (!target) return ctx.ui.notify(`usage: /egress ${verb} <ssh-target>`, "warning")
          setHostEnabled(target, verb === "on")
          ctx.ui.notify(`${verb === "on" ? "enabled" : "disabled"} ${target}\n${describe()}`, "info")
          break
        default:
          ctx.ui.notify(`unknown subcommand '${verb}' — try list/add/remove/on/off`, "warning")
      }
      if (listHosts().length === 0 && verb === "list") ctx.ui.notify("tip: /egress add student@100.125.193.75", "info")
    },
  })
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
