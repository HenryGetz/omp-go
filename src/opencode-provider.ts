// Native omp OAuth provider for the opencode Console / Go subscription.
//
// Wire contract pinned by github.com/anomalyco/opencode
// `packages/core/src/plugin/provider/opencode.ts` and verified byte-for-byte
// against capture/golden-requests.ndjson (see test/parity.ts):
//
//   POST {base}/auth/device/code   JSON {client_id:"opencode-cli", supports_org_scope:true}
//   POST {base}/auth/device/token  JSON {grant_type:"urn:ietf:params:oauth:grant-type:device_code", …}
//   GET  {base}/api/user           Bearer
//   GET  {base}/api/orgs           Bearer
//   POST {base}/auth/device/token  JSON {grant_type:"refresh_token", …}   (rotation)
//
// Semantics that are load-bearing and must not drift:
// - Poll bodies are parsed regardless of HTTP status (the harness does the same).
// - `slow_down` adds 5s to the poll interval; the first poll waits `interval` s.
// - Refresh tokens are single-use: the rotated pair must be persisted before any
//   other request (AuthStorage owns that persistence and single-flights refresh).
// - `400 {"error":"invalid_grant"}` means the session is dead: surface a
//   token-refresh failure so omp asks for a fresh login instead of retrying.

import { OAuthError } from "@oh-my-pi/pi-ai/error"
import {
  pollOAuthDeviceCodeFlow,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type OAuthProviderInterface,
} from "@oh-my-pi/pi-ai/registry/oauth"
import { refreshConsoleConfig } from "./console-config"
import { writeModelsOverride } from "./models-config"
import { providerOverride } from "./console-config"
import {
  CONSOLE_BASE,
  DEFAULT_IDENTITY,
  consoleHeaders,
  deviceCodeBody,
  deviceTokenBody,
  newTrace,
  refreshTokenBody,
  type HarnessIdentity,
} from "./wire"

