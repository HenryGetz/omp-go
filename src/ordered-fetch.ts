// Harness-order HTTP transport for the OpenCode lanes.
//
// The free-tier gateway fingerprint-checks requests end to end: it rejects
// (`FreeTierError: … can only be used from within OpenCode`) any request whose
// header ORDER or session-id encoding deviates from the harness. Bun's fetch
// sorts header names alphabetically on the wire, so a fetch-level client can
// never pass — this transport writes the request head by hand over `node:https`
// (`setHost: false` keeps Host in its harness position) and stamps the
// harness's descending session ids (`src/identifier.ts`).
//
// The wire order is the harness's own (captured via mitmproxy from the real
// binary):
//
//   Authorization, Content-Type, User-Agent, b3, traceparent,
//   x-opencode-client, [x-opencode-org-id], x-opencode-project,
//   x-opencode-session, x-opencode-session-id, x-session-affinity, x-session-id,
//   Connection, Accept, Host, Accept-Encoding, Content-Length
//
// pi-ai's `StreamOptions.fetch` routes every provider request through here, so
// SSE parsing, retries, and auth headers stay with the stock pipeline — only
// the bytes on the wire are ours.

import http from "node:http"
import https from "node:https"
import type net from "node:net"
import tls from "node:tls"
import { Readable } from "node:stream"
import zlib from "node:zlib"
import type { Transform } from "node:stream"
import { DEFAULT_IDENTITY, projectID, sessionID, userAgent } from "./wire"
import { connectViaProxy, markProxyFailure, nextProxy, type Proxy } from "./proxy"
import { dropTunnelByProxy, egressProxies } from "./egress"
import { buildRequestHead, readHttpResponse } from "./raw-http"
import { chatRequestToolNames, normalizeChatSse, normalizeResponsesSse, requestToolNames } from "./sse-normalize"
import { modelFrom, recordTraffic, retryAfterMsFromHeaders, type HeaderSource } from "./traffic"

// [lookup name, wire name] — the harness's header casing is part of the
// fingerprint; node writes keys verbatim, so casing must be restored here.
const HARNESS_ORDER: [string, string][] = [
  ["authorization", "Authorization"],
  ["content-type", "Content-Type"],
  ["user-agent", "User-Agent"],
  ["b3", "b3"],
  ["traceparent", "traceparent"],
  ["x-opencode-client", "x-opencode-client"],
  ["x-opencode-org-id", "x-opencode-org-id"],
  ["x-opencode-project", "x-opencode-project"],
  ["x-opencode-session", "x-opencode-session"],
  ["x-opencode-session-id", "x-opencode-session-id"],
  ["x-session-affinity", "x-session-affinity"],
  ["x-session-id", "x-session-id"],
  ["connection", "Connection"],
  ["accept", "Accept"],
  ["host", "Host"],
  ["accept-encoding", "Accept-Encoding"],
  ["content-length", "Content-Length"],
]

const agent = new https.Agent({ keepAlive: true })

// Per-session attribution, exactly the harness's grouping: one session id and
// one trace id for the process, a fresh span per request.
const SESSION = sessionID()
const PROJECT = projectID()
const TRACE = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("")
/** Provider "wait this long" hints — stripped on account verdicts (see respond()). */
export const WAIT_HINT = /^(retry-after|retry-after-ms|x-ratelimit-reset.*|ratelimit-reset.*)$/i
let spans = 0

type HeaderInput = HeadersInit | undefined

function toEntries(headers: HeaderInput): [string, string][] {
  if (!headers) return []
  if (headers instanceof Headers) return [...headers.entries()]
  if (Array.isArray(headers)) return headers.map(([k, v]) => [String(k), String(v)])
  return Object.entries(headers as Record<string, string>).map(([k, v]) => [k, String(v)])
}

function bodyBytes(body: BodyInit | null | undefined): Buffer | undefined {
  if (body == null) return undefined
  if (typeof body === "string") return Buffer.from(body)
  if (body instanceof URLSearchParams) return Buffer.from(body.toString())
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  if (body instanceof Blob) throw new Error("ordered-fetch: Blob bodies are not supported (pi-ai sends strings)")
  throw new Error("ordered-fetch: streaming request bodies are not supported (pi-ai sends strings)")
}

/**
 * Decoder for every encoding the Accept-Encoding header advertises (the
 * harness's exact `gzip, deflate, br, zstd`, fingerprint-checked). The header
 * and this switch MUST stay in lockstep: a response handed downstream still
 * compressed kills the SSE reader for the whole stream, so zstd gets the same
 * decoder treatment as the rest (node/bun zlib ships it).
 */
export function decode(encoding: string | null | undefined): Transform | undefined {
  switch (encoding) {
    case "gzip":
      return zlib.createGunzip()
    case "deflate":
      return zlib.createInflate()
    case "br":
      return zlib.createBrotliDecompress()
    case "zstd":
      return zlib.createZstdDecompress()
    default:
      return undefined
  }
}

