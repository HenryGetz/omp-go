// Minimal HTTP/1.1 response reader over a raw socket.
//
// bun's node:http(s) client ignores `createConnection` (request-level and
// agent-level alike) and dials its own connection — which silently bypasses
// any tunnel. Since the request head is already hand-assembled byte-exact
// (src/ordered-fetch.ts), the matching core is a hand parser over the socket.

import type net from "node:net"

export type RawResponse = {
  status: number
  statusText: string
  headers: Record<string, string | string[]>
  body: ReadableStream<Uint8Array>
}

function pushStream(): { stream: ReadableStream<Uint8Array>; push: (chunk: Uint8Array) => void; close: () => void; fail: (error: Error) => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  return {
    stream,
    push: (chunk) => controller.enqueue(chunk),
    close: () => controller.close(),
    fail: (error) => controller.error(error),
  }
}

/**
 * Read exactly `count` bytes from the socket's paused-mode buffer. A
 * connection dropped mid-frame resolves `read(n)` SHORT at EOF (all remaining
 * data, fewer than n bytes); resolving that short made a truncated body look
 * like a valid one and the tail misparsed — so a partial buffer at close now
 * REJECTS. `null` means a clean EOF with nothing buffered.
 */
function readBytes(socket: net.Socket, count: number): Promise<Buffer | null> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer | null>()
  if (count <= 0) {
    resolve(Buffer.alloc(0))
    return promise
  }
  let got: Buffer = Buffer.alloc(0)
  const cleanup = () => {
    socket.off("readable", tryRead)
    socket.off("error", onError)
    socket.off("close", onClose)
  }
  const tryRead = () => {
    while (got.byteLength < count) {
      const chunk = socket.read(count - got.byteLength) as Buffer | null
      if (!chunk) return // wait for the next readable/close event
      got = got.byteLength > 0 ? Buffer.concat([got, chunk]) : chunk
    }
    cleanup()
    resolve(got)
  }
  const onError = (error: Error) => {
    cleanup()
    reject(error)
  }
  const onClose = () => {
    cleanup()
    if (got.byteLength > 0)
      reject(new Error(`raw-http: connection closed after ${got.byteLength} of ${count} bytes`))
    else resolve(null)
  }
  socket.on("readable", tryRead)
  socket.on("error", onError)
  socket.on("close", onClose)
  tryRead()
  return promise
}

/**
 * Read the next available chunk, whatever its length. EOF-framed bodies have
 * no declared boundary — the connection's end IS the frame — so short reads
 * are the normal case and `null` (clean EOF) terminates the stream.
 */
function readSome(socket: net.Socket, count: number): Promise<Buffer | null> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer | null>()
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
    resolve(null) // stream ended before the bytes arrived
  }
  socket.on("readable", tryRead)
  socket.on("error", onError)
  socket.on("close", onClose)
  tryRead()
  return promise
}

/** Read one CRLF-terminated line (bounded). */
function readLine(socket: net.Socket): Promise<string | null> {
  return (async () => {
    let line = Buffer.alloc(0)
    for (;;) {
      const byte = await readBytes(socket, 1)
      if (byte === null) {
        // EOF mid-line is a truncated head/chunk-size line, not a clean end.
        if (line.byteLength > 0) throw new Error("raw-http: connection closed mid-line")
        return null
      }
      line = Buffer.concat([line, byte])
      if (line.subarray(-2).toString("latin1") === "\r\n") return line.toString("latin1").trim()
      if (line.byteLength > 8192) throw new Error("line too long")
    }
  })()
}

/** Parse a full request response from `socket` into a fetch-like shape. */
export async function readHttpResponse(socket: net.Socket): Promise<RawResponse> {
  // Head: read byte-wise until CRLFCRLF (bounded), keeping surplus buffered.
  let head = Buffer.alloc(0)
  for (;;) {
    const byte = await readBytes(socket, 1)
    if (byte === null) throw new Error("connection closed before response head")
    head = Buffer.concat([head, byte])
    if (head.subarray(-4).toString("latin1") === "\r\n\r\n") break
    if (head.byteLength > 64 * 1024) throw new Error("response head too large")
  }
  const [statusLine, ...headerLines] = head.toString("latin1").split("\r\n")
  const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine)
  if (!match) throw new Error(`malformed status line: ${statusLine}`)
  const headers: Record<string, string | string[]> = {}
  for (const line of headerLines) {
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    const existing = headers[name]
    if (existing === undefined) headers[name] = value
    else if (Array.isArray(existing)) existing.push(value)
    else headers[name] = [existing, value]
  }

  const out = pushStream()
  const single = (name: string) => {
    const value = headers[name]
    return (Array.isArray(value) ? value[0] : value) ?? ""
  }
  const chunked = single("transfer-encoding").toLowerCase().includes("chunked")
  const contentLength = Number(single("content-length") || NaN)

  void (async () => {
    try {
      if (chunked) {
        for (;;) {
          const sizeLine = await readLine(socket)
          if (sizeLine === null) throw new Error("raw-http: connection closed before the terminal chunk")
          const size = Number.parseInt(sizeLine.split(";")[0], 16)
          if (!Number.isFinite(size)) throw new Error(`malformed chunk size: ${sizeLine}`)
          if (size === 0) break // trailer section is not interesting
          const chunk = await readBytes(socket, size)
          if (chunk === null) throw new Error("raw-http: connection closed before the chunk body arrived")
          out.push(new Uint8Array(chunk))
          const crlf = await readBytes(socket, 2) // CRLF after the chunk
          if (crlf === null) throw new Error("raw-http: connection closed after a chunk body without CRLF")
        }
      } else if (Number.isFinite(contentLength)) {
        const chunk = await readBytes(socket, contentLength)
        if (chunk === null) throw new Error("raw-http: connection closed before the content-length body arrived")
        if (chunk.byteLength > 0) out.push(new Uint8Array(chunk))
      } else {
        for (;;) {
          const chunk = await readSome(socket, 65536)
          if (chunk === null) break
          out.push(new Uint8Array(chunk))
        }
      }
      out.close()
    } catch (error) {
      out.fail(error as Error)
    }
  })()

  return {
    status: Number(match[1]),
    statusText: match[2] ?? "",
    headers,
    body: out.stream,
  }
}

/** Assemble a request head line-by-line (values are used verbatim). */
export function buildRequestHead(method: string, path: string, headers: Record<string, string>): string {
  const lines = [`${method} ${path} HTTP/1.1`]
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
  return `${lines.join("\r\n")}\r\n\r\n`
}
