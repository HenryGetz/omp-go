// Throwaway wire-capture stub emulating the opencode Console auth endpoints.
// Logs every request (method, url, headers, body) as NDJSON to STUB_LOG.
import { createServer } from "node:http"
import { appendFileSync } from "node:fs"

const LOG = process.env.STUB_LOG ?? "requests.ndjson"
const PORT = Number(process.env.STUB_PORT ?? 18987)
let devicePolls = 0

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
        return send(res, 200, {
          access_token: "at_stub_1",
          refresh_token: "rt_stub_1",
          expires_in: 2,
          org_id: "org_42",
        })
      }
      if (grant === "refresh_token")
        return send(res, 200, {
          access_token: "at_stub_2",
          refresh_token: "rt_stub_2",
          expires_in: 3600,
          org_id: "org_42",
        })
      return send(res, 400, { error: "unsupported_grant_type" })
    }
    if (req.method === "GET" && p === "/console/api/user")
      return send(res, 200, { id: "usr_stub_1", email: "stub@example.com" })
    if (req.method === "GET" && p === "/console/api/orgs")
      return send(res, 200, [
        { id: "org_1", name: "Zeta Org" },
        { id: "org_42", name: "Alpha Org" },
      ])
    if (req.method === "GET" && p === "/console/api/v2/config")
      return send(res, 200, { providers: { "opencode-go": {} } })
    if (req.method === "POST" && p === "/zen/go/v1/chat/completions") {
      const stream = JSON.parse(body || "{}").stream === true
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
