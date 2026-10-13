// Throwaway wire-capture stub emulating the opencode Console auth endpoints.
// Logs every request (method, url, headers, body) as NDJSON to STUB_LOG.
import { createServer } from "node:http"
import { appendFileSync } from "node:fs"

const LOG = process.env.STUB_LOG ?? "requests.ndjson"
const PORT = Number(process.env.STUB_PORT ?? 18987)
let devicePolls = 0
// One distinct account per completed device login (multi-account tests).
let accountSeq = 0
const accounts = new Map([
  [1, { userId: "usr_stub_1", email: "stub@example.com", orgId: "org_42", orgName: "Alpha Org" }],
])
function accountFor(n) {
  if (!accounts.has(n))
    accounts.set(n, { userId: `usr_stub_${n}`, email: `stub${n}@example.com`, orgId: `org_${42 + n}`, orgName: `Stub Org ${n}` })
  return accounts.get(n)
}
// Rotated tokens are issued as at_stub_(100+n); map back to the account.
function tokenAccountNumber(value) {
  const match = /(?:at|rt)_stub_(\d+)/.exec(String(value ?? ""))
  if (!match) return 1
  const n = Number(match[1])
  return n >= 100 ? n - 100 : n
}

function record(req, body) {
  const entry = {
    time: new Date().toISOString(),
    method: req.method,
    url: req.url,
    headers: req.headers,
    body,
  }
  appendFileSync(LOG, JSON.stringify(entry) + "\n")
  console.log(`--> ${req.method} ${req.url}`)
}

const send = (res, status, payload) => {
  const body = payload === undefined ? "" : JSON.stringify(payload)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
  res.end(body)
}

createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    record(req, body)
    const p = new URL(req.url, "http://localhost").pathname
    if (req.method === "POST" && p === "/console/auth/device/code")
      return send(res, 200, {
        device_code: "dev_stub_1",
        user_code: "ABCD-1234",
        verification_uri_complete: `http://127.0.0.1:${PORT}/console/device?user_code=ABCD-1234`,
        expires_in: 600,
        interval: 1,
      })
    if (req.method === "POST" && p === "/console/auth/device/token") {
      const grant = JSON.parse(body).grant_type
      if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
        devicePolls += 1
        if (devicePolls <= 2) return send(res, 200, { error: "authorization_pending" })
        accountSeq += 1
        const acct = accountFor(accountSeq)
        return send(res, 200, {
          access_token: `at_stub_${accountSeq}`,
          refresh_token: `rt_stub_${accountSeq}`,
          expires_in: 2,
          org_id: acct.orgId,
        })
      }
      if (grant === "refresh_token") {
        const n = tokenAccountNumber(JSON.parse(body).refresh_token)
        const acct = accountFor(n)
        // Rotated tokens offset by 100 so they stay distinct per account.
        return send(res, 200, {
          access_token: `at_stub_${100 + n}`,
          refresh_token: `rt_stub_${100 + n}`,
          expires_in: 3600,
          org_id: acct.orgId,
        })
      }
      return send(res, 400, { error: "unsupported_grant_type" })
    }
    if (req.method === "GET" && p === "/console/api/user") {
      const acct = accountFor(tokenAccountNumber(req.headers.authorization))
      return send(res, 200, { id: acct.userId, email: acct.email })
    }
    if (req.method === "GET" && p === "/console/api/orgs") {
      const acct = accountFor(tokenAccountNumber(req.headers.authorization))
      return send(res, 200, [
        { id: "org_1", name: "Zeta Org" },
        { id: acct.orgId, name: acct.orgName },
      ])
    }
    if (req.method === "GET" && p === "/console/api/v2/config") {
      // Realistic Console config: per-org attribution header + config-driven
      // inference endpoint, mirroring the live payload shape.
      const acct = accountFor(tokenAccountNumber(req.headers.authorization))
      return send(res, 200, {
        providers: {
          "opencode-go": {
            name: `${acct.orgName} / OpenCode Go`,
            settings: { baseURL: `http://127.0.0.1:${PORT}/inference/go/openai/v1` },
            headers: { "x-opencode-org-id": acct.orgId },
            models: {},
          },
          opencode: {
            name: `${acct.orgName} / OpenCode`,
            settings: { baseURL: `http://127.0.0.1:${PORT}/inference/openai/v1` },
            headers: { "x-opencode-org-id": acct.orgId },
            models: {},
          },
        },
      })
    }
    if (req.method === "POST" && (p === "/zen/go/v1/chat/completions" || p === "/inference/go/openai/v1/chat/completions")) {
      const payload = JSON.parse(body || "{}")
      // Region gate: workspaces of accounts 2+ are not Global; the gateway
      // refuses Go region-gated models for them (mirrors the live 400).
      const acct = accountFor(tokenAccountNumber(req.headers.authorization))
      const org = req.headers["x-opencode-org-id"]
      if (accountSeq >= 2 && org === accountFor(2).orgId && /deepseek/.test(String(payload.model)))
        return send(res, 400, {
          error: {
            type: "server_error",
            message:
              "Upstream request failed: This Go model requires Global regions. Select Global in your workspace's Privacy settings to use it.",
          },
        })
      const stream = payload.stream === true
      if (!stream)
        return send(res, 200, {
          id: "chatcmpl-stub",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "mimo-v2.6-pro",
          choices: [{ index: 0, message: { role: "assistant", content: "Hello from stub" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
        })
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      const chunk = (delta, finish) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-stub",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "mimo-v2.6-pro",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
      res.write(chunk({ role: "assistant", content: "Hello from stub" }, null))
      res.write(chunk({}, "stop"))
      res.write("data: [DONE]\n\n")
      return res.end()
    }
    if (req.method === "GET" && p === "/zen/go/v1/usage")
      return send(res, 200, {
        usage: {
          rolling: { percent: 42, status: "ok", resetsAt: "2026-10-12T20:00:00.000Z" },
          weekly: { percent: 85, status: "ok", resetsAt: "2026-10-15T00:00:00.000Z" },
          monthly: { percent: 12, status: "ok", resetsAt: "2026-11-01T00:00:00.000Z" },
        },
      })
    return send(res, 404, { error: "not_found", path: p })
  })
}).listen(PORT, "127.0.0.1", () => console.log(`stub console listening on http://127.0.0.1:${PORT}/console`))