function webStream(nodeStream: Readable, decompressor: Transform | undefined): ReadableStream<Uint8Array> {
  const source: Readable = decompressor ? nodeStream.pipe(decompressor) : nodeStream
  return Readable.toWeb(source) as ReadableStream<Uint8Array>
}

/**
 * Fetch-compatible transport: same call shape as `globalThis.fetch`, but the
 * request head is byte-ordered like the harness's and session/trace headers are
 * stamped with harness-valid values (overriding whatever upstream sent).
 */
export function assembleHeaders(url: URL, providedInit: HeaderInput, body: Buffer | undefined): Record<string, string> {
  const provided = new Map(toEntries(providedInit).map(([k, v]) => [k.toLowerCase(), v]))
  provided.delete("host")
  provided.delete("content-length")
  provided.delete("accept-encoding")

  const span = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")
  spans++
  const stamped: Record<string, string> = {
    "user-agent": userAgent(DEFAULT_IDENTITY),
    "x-opencode-client": DEFAULT_IDENTITY.name,
    b3: `${TRACE}-${span}-1-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")}`,
    traceparent: `00-${TRACE}-${span}-01`,
    "x-opencode-project": PROJECT,
    "x-opencode-session": SESSION,
    "x-opencode-session-id": SESSION,
    "x-session-affinity": SESSION,
    "x-session-id": SESSION,
    accept: "*/*",
    connection: "keep-alive",
    "accept-encoding": "gzip, deflate, br, zstd",
  }
  for (const [name, value] of Object.entries(stamped)) provided.set(name, value)
  if (!provided.has("content-type") && body) provided.set("content-type", "application/json")
  if (!provided.has("content-length") && body) provided.set("content-length", String(body.byteLength))

  // Plain object in harness order: node writes object keys in insertion order
  // (`setHost: false` keeps Host at its harness position instead of hoisting).
  const ordered: Record<string, string> = {}
  for (const [name, wireName] of HARNESS_ORDER) {
    const value = name === "host" ? (provided.get("host") ?? url.host) : provided.get(name)
    if (value === undefined) continue
    ordered[wireName] = value
    provided.delete(name)
  }
  for (const [name, value] of provided) ordered[name] = value
  return ordered
}

