// Egress pool for harness transport requests.
//
// Per-endpoint metering means each machine's public IP carries its own free
// budget. Point OMP_GO_PROXIES at tunnels to your other machines and the free
// lane spreads across them:
//
//   ssh -D 1081 home-box        # terminal 1
//   ssh -D 1082 school-box      # terminal 2
//   OMP_GO_PROXIES="socks5://127.0.0.1:1081,socks5://127.0.0.1:1082" omp
//
// Supported: `socks5://[user:pass@]host:port` (ssh -D, any SOCKS5 server) and
// `http://[user:pass@]host:port` (CONNECT tunneling). Requests round-robin
// across the list; a proxy that fails to connect is skipped for the rest of the
// process after `MAX_FAILURES` strikes, and when every proxy is down requests
// go direct rather than failing outright (set OMP_GO_PROXY_STRICT=1 to fail
// instead).

import net from "node:net"

export const PROXIES_ENV = "OMP_GO_PROXIES"
export const PROXY_STRICT_ENV = "OMP_GO_PROXY_STRICT"

export type Proxy = {
  protocol: "socks5" | "http"
  host: string
  port: number
  auth?: { username: string; password: string }
  raw: string
}

export function parseProxy(raw: string): Proxy {
  const url = new URL(raw.trim())
  const protocol = url.protocol === "socks5:" || url.protocol === "socks:" ? "socks5" : "http"
  const auth = url.username ? { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } : undefined
  return { protocol, host: url.hostname, port: Number(url.port) || (protocol === "socks5" ? 1080 : 8080), auth, raw: raw.trim() }
}

export function parseProxyList(value: string | undefined): Proxy[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseProxy)
}

let rotation = 0
const failures = new Map<string, number>()

/** Round-robin over healthy proxies; `undefined` means go direct. */
export function nextProxy(list: Proxy[]): Proxy | undefined {
  const healthy = list.filter((proxy) => (failures.get(proxy.raw) ?? 0) < 3)
  if (healthy.length === 0) {
    if (list.length > 0 && process.env[PROXY_STRICT_ENV] === "1") throw new Error("all proxies down and OMP_GO_PROXY_STRICT=1")
    return undefined
  }
  return healthy[rotation++ % healthy.length]
}

export function markProxyFailure(proxy: Proxy): void {
  failures.set(proxy.raw, (failures.get(proxy.raw) ?? 0) + 1)
}

export function resetProxyHealth(): void {
  failures.clear()
  rotation = 0
}

function readExact(socket: net.Socket, count: number): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>()
  // Paused-mode `read(n)` returns exactly n bytes and keeps any surplus
  // buffered for the next reader — no data can be lost between handshake
  // frames, and no flowing-mode listener juggling.
  const cleanup = () => {
    socket.off("readable", tryRead)
    socket.off("error", onError)
    socket.off("close", onClose)
  }
  const tryRead = () => {
    const chunk = socket.read(count) as Buffer | null
    if (chunk) {
      cleanup()
      resolve(chunk)
    }
  }
  const onError = (error: Error) => {
    cleanup()
    reject(error)
  }
  const onClose = () => {
    cleanup()
    reject(new Error("proxy closed the connection"))
  }
  socket.on("readable", tryRead)
  socket.on("error", onError)
  socket.on("close", onClose)
  tryRead()
  return promise
}

async function socks5Connect(socket: net.Socket, proxy: Proxy, host: string, port: number): Promise<void> {
  const methods = proxy.auth ? [0x00, 0x02] : [0x00]
  socket.write(Buffer.from([0x05, methods.length, ...methods]))
  const greeting = await readExact(socket, 2)
  if (greeting[0] !== 0x05) throw new Error(`socks5 proxy ${proxy.raw}: bad greeting`)
  const method = greeting[1]
  if (method === 0x02) {
    if (!proxy.auth) throw new Error(`socks5 proxy ${proxy.raw}: auth required`)
    const user = Buffer.from(proxy.auth.username)
    const pass = Buffer.from(proxy.auth.password)
    socket.write(Buffer.concat([Buffer.from([0x01, user.byteLength]), user, Buffer.from([pass.byteLength]), pass]))
    const auth = await readExact(socket, 2)
    if (auth[1] !== 0x00) throw new Error(`socks5 proxy ${proxy.raw}: auth rejected`)
  } else if (method !== 0x00) {
    throw new Error(`socks5 proxy ${proxy.raw}: no acceptable auth method`)
  }
  const target = Buffer.from(host)
  socket.write(
    Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, target.byteLength]),
      target,
      Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    ]),
  )
  const reply = await readExact(socket, 4)
  if (reply[1] !== 0x00) throw new Error(`socks5 proxy ${proxy.raw}: connect failed (code ${reply[1]})`)
  // Consume the bound-address frame so no stray bytes reach the TLS handshake.
  const consume = async () => {
    if (reply[3] === 0x01) await readExact(socket, 4 + 2)
    else if (reply[3] === 0x04) await readExact(socket, 16 + 2)
    else {
      const len = (await readExact(socket, 1))[0]
      await readExact(socket, len + 2)
    }
  }
  await consume()
}

async function httpConnect(socket: net.Socket, proxy: Proxy, host: string, port: number): Promise<void> {
  const auth = proxy.auth
    ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.auth.username}:${proxy.auth.password}`).toString("base64")}\r\n`
    : ""
  socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`)
  // Read until the end of the proxy's response head.
  let head = ""
  for (;;) {
    const chunk = await readExact(socket, 1)
    head += chunk.toString("latin1")
    if (head.includes("\r\n\r\n")) break
    if (head.length > 8192) throw new Error(`proxy ${proxy.raw}: oversized CONNECT response`)
  }
  const status = Number(head.split(" ")[1])
  if (status !== 200) throw new Error(`proxy ${proxy.raw}: CONNECT ${status}`)
}

/**
 * Open a tunnel to `host:port` through `proxy`. The returned socket is the raw
 * tunnel; wrap it in TLS for https targets.
 */
export async function connectViaProxy(proxy: Proxy, host: string, port: number, timeoutMs = 15_000): Promise<net.Socket> {
  const socket = net.connect(proxy.port, proxy.host)
  socket.setNoDelay(true)
  {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`proxy ${proxy.raw}: connect timeout`))
    }, timeoutMs)
    socket.once("connect", () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    await promise
  }
  try {
    // Whole-handshake deadline: a half-dead tunnel (slow or wedged ssh) would
    // otherwise sit in the greeting exchange forever and hang the request
    // instead of failing over to the next hop.
    const { promise: handshake, resolve: done, reject: bail } = Promise.withResolvers<void>()
    const timer = setTimeout(() => bail(new Error(`proxy ${proxy.raw}: handshake timeout`)), timeoutMs)
    void (async () => {
      if (proxy.protocol === "socks5") await socks5Connect(socket, proxy, host, port)
      else await httpConnect(socket, proxy, host, port)
    })().then(() => {
      clearTimeout(timer)
      done()
    }, (error) => {
      clearTimeout(timer)
      bail(error as Error)
    })
    await handshake
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}
