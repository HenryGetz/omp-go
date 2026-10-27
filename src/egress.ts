// Persistent egress pool: named SSH hosts whose tunnels the plugin stands up
// on demand. Per-endpoint metering means each machine's public IP is its own
// free-tier budget; a pool spreads one omp across all of them.
//
//   /egress add student@192.0.2.10     # record a host
//   /egress                                # list + live tunnel status
//
// On the first request after a host is added (and on every omp start) a
// `ssh -D` dynamic tunnel is spawned per enabled host; the transport
// round-robins across the live tunnels plus any OMP_GO_PROXIES entries.
// BatchMode is used, so the hosts need key auth (they are your own machines).

import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { withStateLock } from "./state-lock"
import https from "node:https"
import net from "node:net"
import { homedir } from "node:os"
import path from "node:path"
import tls from "node:tls"
import { connectViaProxy, parseProxyList, type Proxy } from "./proxy"
import { buildRequestHead, readHttpResponse } from "./raw-http"

export type EgressHost = { target: string; enabled: boolean }

function agentHome(): string {
  // Respect $HOME like every other tool (Bun's homedir() prefers /etc/passwd,
  // which breaks profile-isolated runs).
  return process.env.HOME || homedir()
}

function configFile(): string {
  return path.join(agentHome(), ".omp", "agent", "omp-go-egress.json")
}

export function listHosts(): EgressHost[] {
  try {
    const parsed = JSON.parse(readFileSync(configFile(), "utf8")) as { hosts?: EgressHost[] }
    return parsed.hosts ?? []
  } catch {
    return []
  }
}

function saveHosts(hosts: EgressHost[]): void {
  try {
    mkdirSync(path.dirname(configFile()), { recursive: true })
    withStateLock(() => writeFileSync(configFile(), `${JSON.stringify({ hosts }, null, 2)}\n`, { mode: 0o600 }))
  } catch {
    // Best-effort: the pool degrades to env-only when the file is unwritable.
  }
}

export function addHost(target: string): EgressHost[] {
  const hosts = listHosts().filter((host) => host.target !== target)
  hosts.push({ target, enabled: true })
  saveHosts(hosts)
  return hosts
}

export function removeHost(target: string): EgressHost[] {
  const hosts = listHosts().filter((host) => host.target !== target)
  saveHosts(hosts)
  stopTunnel(target)
  return hosts
}

export function setHostEnabled(target: string, enabled: boolean): EgressHost[] {
  const hosts = listHosts().map((host) => (host.target === target ? { ...host, enabled } : host))
  saveHosts(hosts)
  if (!enabled) stopTunnel(target)
  return hosts
}

type Tunnel = { target: string; port: number; child: ChildProcess; stderr: string; ready: boolean }
const tunnels = new Map<string, Tunnel>()
const starting = new Map<string, Promise<void>>()

function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>()
  const server = net.createServer()
  server.on("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as net.AddressInfo).port
    server.close(() => resolve(port))
  })
  return promise
}

function stopTunnel(target: string): void {
  const tunnel = tunnels.get(target)
  if (!tunnel) return
  tunnels.delete(target)
  try {
    process.kill(-tunnel.child.pid!, "SIGTERM")
  } catch {
    tunnel.child.kill("SIGTERM")
  }
  // ssh configs with ForkAfterAuthentication daemonize: the child pid is a
  // reaped shell, the listener lives on. Kill by the unique forward port.
  try {
    spawn("pkill", ["-f", `ssh -D 127.0.0.1:${tunnel.port}`], { stdio: "ignore" })
  } catch {
    // best-effort
  }
}

/**
 * ssh argv for one host's dynamic tunnel.
 *
 * `ControlMaster=no` + `ControlPath=none` keep the tunnel on a connection of
 * its own. Users commonly put `ControlMaster auto` / `ControlPersist` in
 * ~/.ssh/config; a muxed `-D` forwards every SOCKS channel over that shared
 * master. When the master wedges it keeps the local port listening but closes
 * every channel — the tunnel then looks alive and poisons requests instead of
 * failing over. A tunnel we own must never inherit that state.
 */
export function tunnelArgs(port: number, target: string): string[] {
  return [
    "-D",
    `127.0.0.1:${port}`,
    "-N",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    target,
  ]
}