type DeviceAuthorization = {
  device_code: string
  user_code: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

type ConsoleToken = {
  access_token: string
  refresh_token: string
  expires_in: number
  org_id?: string | null
}

type ConsoleUser = { id: string; email: string }
type ConsoleOrg = { id: string; name: string }

export type OpencodeProviderOptions = {
  /** Console base URL. Defaults to the production console. */
  server?: string
  /** Harness identity to emit on the wire (User-Agent + client name). */
  identity?: HarnessIdentity
  fetch?: typeof fetch
}

export class OpencodeOAuthProvider implements OAuthProviderInterface {
  readonly id = "opencode"
  readonly name = "OpenCode Console (Go subscription)"
  /** omp's model layer keys Go-subscription auth under this id; store there. */
  readonly storeCredentialsAs = "opencode-go"
  readonly sourceId = "omp-opencode-auth"

  constructor(private readonly options: OpencodeProviderOptions = {}) {}

  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const doFetch = this.options.fetch ?? fetch
    const base = this.base()
    const identity = this.options.identity ?? DEFAULT_IDENTITY
    // One trace id across the whole login, as the harness groups it.
    const trace = newTrace()

    const codeResponse = await doFetch(`${base}/auth/device/code`, {
      method: "POST",
      headers: consoleHeaders({}, { json: true, identity, trace }),
      body: JSON.stringify(deviceCodeBody()),
    })
    if (!codeResponse.ok)
      throw new OAuthError(`Device authorization failed: HTTP ${codeResponse.status}`, {
        kind: "http",
        provider: this.id,
        status: codeResponse.status,
      })
    const device = (await codeResponse.json()) as Partial<DeviceAuthorization>
    if (!device.device_code || !device.user_code || !device.verification_uri_complete ||
        typeof device.expires_in !== "number" || typeof device.interval !== "number")
      throw new OAuthError("Device authorization response is missing required fields", {
        kind: "validation",
        provider: this.id,
      })
    // The harness rejects non-HTTP(S) verification URLs instead of opening them.
    const verification = new URL(device.verification_uri_complete, `${base}/`)
    if (verification.protocol !== "http:" && verification.protocol !== "https:")
      throw new OAuthError(`Invalid device verification URL: ${verification.href}`, {
        kind: "validation",
        provider: this.id,
      })
    callbacks.onAuth({ url: verification.href, instructions: `Enter code: ${device.user_code}` })

    const deviceCode = device.device_code
    // The harness waits `interval` s before the first poll; pi-ai's helper polls
    // immediately, so match the harness cadence here.
    await sleep(device.interval * 1000, callbacks.signal)
    const token = await pollOAuthDeviceCodeFlow<ConsoleToken>({
      intervalSeconds: device.interval,
      expiresInSeconds: device.expires_in,
      signal: callbacks.signal,
      poll: async (signal) => {
        const response = await doFetch(`${base}/auth/device/token`, {
          method: "POST",
          headers: consoleHeaders({}, { json: true, identity, trace }),
          body: JSON.stringify(deviceTokenBody(deviceCode)),
          signal,
        })
        // Poll bodies classify regardless of status, matching the harness.
        const body = (await response.json().catch(() => undefined)) as Partial<ConsoleToken> & { error?: string } | undefined
        if (body?.access_token) return { status: "complete", value: body as ConsoleToken }
        if (body?.error === "authorization_pending") return { status: "pending" }
        if (body?.error === "slow_down") return { status: "slow_down" }
        return { status: "failed", message: `Device authorization failed: ${body?.error ?? `HTTP ${response.status}`}` }
      },
    })

    // Identity fetch: both calls in parallel with the fresh access token, no x-org-id.
    const auth = { token: token.access_token }
    const [userResponse, orgsResponse] = await Promise.all([
      doFetch(`${base}/api/user`, { headers: consoleHeaders(auth, { identity, trace }), signal: callbacks.signal }),
      doFetch(`${base}/api/orgs`, { headers: consoleHeaders(auth, { identity, trace }), signal: callbacks.signal }),
    ])
    if (!userResponse.ok || !orgsResponse.ok)
      throw new OAuthError(`Account lookup failed: HTTP ${userResponse.status}/${orgsResponse.status}`, {
        kind: "http",
        provider: this.id,
      })
    const user = (await userResponse.json()) as ConsoleUser
    const orgs = (await orgsResponse.json()) as ConsoleOrg[]
    // Harness org selection: token org when present (must exist), else first by name then id.
    const org =
      token.org_id == null
        ? orgs.toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0]
        : orgs.find((item) => item.id === token.org_id)
    if (token.org_id != null && !org)
      throw new OAuthError(`OpenCode organization not found: ${token.org_id}`, {
        kind: "validation",
        provider: this.id,
      })

    // Warm the Console config mirror before the first request: the harness
    // fetches /api/v2/config right after connect and merges the pushed headers
    // and endpoint (x-opencode-org-id, the /inference/go/... base URL).
    await refreshConsoleConfig({
      consoleBase: base,
      token: token.access_token,
      orgId: org?.id,
      identity: this.options.identity,
      fetch: doFetch,
    })
    // Keep the models.yml fingerprint block current with this workspace,
    // including the Console-config endpoints fetched just above.
    writeModelsOverride({ orgId: org?.id, identity: this.options.identity })
    return {
      refresh: token.refresh_token,
      access: token.access_token,
      expires: Date.now() + token.expires_in * 1000,
      accountId: user.id,
      email: user.email,
      orgId: org?.id,
      orgName: org?.name,
      // Console base for refresh; the harness persists it as credential metadata.server.
      apiEndpoint: base,
    }
  }

  async refreshToken(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials> {
    const doFetch = this.options.fetch ?? fetch
    // Prefer the base captured at login so a moved Console keeps refreshing correctly.
    const base = (credentials.apiEndpoint ?? this.base()).replace(/\/+$/, "")
    const identity = this.options.identity ?? DEFAULT_IDENTITY
    const response = await doFetch(`${base}/auth/device/token`, {
      method: "POST",
      headers: consoleHeaders({}, { json: true, identity }),
      body: JSON.stringify(refreshTokenBody(credentials.refresh)),
      signal,
    })
    if (response.status === 400) {
      const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
      if (body?.error === "invalid_grant")
        throw new OAuthError("OpenCode Console session expired; log in again", {
          kind: "token-refresh",
          provider: this.id,
          status: 400,
        })
    }
    if (!response.ok)
      throw new OAuthError(`Token refresh failed: HTTP ${response.status}`, {
        kind: "token-refresh",
        provider: this.id,
        status: response.status,
      })
    const token = (await response.json()) as ConsoleToken
    // Rotated pair: callers persist both before any further request (single-use refresh tokens).
    return {
      ...credentials,
      access: token.access_token,
      refresh: token.refresh_token,
      expires: Date.now() + token.expires_in * 1000,
      ...(token.org_id == null
        ? {}
        : {
            orgId: token.org_id,
            orgName:
              credentials.orgId === token.org_id && typeof credentials.orgName === "string"
                ? credentials.orgName
                : token.org_id,
          }),
    }
  }

  /** The Go gateway accepts the Console access token directly as a bearer key; no exchange exists. */
  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access
  }

  private base(): string {
    return (this.options.server ?? CONSOLE_BASE).replace(/\/+$/, "")
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  if (signal?.aborted) throw new OAuthError("Login cancelled", { kind: "http", provider: "opencode" })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new OAuthError("Login cancelled", { kind: "http", provider: "opencode" }))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
