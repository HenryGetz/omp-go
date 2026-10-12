// Wire fingerprint for opencode.ai traffic.
//
// Every value here is pinned by ../capture/golden-requests.ndjson — the recorded
// output of the real opencode v2.0.26 harness talking to a stub Console — and by
// `packages/core/src/plugin/provider/opencode.ts` + `packages/core/src/app.ts` in
// github.com/anomalyco/opencode. `test/parity.ts` diffs this module's requests
// against the golden trace; change nothing without re-running it.

export type HarnessIdentity = {
  /** User-Agent channel segment, e.g. "latest". */
  channel: string
  /** User-Agent version segment, e.g. "2.0.26". */
  version: string
  /** User-Agent client segment: "cli" (npm/standalone), "acp", or "desktop". */
  name: string
}

export const DEFAULT_IDENTITY: HarnessIdentity = { channel: "latest", version: "2.0.26", name: "cli" }

export const CONSOLE_BASE = "https://opencode.ai/console"
export const ZEN_GO_BASE = "https://opencode.ai/zen/go/v1"
export const CLIENT_ID = "opencode-cli"

export const userAgent = (id: HarnessIdentity = DEFAULT_IDENTITY) =>
  `opencode/${id.channel}/${id.version}/${id.name}`

// --- Trace propagation -------------------------------------------------------
// The harness emits both `b3` (4-field) and `traceparent` on every request. All
// requests of one logical operation (a login, one inference turn) share the trace
// id; each request carries its own span id.

export type TraceContext = { trace: string; parent: string }

const hex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("")

const BASE62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

/** Harness-shaped session id: `ses_` + 26 base62 chars (golden trace shape). */
export function sessionID(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26))
  return `ses_${Array.from(bytes, (b) => BASE62[b % BASE62.length]).join("")}`
}

/** Harness-shaped project id: 40 lowercase hex chars (golden trace shape). */
export function projectID(): string {
  return hex(20)
}

export const newTrace = (): TraceContext => {
  const trace = hex(16)
  return { trace, parent: hex(8) }
}

export const spanHeaders = (trace: TraceContext): Record<string, string> => {
  const span = hex(8)
  return {
    b3: `${trace.trace}-${span}-1-${trace.parent}`,
    traceparent: `00-${trace.trace}-${span}-01`,
  }
}

// --- Console (https://opencode.ai/console) -----------------------------------

export type ConsoleAuth = {
  /** OAuth access token or service-account key; sent as `authorization: Bearer`. */
  token?: string
  /** Organization id; sent as `x-org-id` when present. Never sent on inference. */
  orgId?: string
}

/**
 * Headers for a Console request. `json: true` adds `content-type: application/json`
 * (the harness sends it only on POSTs; GETs are accept-only).
 */
export function consoleHeaders(
  auth: ConsoleAuth = {},
  options: { json?: boolean; identity?: HarnessIdentity; trace?: TraceContext } = {},
): Record<string, string> {
  return {
    accept: "application/json",
    ...(options.json ? { "content-type": "application/json" } : {}),
    ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}),
    ...(auth.orgId ? { "x-org-id": auth.orgId } : {}),
    "user-agent": userAgent(options.identity),
    ...spanHeaders(options.trace ?? newTrace()),
  }
}

// Body key order matches the harness byte-for-byte.

export const deviceCodeBody = () => ({ client_id: CLIENT_ID, supports_org_scope: true })

export const deviceTokenBody = (deviceCode: string) => ({
  grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  device_code: deviceCode,
  client_id: CLIENT_ID,
})

export const refreshTokenBody = (refreshToken: string) => ({
  grant_type: "refresh_token",
  refresh_token: refreshToken,
  client_id: CLIENT_ID,
})

/** GET {base}/api/v2/config — the steady-state Console call after login. */
export async function fetchConsoleConfig(
  base: string,
  auth: ConsoleAuth,
  options: { identity?: HarnessIdentity; fetch?: typeof fetch } = {},
): Promise<Response> {
  const f = options.fetch ?? fetch
  return f(`${base.replace(/\/+$/, "")}/api/v2/config`, {
    headers: consoleHeaders(auth, { identity: options.identity }),
  })
}

// --- Inference (https://opencode.ai/zen/go/v1) --------------------------------

export type SessionIdentity = {
  /** Session id (`ses_…`). */
  session: string
  /** Session affinity; equal to `session` unless the session is forked. */
  affinity: string
  /** Project id. */
  project: string
  /** Client name; mirrors the User-Agent name segment ("cli"). */
  client: string
  /** Parent session id; sent only for forked sessions. */
  parent?: string
}

/**
 * Fingerprint headers shared by gateway GETs and inference POSTs: User-Agent,
 * the session/project set, and trace propagation. No auth, accept, or
 * content-type — those belong to the calling transport.
 */
export function sessionHeaders(
  session: SessionIdentity,
  identity: HarnessIdentity = DEFAULT_IDENTITY,
): Record<string, string> {
  return {
    "user-agent": userAgent(identity),
    "x-opencode-client": session.client,
    "x-opencode-project": session.project,
    "x-opencode-session": session.affinity,
    "x-opencode-session-id": session.session,
    "x-session-affinity": session.affinity,
    "x-session-id": session.affinity,
    ...(session.parent
      ? {
          "x-opencode-parent-session-id": session.parent,
          "x-parent-session-id": session.parent,
        }
      : {}),
    ...spanHeaders(newTrace()),
  }
}

/**
 * Headers for a Go-gateway inference request. No `x-org-id` here — device-flow
 * tokens are workspace-bound and the harness omits it on inference.
 */
export function inferenceHeaders(
  token: string,
  session: SessionIdentity,
  identity: HarnessIdentity = DEFAULT_IDENTITY,
): Record<string, string> {
  return {
    accept: "*/*",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    ...sessionHeaders(session, identity),
  }
}

export type ChatRequest = {
  model: string
  messages: unknown[]
  tools?: unknown[]
  maxCompletionTokens?: number
}

/** Key order matches the harness: model, messages, tools, stream, stream_options, max_completion_tokens, store. */
export const chatBody = (req: ChatRequest) => ({
  model: req.model,
  messages: req.messages,
  ...(req.tools ? { tools: req.tools } : {}),
  stream: true,
  stream_options: { include_usage: true },
  ...(req.maxCompletionTokens !== undefined ? { max_completion_tokens: req.maxCompletionTokens } : {}),
  store: false,
})

export async function zenChatCompletion(
  req: ChatRequest,
  options: {
    token: string
    session: SessionIdentity
    identity?: HarnessIdentity
    base?: string
    fetch?: typeof fetch
  },
): Promise<Response> {
  const f = options.fetch ?? fetch
  const url = `${(options.base ?? ZEN_GO_BASE).replace(/\/+$/, "")}/chat/completions`
  return f(url, {
    method: "POST",
    headers: inferenceHeaders(options.token, options.session, options.identity),
    body: JSON.stringify(chatBody(req)),
  })
}