/**
 * One SOCKS5 method negotiation against `port`. The tunnel is ready only when
 * the proxy actually speaks SOCKS: a wedged SSH master (or a stale listener
 * from another process) still accepts TCP and then closes the channel, so a
 * TCP-connect probe would mark it ready and poison the next request.
 */
export function socksProbe(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((done) => {
    const socket = net.connect(port, "127.0.0.1")
    const finish = (ok: boolean) => {
      socket.destroy()
      done(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once("error", () => finish(false))
    socket.once("close", () => finish(false))
    socket.once("connect", () => socket.write(Buffer.from([0x05, 0x01, 0x00])))
    // Greeting reply: version 5 + a method we offered (0x00 no-auth; 0xff = none).
    socket.once("data", (chunk) => finish(chunk.length >= 2 && chunk[0] === 0x05 && chunk[1] !== 0xff))
  })
}

async function ensureTunnel(host: EgressHost): Promise<void> {
  const live = tunnels.get(host.target)
  if (live?.ready) return
  const inflight = starting.get(host.target)
  if (inflight) return inflight
  const work = (async () => {
    const port = await freePort()
    const child = spawn(
      "ssh",
      tunnelArgs(port, host.target),
      // Detached: the tunnel is a daemon child — runtimes reap attached
      // children (bun does so aggressively), which killed tunnels mid-flight.
      { stdio: ["ignore", "ignore", "pipe"], detached: true },
    )
    child.on("exit", () => {
      // Do NOT drop the record here: ForkAfterAuthentication configs make the
      // spawned child exit 0 while the listener lives on. The readiness loop
      // (port truth) owns the record's fate.
      const tail = record.stderr.trim()
      if (tail) lastErrors.set(host.target, tail)
    })
    tunnels.set(host.target, { target: host.target, port, child, stderr: "", ready: false })
    const record = tunnels.get(host.target)!
    child.stderr?.on("data", (chunk) => {
      record.stderr = `${record.stderr}${chunk}`.slice(-2000)
    })
    // Wait until the SOCKS proxy actually completes its handshake (bounded):
    // ssh takes a moment to establish, and a listener that accepts TCP but
    // never speaks SOCKS (wedged master, dead forward) must fail over to the
    // next hop instead of being marked ready.
    // The HANDSHAKE is the truth, not the process: ssh configs with
    // ForkAfterAuthentication make the spawned child exit 0 immediately while
    // the forwarded listener lives on.
    const deadline = Date.now() + 10_000
    for (;;) {
      const ready = await socksProbe(port)
      if (ready) {
        record.ready = true
        return
      }
      if (Date.now() > deadline) {
        stopTunnel(host.target)
        return
      }
      await new Promise((done) => setTimeout(done, 150))
    }
  })().finally(() => starting.delete(host.target))
  starting.set(host.target, work)
  return work
}

const lastErrors = new Map<string, string>()

/** Last lines of ssh's stderr for a host — the "why is this down" answer. */
export function tunnelError(target: string): string | undefined {
  const tunnel = tunnels.get(target)
  const text = (tunnel?.stderr.trim() || lastErrors.get(target) || "").trim()
  return text ? text.split("\n").slice(-3).join(" ") : undefined
}

/** The proxy for one host's live tunnel (spawning it if needed). */
export async function proxyFor(target: string): Promise<Proxy | undefined> {
  const host = listHosts().find((entry) => entry.target === target)
  if (!host) return undefined
  if (host.enabled) await ensureTunnel(host)
  const status = tunnelStatus().find((entry) => entry.target === target)
  return status?.tunnel && status.port !== undefined ? parseProxyList(`socks5://127.0.0.1:${status.port}`)[0] : undefined
}

/** GET an IP echo through `proxy` (or direct) — the egress address onboarding reports. */
export async function probeEgressIP(proxy?: Proxy): Promise<string> {
  if (!proxy) {
    const { promise, resolve, reject } = Promise.withResolvers<string>()
    const req = https.request(
      { host: "api.ipify.org", path: "/", method: "GET", headers: { host: "api.ipify.org", "user-agent": "omp-go-egress/1" } },
      (res) => {
        let body = ""
        res.on("data", (chunk) => (body += chunk))
        res.on("end", () => resolve(body.trim()))
      },
    )
    req.on("error", reject)
    req.end()
    return promise
  }
  // Proxied: hand request over the tunnel socket (node's client dials its own
  // connection and would silently bypass the tunnel).
  const tunnel = await connectViaProxy(proxy, "api.ipify.org", 443)
  const socket = tls.connect({ socket: tunnel, servername: "api.ipify.org" })
  await new Promise<void>((done) => socket.once("secureConnect", () => done()))
  socket.write(buildRequestHead("GET", "/", { host: "api.ipify.org", "user-agent": "omp-go-egress/1" }))
  const response = await readHttpResponse(socket)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let body = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    body += decoder.decode(value)
  }
  socket.destroy()
  return body.trim()
}

/** `Host` aliases from ~/.ssh/config — what /egress add offers to complete. */
export function sshConfigHosts(): string[] {
  try {
    const text = readFileSync(path.join(agentHome(), ".ssh", "config"), "utf8")
    return [...text.matchAll(/^\s*Host\s+(.+)$/gim)]
      .flatMap((match) => match[1].split(/\s+/))
      .filter((name) => name && !/[*?!]/.test(name))
  } catch {
    return []
  }
}

/**
 * The add flow shared by the /egress wizard and `omp --egress-add`: persist the
 * host, bring the tunnel up, and report what budget it adds. Returns the
 * message text so each surface can render it its own way.
 */
export async function addEgressFlow(target: string): Promise<{ message: string; ok: boolean }> {
  addHost(target)
  try {
    const proxy = await proxyFor(target)
    if (!proxy) {
      return {
        ok: false,
        message:
          `added ${target}, but the tunnel is not up yet — ${tunnelError(target) ?? "ssh did not connect"}.\n` +
          `If it is an auth error: ssh-copy-id ${target}`,
      }
    }
    const [ip, localIP] = await Promise.all([probeEgressIP(proxy), probeEgressIP()])
    const distinct = ip !== localIP
    return {
      ok: distinct,
      message: distinct
        ? `added ${target} — egress ${ip} (distinct from this machine's ${localIP})\nfree-tier traffic will rotate across it automatically`
        : `added ${target} — but it egresses via ${ip}, same as this machine.\nNo extra budget gained; still routed if you want it.`,
    }
  } catch (error) {
    return { ok: false, message: `added ${target}, but probing failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** The health check shared by `/egress test` and `omp --egress-test`. */
export async function testEgressFlow(): Promise<string> {
  const lines: string[] = []
  for (const host of tunnelStatus()) {
    if (!host.enabled) {
      lines.push(`off   ${host.target}`)
      continue
    }
    try {
      const proxy = await proxyFor(host.target)
      if (!proxy) throw new Error(tunnelError(host.target) ?? "tunnel down")
      lines.push(`UP    ${host.target} — egress ${await probeEgressIP(proxy)}`)
    } catch (error) {
      lines.push(`DOWN  ${host.target} — ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return lines.join("\n") || "no egress hosts configured"
}

/**
 * The tunnel behind a proxy hop died (its SOCKS port refused/timeout): drop
 * the record so the next request spawns a fresh ssh — that is the "revives
 * itself" half of the failover story.
 */
export function dropTunnelByProxy(proxy: Proxy): void {
  const port = Number(new URL(proxy.raw).port)
  for (const [target, tunnel] of tunnels) {
    if (tunnel.port === port) stopTunnel(target)
  }
}

/** Live tunnel state for `/egress` listings. */
export function tunnelStatus(): Array<EgressHost & { tunnel: boolean; port?: number }> {
  return listHosts().map((host) => {
    const tunnel = tunnels.get(host.target)
    return { ...host, tunnel: tunnel?.ready === true, port: tunnel?.port }
  })
}

/**
 * The transport's proxy pool: one socks5 entry per live tunnel, then any
 * static `OMP_GO_PROXIES` entries. Tunnels are spawned lazily here.
 */
export async function egressProxies(): Promise<Proxy[]> {
  for (const host of listHosts()) {
    if (host.enabled) await ensureTunnel(host)
  }
  const tunnelProxies = tunnelStatus()
    .filter((entry) => entry.tunnel && entry.port !== undefined)
    .map((entry) => parseProxyList(`socks5://127.0.0.1:${entry.port}`)[0])
  return [...tunnelProxies, ...parseProxyList(process.env.OMP_GO_PROXIES)]
}
