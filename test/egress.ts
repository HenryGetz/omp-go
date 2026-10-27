// Egress tunnel unit tests: the ssh argv must opt out of the user's SSH
// multiplexing master, and the readiness probe must require a real SOCKS
// negotiation — a listener that accepts TCP but never speaks must not be
// reported ready (it would poison the request instead of failing over).

import assert from "node:assert/strict"
import net from "node:net"
import { socksProbe, tunnelArgs } from "../src/egress"

// argv: a connection of its own, never the user's ControlMaster
{
  const args = tunnelArgs(43210, "student@192.0.2.10")
  assert.equal(args[0], "-D")
  assert.equal(args[1], "127.0.0.1:43210")
  assert.ok(args.includes("ControlMaster=no"), "tunnel must not multiplex over the user's master")
  assert.ok(args.includes("ControlPath=none"), "tunnel must not reuse a control socket")
  assert.equal(args.at(-1), "student@192.0.2.10", "target stays last")
  assert.ok(args.includes("ExitOnForwardFailure=yes"), "forward failure still aborts the tunnel")
  assert.ok(args.includes("ServerAliveCountMax=3"), "keepalive policy unchanged")
  for (const [index, value] of args.entries())
    if (value === "-o") assert.ok(typeof args[index + 1] === "string" && !args[index + 1].startsWith("-"), `-o at ${index} carries a value`)
}

// probe: a plain TCP listener that never completes the greeting is not ready
{
  const { promise, resolve } = Promise.withResolvers<number>()
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on("error", () => undefined)
  })
  server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port))
  const port = await promise
  try {
    assert.equal(await socksProbe(port, 300), false, "TCP-accepting-but-silent listener fails the probe")
  } finally {
    for (const socket of sockets) socket.destroy()
    server.close()
  }
}

// probe: a listener that closes on the greeting is not ready
{
  const { promise, resolve } = Promise.withResolvers<number>()
  const server = net.createServer((socket) => socket.once("data", () => socket.destroy()))
  server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port))
  const port = await promise
  try {
    assert.equal(await socksProbe(port, 500), false, "closing the channel fails the probe")
  } finally {
    server.close()
  }
}

// probe: a real SOCKS5 greeting is ready
{
  const { promise, resolve } = Promise.withResolvers<number>()
  const server = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      assert.equal(chunk[0], 0x05, "probe speaks SOCKS5")
      socket.write(Buffer.from([0x05, 0x00]))
    })
    socket.on("error", () => undefined)
  })
  server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port))
  const port = await promise
  try {
    assert.equal(await socksProbe(port, 500), true, "a speaking SOCKS5 proxy is ready")
  } finally {
    server.close()
  }
}

console.log("EGRESS OK: tunnel argv opts out of ControlMaster, probe requires a real SOCKS5 greeting")
