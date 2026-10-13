// Egress pool unit tests: proxy parsing, round-robin/failover, and the SOCKS5
// tunnel handshake (against a mock server — no network).

import assert from "node:assert/strict"
import net from "node:net"
import { connectViaProxy, markProxyFailure, nextProxy, parseProxy, parseProxyList, resetProxyHealth } from "../src/proxy"

// parse
const socks = parseProxy("socks5://user:pass@127.0.0.1:1081")
assert.equal(socks.protocol, "socks5")
assert.equal(socks.port, 1081)
assert.deepEqual(socks.auth, { username: "user", password: "pass" })
assert.equal(parseProxy("http://10.0.0.2").port, 8080)
assert.equal(parseProxyList(" socks5://127.0.0.1:1 , , http://127.0.0.1:2 ").length, 2)

// rotation + failover
resetProxyHealth()
const pool = parseProxyList("socks5://127.0.0.1:1,socks5://127.0.0.1:2,socks5://127.0.0.1:3")
assert.equal(nextProxy(pool)?.raw, "socks5://127.0.0.1:1")
assert.equal(nextProxy(pool)?.raw, "socks5://127.0.0.1:2")
assert.equal(nextProxy(pool)?.raw, "socks5://127.0.0.1:3")
assert.equal(nextProxy(pool)?.raw, "socks5://127.0.0.1:1", "rotates")
markProxyFailure(pool[0])
markProxyFailure(pool[0])
markProxyFailure(pool[0])
const afterStrike = new Set([1, 2, 3].map(() => nextProxy(pool)?.port))
assert.ok(!afterStrike.has(1), "struck proxy drops out of rotation")
resetProxyHealth()
assert.equal(nextProxy([]), undefined, "no proxies configured -> direct")

// SOCKS5 handshake + tunnel against a mock server
{
  const { promise, resolve, reject } = Promise.withResolvers<number>()
  const server = net.createServer((socket) => {
    let phase = 0
    socket.on("data", (chunk) => {
      if (phase === 0) {
        // greeting -> no-auth
        phase = 1
        socket.write(Buffer.from([0x05, 0x00]))
        return
      }
      if (phase === 1) {
        // connect request -> success + payload already flowing behind the frame
        phase = 2
        assert.ok(chunk.includes("opencode.ai"), "connect request carries the target host")
        socket.write(Buffer.concat([Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]), Buffer.from("PONG")]))
      }
    })
    socket.on("error", () => undefined)
  })
  server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port))
  const port = await promise
  try {
    const tunnel = await connectViaProxy(parseProxy(`socks5://127.0.0.1:${port}`), "opencode.ai", 443)
    const { promise: got, resolve: finish } = Promise.withResolvers<Buffer>()
    tunnel.once("data", finish)
    tunnel.write("PING")
    const echo = await got
    assert.equal(echo.toString(), "PONG", "bytes flow through the SOCKS5 tunnel")
    tunnel.destroy()
  } catch (error) {
    reject(error as Error)
    throw error
  } finally {
    server.close()
  }
}

console.log("PROXY OK: parsing, round-robin failover, and SOCKS5 tunneling pinned")
