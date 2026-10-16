# omp-go

OpenCode, inside Oh My Pi. Two providers, one fingerprint, and — because the
free tier meters per endpoint — potentially every public IP you own.

- **opencode-go** — your Go subscription: OAuth login, the 31 live Go models,
  the 5h/weekly/monthly limit windows.
- **opencode-free** — OpenCode's free tier, keyless: the 12 zero-cost models,
  authenticated as `Bearer public`, exactly like the harness when you're not
  logged in. No `sk-` key (opencode stopped issuing those), no login, no
  payment details, no nothing.
- **/egress** — route the free traffic through your own machines over SSH
  tunnels the plugin opens and babysits for you. Per-endpoint metering means
  every box you own is its own free budget; collect the whole set.
- **/freeusage** — what this machine has spent on the free tier, per model,
  over rolling 1h/5h/24h windows, plus the cooldown a tripped window announced.
  Local accounting only: the tier publishes nothing to query.

Traffic is shaped exactly like the opencode harness on every request path.
Apparently we live in a world where that matters.

## Install

```
omp plugin install github:HenryGetz/omp-go
```

Restart. Free models work immediately (`/model opencode-free/mimo-v2.6-flash-free`).
For the Go subscription: `/login` → "OpenCode Console (Go subscription)". A
browser opens, a code appears, tokens rotate themselves. Revolutionary.

## Your machines, your egresses

The free tier hands out quota per endpoint, which is very fair of them and also
very exploitable by anyone who owns more than one computer. If that's you:

```
/egress
```

…and the plugin does the onboarding:

1. No hosts yet? It **asks for an SSH target right there in the TUI**. Paste
   `student@100.125.193.75`, hit enter, done.