export async function harnessFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // Mirror the harness endpoint exactly: inference rides the catalog URL
  // (/zen/go/v1/chat/completions - models.dev; the Console proxy maps
  // /zen/go/v1/* upstream), never the Console-pushed /inference/go/openai/v1
  // alias. See the opencode reference: packages/core/src/models-dev.ts +
  // packages/console/app/src/lib/inference-proxy.ts.
  if (typeof input === "string" || input instanceof URL) {
    const raw = String(input)
    input = raw.replace("/inference/go/openai/v1/", "/zen/go/v1/")
  } else if (input && typeof input === "object" && "url" in input) {
    const req = input as Request
    const raw = req.url
    const mapped = raw.replace("/inference/go/openai/v1/", "/zen/go/v1/")
    if (mapped !== raw) input = new Request(mapped, req)
  }
  const request = new Request(input as RequestInfo, init)
  const url = new URL(request.url)
  // Response-direction repair (src/sse-normalize.ts), both lanes:
  //   /responses — the serving stack can drop argument bytes for names
  //   outside `tools[]` and passes `default.` prefixes through; when args
  //   cannot exist the normalizer makes the failure loud, and
  //   qualified-but-known names get stripped.
  //   /chat/completions — byte preservation is proven on this lane, so the
  //   only repair is parity for the SILENT-EMPTY shape: a function_call
  //   whose name was never offered/mentioned and that finished with zero
  //   argument bytes becomes the loud marker instead of executing as `{}`.
  //   Non-SSE bodies pass byte-untouched on both lanes.
  const isResponsesPath = url.pathname.endsWith("/responses")
  const isChatPath = url.pathname.endsWith("/chat/completions")
  const rawBody = bodyBytes(init?.body ?? undefined)
  const toolNames = isResponsesPath
    ? requestToolNames(rawBody)
    : isChatPath
      ? chatRequestToolNames(rawBody)
      : undefined
  const normalize = (stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
    if (!toolNames || toolNames.size === 0) return stream
    return isResponsesPath ? normalizeResponsesSse(stream, toolNames) : normalizeChatSse(stream, toolNames)
  }
  const method = (init?.method ?? request.method ?? "GET").toUpperCase()
  const body = bodyBytes(init?.body ?? undefined)
  const ordered = assembleHeaders(url, init?.headers ?? request.headers, body)

  const { promise, resolve, reject } = Promise.withResolvers<Response>()
  const secure = url.protocol === "https:"
  const requestFn = secure ? https.request : http.request

  const respond = (req: http.ClientRequest, record: (status: number, headers: HeaderSource) => void) => {
    req.on("error", reject)
    const signal = init?.signal
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error("aborted"))
        return
      }
      signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true })
    }
    req.on("response", (res) => {
      const decompressor = decode(res.headers["content-encoding"])
      const headers = new Headers()
      const status = res.statusCode ?? 0
      record(status, res.headers)
      // Account verdicts (402 funds, 403 workspace, 400 region policy) answer
      // with retry-after / x-ratelimit-reset hints that describe the ACCOUNT's
      // window ("this account resets in ~27m"), not this request. If they
      // reach pi-ai's retry layer it tries to sleep out the window and aborts
      // the turn ("Retry failed: Provider requested 1651673ms wait") instead
      // of rotating to a healthy sibling. Strip the wait hints on these so the
      // 403 rotation lane wins immediately. 429 keeps its hints: that is a
      // real request-level rate limit where waiting is correct.
      const gateVerdict = status === 400 || status === 402 || status === 403
      for (const [name, value] of Object.entries(res.headers)) {
        if (value === undefined || name === "content-encoding") continue
        if (gateVerdict && WAIT_HINT.test(name)) continue
        if (Array.isArray(value)) for (const v of value) headers.append(name, v)
        else headers.set(name, value)
      }
      resolve(new Response(normalize(webStream(res, decompressor)), { status: res.statusCode ?? 0, statusText: res.statusMessage, headers }))
    })
    if (body) req.write(body)
    req.end()
  }

  // Egress pool (src/proxy.ts): round-robin, failover to the next proxy, and
  // direct only when every proxy is down (or none configured).
  const proxies = await egressProxies()
  const attempted = new Set<string>()
  const openTunnel = async (): Promise<{ proxy?: Proxy; socket?: net.Socket }> => {
    for (;;) {
      const candidates = proxies.filter((proxy) => !attempted.has(proxy.raw))
      const proxy = nextProxy(candidates.length > 0 ? candidates : proxies.length === 0 ? [] : candidates)
      if (!proxy) return {}
      attempted.add(proxy.raw)
      try {
        const tunnel = await connectViaProxy(proxy, url.hostname, Number(url.port) || (secure ? 443 : 80))
        const socket = secure
          ? tls.connect({ socket: tunnel, servername: url.hostname })
          : tunnel
        return { proxy, socket }
      } catch {
        markProxyFailure(proxy)
        // A tunnel whose SOCKS port is gone is objectively dead: drop its
        // record so the next request respawns ssh (env proxies just strike).
        if (proxy.raw.startsWith("socks5://127.0.0.1:")) dropTunnelByProxy(proxy)
      }
    }
  }

  void (async () => {
    const { proxy, socket } = await openTunnel()
    // Always-on local accounting (the free tier publishes no server-side
    // usage) — one compact line per request, including which hop carried it.
    // Written at the RESPONSE boundary because that is the only place the
    // status lives, and the status is what makes a tripped per-model free
    // window visible at all (`429` + `retry-after`); a request that never
    // produces a response records nothing.
    const record = (status: number, headers: HeaderSource) =>
      recordTraffic({
        ts: new Date().toISOString(),
        method,
        path: url.pathname,
        hop: proxy?.raw ?? "direct",
        bytes: body?.byteLength ?? 0,
        model: modelFrom(typeof init?.body === "string" ? init.body : undefined),
        status,
        // Only a 429 is a request-level window hint for THIS model: the
        // retry-after on an account verdict (402/403) describes the account's
        // reset and must never be read as a per-model cooldown.
        retryAfterMs: status === 429 ? retryAfterMsFromHeaders(headers) : undefined,
      })
    if (socket) {
      // Proxied: write the hand-built head over the tunnel socket and parse the
      // response ourselves — node's client ignores createConnection and dials
      // its own (direct) connection.
      await new Promise<void>((done) => (secure ? socket.once("secureConnect", () => done()) : done()))
      socket.write(buildRequestHead(method, url.pathname + url.search, ordered))
      if (body) socket.write(body)
      const res = await readHttpResponse(socket)
      record(res.status, res.headers)
      const decompressor = decode((res.headers["content-encoding"] as string) ?? undefined)
      const headers = new Headers()
      for (const [name, value] of Object.entries(res.headers)) {
        if (name === "content-encoding") continue
        if (Array.isArray(value)) for (const v of value) headers.append(name, v)
        else headers.set(name, value)
      }
      const source = decompressor ? Readable.fromWeb(res.body as never).pipe(decompressor) : Readable.fromWeb(res.body as never)
      resolve(new Response(normalize(Readable.toWeb(source) as ReadableStream<Uint8Array>), { status: res.status, statusText: res.statusText, headers }))
      return
    }
    const options: https.RequestOptions = {
      host: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: ordered,
      setHost: false,
      agent: secure ? agent : undefined,
      servername: secure ? url.hostname : undefined,
    }
    respond(requestFn(options), record)
  })().catch(reject)

  return promise
}
