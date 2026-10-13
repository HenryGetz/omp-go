// omp extension entry: registers the opencode Go subscription end to end —
// `pi.registerProvider("opencode-go", …)` wires /login OAuth, the model
// catalog, the inference fingerprint, usage/limits, and (through the host)
// the `omp auth-broker` provider entry.

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"
import { registerOpencodeGo, sessionIdentity } from "./register"
import {
  addEgressFlow,
  addHost,
  listHosts,
  removeHost,
  setHostEnabled,
  sshConfigHosts,
  testEgressFlow,
  tunnelError,
  tunnelStatus,
} from "./egress"

export * from "./wire"
export * from "./opencode-provider"
export * from "./models"
export * from "./usage"
export * from "./register"

export default function opencodeAuthExtension(pi: ExtensionAPI): void {
  registerOpencodeGo(pi)
  pi.registerCommand("egress", {
    description:
      "Route free-tier traffic through your own machines — /egress [add <ssh-target>|remove <ssh-target>|on|off <ssh-target>|test|list]",
    getArgumentCompletions: (prefix) => {
      const words = ["list", "add", "remove", "on", "off", "test"]
      const targets = [...new Set([...listHosts().map((h) => h.target), ...sshConfigHosts()])]
      const args = prefix.split(/\s+/)
      const options = args.length > 1 ? targets : [...words, ...targets]
      const last = args[args.length - 1] ?? ""
      return options.filter((value) => value.startsWith(last)).map((value) => ({ value, label: value }))
    },
    handler: async (args, ctx) => {
      const [verb = "list", ...rest] = args.trim().split(/\s+/)
      const target = rest.join(" ")
      const describe = () =>
        tunnelStatus()
          .map(
            (host) =>
              `${host.enabled ? (host.tunnel ? "UP  " : "DOWN") : "off "} ${host.target}${host.port ? ` (127.0.0.1:${host.port})` : ""}${
                host.enabled && !host.tunnel ? ` — ${tunnelError(host.target) ?? "not connected"}` : ""
              }`,
          )
          .join("\n") || "no egress hosts configured"

      const addFlow = async (input: string) => {
        const { message, ok } = await addEgressFlow(input)
        ctx.ui.notify(message, ok ? "info" : "warning")
      }

      switch (verb) {
        case "list":
        case "":
          if (listHosts().length === 0) {
            const input = await ctx.ui.input("SSH target to route free-tier traffic through", "user@host")
            if (input?.trim()) await addFlow(input.trim())
            else ctx.ui.notify("no egress hosts configured — /egress add user@host whenever", "info")
            return
          }
          ctx.ui.notify(`egress hosts:\n${describe()}`, "info")
          break
        case "add": {
          const input = target || (await ctx.ui.input("SSH target to route free-tier traffic through", "user@host"))
          if (!input?.trim()) return ctx.ui.notify("usage: /egress add <ssh-target> (e.g. student@100.125.193.75)", "warning")
          await addFlow(input.trim())
          break
        }
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
        case "test": {
          ctx.ui.notify("probing egress hosts…", "info")
          ctx.ui.notify(await testEgressFlow(), "info")
          break
        }
        default:
          ctx.ui.notify(`unknown subcommand '${verb}' — try list/add/remove/on/off/test`, "warning")
      }
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