2. It **checks the host immediately** — opens the `ssh -D` tunnel (key auth,
   BatchMode; it's your machine, you already have the key), and reports the
   egress IP it will use: `added student@100.125.193.75 — egress 198.174.0.110`.
3. If the new box exits through the same IP as the one you're sitting at, it
   says so instead of pretending you gained a budget. If SSH fails, you get
   the actual error and the fix (`ssh-copy-id student@…`), not a shrug.

Then it just works. Free-tier requests round-robin across every live tunnel
plus your direct connection — one request per hop, so two boxes means each
carries about half. If a hop fails at connect time (tunnel wedged, machine
asleep) the request immediately tries the next one and only falls back to your
direct connection when every tunnel is down (`OMP_GO_PROXY_STRICT=1` makes
that a hard error instead). A dead tunnel is dropped and respawned on the next
request — it revives itself; `/egress off <host>` pauses one without deleting it,
`/egress test` re-checks every host and prints egress IPs, `/egress remove`
buries it. Tab-completion offers your `~/.ssh/config` hosts, because typing
hostnames is not a skill anyone should need to exercise here.

Prefer DIY? `OMP_GO_PROXIES="socks5://127.0.0.1:1081,http://10.0.0.2:8080"`
pins an explicit pool (SOCKS5 or HTTP CONNECT — bare `ssh -D` tunnels work
fine). Hosts live in `~/.omp/agent/omp-go-egress.json`.

The devs are aware of and fine with multi-machine use. They said nice things.
Keep the written OK somewhere safe.

## Traffic & limits

The free tier has no usage API. Not "not documented" — not there: responses
carry no quota headers (just routing info like `x-opencode-endpoint-id`), and
`/usage`, `/limits`, `/quota` all 404. There is no account to query because
there is no account. Metering is per endpoint and only announces itself when
you trip it (a `FreeTierError` or a throttle).

So the plugin keeps its own books:

```
/egress traffic
  148 requests, 2.3 MB sent, last 2026-10-14T00:20:45.123Z
  by hop:
    socks5://127.0.0.1:34999: 71
    socks5://127.0.0.1:39591: 68
    direct: 9
  by model:
    mimo-v2.6-flash-free: 121
    longcat-2.5-preview-free: 27
```

Every request is recorded with the hop that carried it
(`~/.omp/agent/omp-go-traffic.ndjson` — set `OMP_GO_WIRE_LOG` to redirect).
That is also how the tests prove traffic went through your tunnels and not
around them. For the Go subscription, `omp usage` still shows the real 5h /
weekly / monthly windows.

`/freeusage` (`/fusage`, `/free-usage`) slices the same ledger per free model:

```
/freeusage
  opencode free tier — LOCAL accounting: the free tier is keyless and publishes no
  server-side usage (no quota headers, no usage endpoint). Ledger: ~/.omp/agent/omp-go-traffic.ndjson
  free-tier window totals: 1h 26 req · 5h 26 req · 24h 183 req
  model                                       1h            5h           24h     last  st  state
  deepseek-v4.1-flash-free          26   15.9 MB  26   15.9 MB  26   15.9 MB 03:17:43 200  ready
  mimo-v2.6-flash-free               0       0 B   0       0 B  38    1.0 MB 17:16:30 429  ready
  step-5-preview-free                0       0 B   0       0 B 114  156.2 MB 17:13:10 429  limited (until 20:00, ~6h47m left)
  big-pickle                         0       0 B   0       0 B   0       0 B 10-14 18:32   -  idle
```

The rows are the free roster **plus** every model the ledger has seen on the
free lane, so a free model the embedded catalog snapshot doesn't know yet still
shows up. The windows are per MODEL, not per account — tripping one model leaves
its siblings serving — and the moment one trips, the `429`'s own `retry-after`
is recorded and the report says how long is left. `/freeusage mimo` narrows the
rows to a substring of the model id.

## Account routing (multi-account, cache-first)

Prompt caching is per account: every request that lands where the prompt-cache
prefix is cold pays full input price, so a pool that hops accounts per chat can
cost several times more than one that consolidates. With two or more
`opencode-go` logins the plugin routes for cache:

| situation | a **new** session starts on | **live** sessions |
| --- | --- | --- |
| leader has headroom | the warm leader (whichever account served last) | stay pinned |
| leader ≥ 90% used | the sibling (spill) | the leader drains — its cache is warm there |
| every account ≥ 90% used | the warm leader ("at that point it doesn't matter") | stay pinned |
| an account's window hits 100% | never that account | pins re-pin to the sibling |
| the pinned account fails | healthy sibling (rotation) | rotate with it |

The pin is made through omp's own auth API as an *explicit* pin: usage
ranking and account reserve never evict it (that is what makes "drain" real),
while hard failures and auth retries still route around it. Warmth and usage
state persist in `~/.omp/agent/omp-go-routing.json` so every omp process
agrees on the leader. The spill threshold reads the worst reported window
(5h, weekly, or monthly) and is tunable via `OMP_GO_SPILL_PCT` (default 90).

## Reasoning

Every model's reasoning surface comes from the catalog's own
`reasoning_options`, and the wire shape is the harness's (`variant.ts`):

| catalog surface | wire |
| --- | --- |
| `effort` (chat models) | `reasoning_effort: <level>` |
| `effort` (Responses models) | `reasoning: {effort, summary:"auto"}` + `include: ["reasoning.encrypted_content"]` |
| `toggle` / `budget_tokens` only | nothing — the harness sends nothing either |

The default effort is each model's **highest** rung (`max` for
deepseek-v4.1-flash, `xhigh` for gpt-5.4-pro, …). The harness's own default
variant is its lightest (`values[0]`), which is why Console requests read
`effort · low` — this is the one deliberate divergence from harness-default
traffic: same dialect, quality-maxed default. Any explicit reasoning level in
omp overrides it.

Mechanically this rides the plugin's managed `models.yml` block: every
effort-capable model gets a `modelOverrides` entry pinning its ladder,
`defaultLevel: max`, and `supportsReasoningEffort: true`, out-ranking the
provider-level `supportsReasoningEffort: false` that keeps every *other*
model fieldless. Per-model clamping means the level a model receives is
always one of its own rungs.

