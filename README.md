# omp-go

OpenCode, inside Oh My Pi. Two providers, one fingerprint:

- **opencode-go** — your Go subscription: OAuth login, the 31 live Go models,
  the 5h/weekly/monthly limit windows.
- **opencode-free** — OpenCode's free tier, keyless: the 12 zero-cost models,
  authenticated as `Bearer public`, exactly like the harness when you're not
  logged in. No `sk-` key (opencode stopped issuing those), no login, no
  payment details, no nothing.

Traffic is shaped exactly like the opencode harness on every request path.
Apparently we live in a world where that matters.

## Install

```
omp plugin install github:HenryGetz/omp-go
```

Restart. Free models work immediately (`/model opencode-free/mimo-v2.6-flash-free`).
For the Go subscription: `/login` → "OpenCode Console (Go subscription)". A
browser opens, a code appears, tokens rotate themselves. Revolutionary.

## What it does

- **Login.** The real device flow, byte-for-byte the one `opencode auth login`
  uses. opencode-cli client id and all. Sue me.
- **Free tier.** The same models the harness enables without a key: zero-cost
  catalog entries only (the harness's own rule — `cost.input > 0` models are
  disabled when keyless), deprecated entries hidden. The gateway enforces it:
  requests must carry the harness's session-id encoding and look like a real
  agent conversation, and this plugin speaks both natively.
- **Limits.** `omp usage` shows the 5h / weekly / monthly windows, so you can
  watch the monthly one climb like everyone else. Log in with a second account
  (`/login` again — or `omp login opencode`) and omp pools and load-balances
  across both, ranking by remaining quota. Two accounts, double the cope.
- **Fingerprint.** Same `User-Agent`, same header order and casing, same
  bodies, same session/trace id scheme. `src/ordered-fetch.ts` writes the
  request head byte-for-byte as the harness does (`node:https`, `setHost:
  false`), because bun's fetch sorts headers and the free-tier gateway checks.
  Golden-trace parity against the real harness enforces the rest.

## Proof

- `bun test/parity.ts` diffs this plugin's requests against a 15-request trace
  recorded from the actual opencode binary (login, Go chat, free chat). Wire
  identical, modulo random ids.
- `bun test/transport.ts` pins the wire contract the free-tier gateway
  validates: header order/casing and the harness's descending session-id
  encoding.
- `bun test/gateway-free.ts` runs real `omp`, no login, `opencode-free/*`
  against the real gateway — the user-visible scenario end to end.

## Fine print

- opencode-zen is a different product (opencode's OpenRouter-style paid
  marketplace — API key + PAYG) and is built into omp already. This plugin
  deliberately does not touch it.
- Model-discovery GETs (`/models`) still carry omp's own User-Agent — omp's
  catalog fetcher owns those. Inference, login, config, and usage are
  fingerprinted.
- Quota and region rules are **per workspace**. If a model says it "requires
  Global regions", that workspace's Privacy setting is not Global — fix it in
  the Console or `/logout` that account. Pooling routes around it when a
  healthy sibling exists.
- Usage route has no golden trace; the harness never calls it. Sued for honesty.
- Limit windows are account-wide. Share with yourself responsibly.
- `ln -s ~/.bun/install/global/node_modules node_modules` if you want
  `typecheck`. omp resolves `@oh-my-pi` on its own.
