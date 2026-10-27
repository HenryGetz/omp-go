// omp extension entry: registers the opencode Go subscription end to end —
// `pi.registerProvider("opencode-go", …)` wires /login OAuth, the model
// catalog, the inference fingerprint, usage/limits, and (through the host)
// the `omp auth-broker` provider entry.

import { appendFileSync } from "node:fs"
import type { ExtensionAPI, RegisteredCommand } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types"
import { registerOpencodeGo, sessionIdentity } from "./register"
import { ensureModelsOverride } from "./models-config"
import { pinNewSession } from "./routing"
import { trafficReport } from "./traffic"
import { freeModels } from "./models"
import { freeUsageReport } from "./free-usage"
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
  // Cache-strategic account routing (src/routing.ts): pin every fresh session
  // to the warm leader before its first prompt reaches a provider — the host
  // awaits `session_start`, so the pin lands ahead of credential selection.
  // Resumed sessions keep their existing pin (drain-in-place); any failure
  // falls back to omp's default ranking.
  const routingPinned = new Set<string>()
  pi.on("session_start", (_event, ctx) => {
    // Test seam (env-gated, like OMP_ORG_DEBUG): switch the session model
    // through the REGISTRY entry via pi.setModel - the exact call ompreset's
    // `/go` makes when applying a preset. Exists so the PTY harness can
    // reproduce the mid-session preset switch without synthetic keystrokes
    // (the composer never submits under the harness).
    const seam = process.env.OMP_TEST_SETMODEL
    const seamSwitch = (() => {
      if (!seam) return Promise.resolve()
      const slash = seam.indexOf("/")
      const provider = slash > 0 ? seam.slice(0, slash) : seam
      const id = slash > 0 ? seam.slice(slash + 1) : seam
      return (async () => {
        const seamLog = (line: string) => {
          const file = process.env.OMP_ORG_DEBUG
          if (file) {
            try {
              appendFileSync(file, `${JSON.stringify({ seam: line })}\n`)
            } catch {}
          }
        }
        const registry = (ctx as { modelRegistry?: { find?: (p: string, i: string) => unknown } }).modelRegistry
        let model: unknown
        try {
          model = registry?.find?.(provider, id)
          seamLog(`registry.find(${provider},${id}) -> ${model ? "found" : "none"}`)
        } catch (error) {
          seamLog(`registry.find threw: ${String(error).slice(0, 80)}`)
        }
        if (!model) {
          const resolver = (ctx as { models?: { resolve?: (ref: string) => unknown } }).models
          try {
            model = resolver?.resolve?.(`${provider}/${id}`)
            seamLog(`models.resolve(${provider}/${id}) -> ${model ? "found" : "none"}`)
          } catch (error) {
            seamLog(`models.resolve threw: ${String(error).slice(0, 80)}`)
          }
        }
        if (model) {
          await pi.setModel(model as never)
          seamLog("setModel called")
        } else {
          seamLog("NO MODEL RESOLVED - seam was a no-op")
        }
      })().catch((error: unknown) => undefined)
    })()
    const sessionId = ctx.sessionManager.getSessionId()
    // Renew the managed models.yml block every session: it carries the
    // per-model reasoning defaults (max effort) and lags behind upgrades if
    // it only renews at login — silently reverting chats to the gateway's
    // low-effort default. Best-effort; the block is ours to own.
    try {
      ensureModelsOverride()
    } catch {}
    if (!sessionId || routingPinned.has(sessionId)) return seamSwitch
    routingPinned.add(sessionId)
    return seamSwitch.then(() => pinNewSession(pi, sessionId)).then(
      () => undefined,
      () => undefined,
    )
  })
  pi.registerCommand("egress", {
    description:
      "Route free-tier traffic through your own machines — /egress [add <ssh-target>|remove <ssh-target>|on|off <ssh-target>|test|traffic|list]",
    getArgumentCompletions: (prefix) => {
      const words = ["list", "add", "remove", "on", "off", "test", "traffic"]
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
          if (!input?.trim()) return ctx.ui.notify("usage: /egress add <ssh-target> (e.g. student@192.0.2.10)", "warning")
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
        case "traffic":
          ctx.ui.notify(trafficReport(), "info")
          break
        default:
          ctx.ui.notify(`unknown subcommand '${verb}' — try list/add/remove/on/off/test/traffic`, "warning")
      }
    },
  })
  // Free-tier usage, local accounting only (src/free-usage.ts): the free tier
  // has no usage surface to query, so this reads the client-side ledger. Aliases
  // share one handler — `registerCommand` has no alias field, and the three
  // spellings are all things people type.
  const freeUsageDescription = "OpenCode free-tier usage (local accounting) — /freeusage [model-filter]"
  const freeUsageCompletions: NonNullable<RegisteredCommand["getArgumentCompletions"]> = (prefix) => {
    const last = (prefix.split(/\s+/).pop() ?? "").toLowerCase()
    return freeModels()
      .map((model) => model.id)
      .filter((id) => id.toLowerCase().startsWith(last))
      .map((id) => ({ value: id, label: id }))
  }
  const freeUsageHandler: RegisteredCommand["handler"] = async (args, ctx) => {
    ctx.ui.notify(freeUsageReport({ filter: args.trim() || undefined }), "info")
  }
  for (const name of ["freeusage", "fusage", "free-usage"]) {
    pi.registerCommand(name, {
      description: freeUsageDescription,
      getArgumentCompletions: freeUsageCompletions,
      handler: freeUsageHandler,
    })
  }
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