## What it does

- **Login.** The real device flow, byte-for-byte the one `opencode auth login`
  uses. opencode-cli client id and all. Sue me.
- **Free tier.** The same models the harness enables without a key: zero-cost
  catalog entries only (the harness's own rule — `cost.input > 0` models are
  disabled when keyless), deprecated entries hidden. The gateway enforces it:
  requests must carry the harness's session-id encoding and look like a real
  agent conversation, and this plugin speaks both natively.
- **Account switching that learns.** The pool ranks accounts by remaining
  quota, which makes a broken account at 0% look like the best pick. Inference
  verdicts (`402 Insufficient account funds`, `403 Workspace access denied`,
  region policy) rotate to a healthy sibling mid-turn AND demote the account
  in health checks — a dead account cannot keep winning the ranking just
  because it never served anything. Every attempt stamps its OWN
  `x-opencode-org-id`: the gateway answers 402/403 the moment a bearer carries
  a foreign or missing org, and that pairing failure is reported as
  *membership/pairing* (403), not as capacity — only the 402 is an exhausted
  window. A verdict persists at least the reset horizon the gateway stated
  (else a conservative 30-minute TTL), verdict'd and 100%-used accounts never
  win selection, a usage poll that reports a window at 100% re-pins every
  session off that account, and verdicts still expire so a topped-up account
  heals itself.
- **Limits.** `omp usage` shows the 5h / weekly / monthly windows, so you can
  watch the monthly one climb like everyone else. Log in with a second account
  (`/login` again — or `omp login opencode-free`) and omp pools and
  load-balances across both, ranking by remaining quota. Two accounts, double
  the cope. Combine with three egresses and you're basically a small
  datacenter of one.
- **Fingerprint.** Same `User-Agent`, same header order and casing, same
  bodies, same session/trace id scheme. `src/ordered-fetch.ts` writes the
  request head byte-for-byte as the harness does (`node:https`, `setHost:
  false`), because bun's fetch sorts headers and the free-tier gateway checks.
  Golden-trace parity against the real harness enforces the rest.
- **Tool surface.** The free gateway also fingerprints the request's `tools`
  array (a keyless `403 FreeTierError` otherwise). On `opencode-free` the
  plugin sends the harness's own 12 tool definitions — captured from the real
  binary in `capture/harness-tools.json` and installed verbatim by
  `src/tool-mirror.ts` — and backs each name with a wrapper that carries the
  harness schema and translates into omp's (`shell` runs through omp's shell
  executor, `read`/`edit`/`glob`/`grep`/`write` delegate to the built-ins,
  `webfetch`/`websearch`/`subagent`/`execute` have real implementations). The
  `opencode-go` lane is untouched: its wrappers stay inactive and it keeps the
  built-in schemas. Two guards keep the swap honest: the harness names reach
  the wire only when activation confirmed them (otherwise the host's own
  payload ships — no more turn-1 `Tool write not found`), and every ACTIVE tool
  outside the 12 (`todo`, `task`, …) stays usable on both protocols — on
  chat/completions their schemas ride one compact block appended to the last
  user message (the gateway keeps argument bytes for any callable name there);
  on the Responses lane the serving stack DROPS argument bytes for names
  outside `tools[]` (wire-verified: zero argument deltas, `done: "{}"`), so
  those tools extend `tools[]` itself after the golden 12, and a response SSE
  normalizer (`src/sse-normalize.ts`) strips `default.`-qualified names and
  turns any residual zero-argument call into a loud, non-executable transport
  error instead of a silent `{}` retry loop.

