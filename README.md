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
  region policy) now rotate to a healthy sibling mid-turn AND demote the
  account in health checks for 30 minutes — a dead account cannot keep winning
  the ranking just because it never served anything. Verdicts expire, so a
  topped-up account heals itself.
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
- `bun test/transport.ts` pins the wire contract the free-tier gateway
  validates: header order/casing and the harness's descending session-id
  encoding.
- `bun test/proxy.ts` pins the egress pool: proxy parsing, round-robin
  failover, and the SOCKS5 tunnel handshake.
- `bun test/gateway-sweep.ts` chats with every free model on the real gateway,
  on its correct protocol — the anti-"model does not support this protocol"
  sweep.
- `bun test/gateway-free.ts` runs real `omp`, no login, `opencode-free/*`
  against the real gateway — the user-visible scenario end to end. With
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
