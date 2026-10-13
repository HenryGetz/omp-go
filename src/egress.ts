// Persistent egress pool: named SSH hosts whose tunnels the plugin stands up
// on demand. Per-endpoint metering means each machine's public IP is its own
// free-tier budget; a pool spreads one omp across all of them.
//
//   /egress add student@100.125.193.75     # record a host
//   /egress                                # list + live tunnel status
//
// On the first request after a host is added (and on every omp start) a
// `ssh -D` dynamic tunnel is spawned per enabled host; the transport
// round-robins across the live tunnels plus any OMP_GO_PROXIES entries.
// BatchMode is used, so the hosts need key auth (they are your own machines).

import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import net from "node:net"
import { homedir } from "node:os"
import path from "node:path"
import { parseProxyList, type Proxy } from "./proxy"

export type EgressHost = { target: string; enabled: boolean }

function configFile(): string {
  return path.join(homedir(), ".omp", "agent", "omp-go-egress.json")
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
    writeFileSync(configFile(), `${JSON.stringify({ hosts }, null, 2)}\n`, { mode: 0o600 })
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

type Tunnel = { target: string; port: number; child: ChildProcess }
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
  tunnel.child.kill("SIGTERM")
}

async function ensureTunnel(host: EgressHost): Promise<void> {
  const live = tunnels.get(host.target)
  if (live && live.child.exitCode === null && live.child.signalCode === null) return
  const inflight = starting.get(host.target)
  if (inflight) return inflight
  const work = (async () => {
    const port = await freePort()
    const child = spawn(
      "ssh",
      [
        "-D",
        `127.0.0.1:${port}`,
        "-N",
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        host.target,
      ],
      { stdio: "ignore" },
    )
    child.on("exit", () => {
      if (tunnels.get(host.target)?.child === child) tunnels.delete(host.target)
    })
    tunnels.set(host.target, { target: host.target, port, child })
    // Wait until the SOCKS port actually accepts connections (bounded): ssh
    // takes a moment to establish, and connecting early fails the request over
    // to direct egress.
    const deadline = Date.now() + 10_000
    for (;;) {
      if (child.exitCode !== null) {
        tunnels.delete(host.target)
        return
      }
      const ready = await new Promise<boolean>((done) => {
        const probe = net.connect(port, "127.0.0.1")
        probe.once("connect", () => {
          probe.destroy()
          done(true)
        })
        probe.once("error", () => done(false))
      })
      if (ready) return
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

/** Live tunnel state for `/egress` listings. */
export function tunnelStatus(): Array<EgressHost & { tunnel: boolean; port?: number }> {
  return listHosts().map((host) => {
    const tunnel = tunnels.get(host.target)
    const live = tunnel !== undefined && tunnel.child.exitCode === null && tunnel.child.signalCode === null
    return { ...host, tunnel: live, port: tunnel?.port }
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