Some catalog entries drift dead upstream without warning (right now:
`exo-free` answers `410 ModelDeprecated`, `ling-3.0-flash-fin-free` is
unavailable). The harness's picker shows them broken; **this plugin hides
them**, so every model `opencode-free` offers actually works.
`bun test/gateway-sweep.ts` chats with every free model on its correct
protocol (yes, some are Responses-API — the gateway will say "model does not
support this protocol" if you route them wrong), retries rate limits, and
shouts "wake" when a hidden model recovers upstream.

## Proof

- `bun test/parity.ts` diffs this plugin's requests against a 15-request trace
  recorded from the actual opencode binary (login, Go chat, free chat). Wire
  identical, modulo random ids.
- `bun test/reasoning.ts` pins the reasoning mapping: per-model effort
  ladders, the max-quality default, and the harness's wire shapes.
- `bun test/routing.ts` pins the cache-first account policy (consolidate,
  spill at threshold, drain by pin).
- `bun test/transport.ts` pins the wire contract the free-tier gateway
  validates: header order/casing and the harness's descending session-id
  encoding.
- `bun test/tool-mirror.ts` pins the harness tool surface: the asset is
  byte-identical to the golden capture, the request rewrite installs exactly
  those 12 definitions, and every wrapper carries the harness schema and
  translates into omp's.
- `bun test/proxy.ts` pins the egress pool: proxy parsing, round-robin
  failover, and the SOCKS5 tunnel handshake.
- `bun test/free-usage.ts` pins the `/freeusage` accounting: window boundaries,
  the cooldown a 429 announces, the free-lane predicate that keeps Go-lane and
  paid rows out, tolerant ledger reads, and the model filter.
- `bun test/gateway-sweep.ts` chats with every free model on the real gateway,
  on its correct protocol — the anti-"model does not support this protocol"
  sweep.
- `bun test/gateway-free.ts` runs real `omp`, no login, `opencode-free/*`
  against the real gateway — the user-visible scenario end to end, including a
  real `shell` tool call executed and returned in the model's reply. With
  `EGRESS_CONFIG=1` it also proves the plugin opens its own tunnels from the
  host list.
- `bun test/e2e/user-flow.mjs` does the whole thing like a user:
  `omp plugin install github:HenryGetz/omp-go` into a fresh profile, real `omp`
  in a terminal (driven by microsoft/tui-test) from a plain directory, chat on
  `opencode-free/mimo-v2.6-flash-free`, assert the model's actual answer.
- `bun test/e2e/egress-onboarding.mjs` drives the `/egress` onboarding itself
  under microsoft/tui-test: the dialog, the add, the egress-IP report.
- `node test/e2e/egress-pool.mjs` proves the pool semantics in one session:
  requests spread across both tunnels, one tunnel is killed mid-run, and the
  next chat routes around it — still on tunnels, never a direct leak.
- `node test/e2e/egress-free.mjs` is the full integration in a real terminal
  (microsoft/tui-test): the plugin opens the SSH tunnel from the host list,
  a free-tier chat completes in the TUI, and a wire log proves the chat was
  carried by the tunnel with zero requests leaked to a direct connection.

## Fine print

- opencode-zen is a different product (opencode's OpenRouter-style paid
  marketplace — API key + PAYG) and is built into omp already. This plugin
  deliberately does not touch it.
- Model-discovery GETs (`/models`) still carry omp's own User-Agent — omp's
  catalog fetcher owns those. Inference, login, config, and usage are
  fingerprinted.
- Egress tunnels are plain `ssh -D` to hosts you control, with key auth. If
  one of your boxes is behind a captive portal, `/egress test` will tell you
  and rotation will simply skip it. This is load spreading across your own
  machines, not an anonymizer — everyone's still you.
- Quota and region rules are **per workspace**. If a model says it "requires
  Global regions", that workspace's Privacy setting is not Global — fix it in
  the Console or `/logout` that account. Pooling routes around it when a
  healthy sibling exists.
- Usage route has no golden trace; the harness never calls it. Sued for honesty.
- Limit windows are account-wide. Share with yourself responsibly.
- `ln -s ~/.bun/install/global/node_modules node_modules` if you want
  `typecheck`. omp resolves `@oh-my-pi` on its own.
