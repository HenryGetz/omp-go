# omp-go

OpenCode Go subscription for [Oh My Pi](https://omp.sh) — native OAuth login, all 36
Go models, and usage limits, with network traffic to opencode.ai wire-identical to
the opencode harness.

## Install

```
omp plugin install github:HenryGetz/omp-go
```

Then restart omp (or reload extensions). Confirm with `omp plugin list`.

## Use

1. **Log in** — run `/login` in omp and pick **OpenCode Console (Go subscription)**,
   or from the shell: `omp auth-broker login opencode`. You get the same device
   flow as `opencode auth login opencode`: a browser link plus `Enter code: …`,
   tokens rotated and persisted by omp's auth storage (single-flight refresh).
2. **Use the models** — all 36 `opencode-go` models are registered
   (`mimo-v2.6-pro`, `qwen3.7-max`, `grok-4.7`, …), refreshed live from
   models.opencode.ai with the embedded catalog as offline fallback:
   `omp models` / `/model opencode-go/<model>`.
3. **Check limits** — `omp usage` shows the Go windows: rolling 5h, weekly, and
   monthly (subscription-anniversary anchored), with reset times and
   ok/warning/exhausted status. Same numbers as opencode.ai/console.

## Wire fidelity

Every request this plugin sends is shaped like the harness's own traffic:
`user-agent: opencode/<channel>/<version>/<name>`, the `x-opencode-*` session
headers, `b3`/`traceparent` trace propagation, JSON device-flow bodies
(`client_id: opencode-cli`), and the OpenAI-compatible chat body
(`stream`, `stream_options.include_usage`, `store: false`). The OAuth access
token is used directly as the gateway bearer key — no exchange step exists.

`test/parity.ts` proves it: it drives this plugin against `capture/stub-console.mjs`
and diffs the resulting trace against `capture/golden-requests.ndjson`, recorded
from the real opencode v2.0.26 harness against the same stub. 9/9 requests match
(modulo random ids); limits parsing, the 36-model catalog mapping, and the
`registerProvider` wiring are asserted in the same run.

```
bun test/parity.ts    # needs @oh-my-pi packages resolvable, see below
```

## Notes and caveats

- **Usage route has no golden trace**: the harness never calls `GET /zen/go/v1/usage`
  (limits live on the Console website and in reactive error dialogs there). Its
  header set follows the gateway's `x-opencode-session` requirement plus harness
  conventions; login and inference remain golden-proven.
- **Trace grouping**: the harness nests refresh+config under one trace id; this
  plugin issues them as separate traces. Random ids per request either way.
- **Shared windows**: the three limit windows are account-wide — any other client
  of the same subscription draws from them too.
- **Inference headers**: `authorization` is deliberately left to omp's auth
  pipeline (`authHeader: true`) so refresh/rotation and auth-retry keep working;
  the fingerprint wrapper injects everything else per request.

## Development

`import type` from `@oh-my-pi/*` needs the packages resolvable for `tsc`; at
runtime inside omp they resolve to the host's own modules (omp's extension
resolver maps `@oh-my-pi/*`), so the plugin ships zero dependencies.

```
ln -s ~/.bun/install/global/node_modules node_modules
bun run typecheck
bun test/parity.ts
```

Layout: `src/wire.ts` (the pinned fingerprint), `src/opencode-provider.ts`
(device flow + refresh), `src/usage.ts` (limits), `src/models.ts` +
`src/models-catalog.json` (the 36 models), `src/register.ts`
(`pi.registerProvider("opencode-go", …)` assembly), `capture/` (stub Console +
golden harness trace).
