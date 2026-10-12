# omp-go

Your OpenCode Go subscription, inside Oh My Pi. OAuth login, all 36 models, the
limit windows — with traffic that looks exactly like the opencode harness,
because apparently we live in a world where that matters.

## Install

```
omp plugin install github:HenryGetz/omp-go
```

Restart. `/login` → "OpenCode Console (Go subscription)". A browser opens, a
code appears, tokens rotate themselves. Revolutionary.

## What it does

- **Login.** The real device flow, byte-for-byte the one `opencode auth login`
  uses. opencode-cli client id and all. Sue me.
- **Models.** All 36 of them. `mimo-v2.6-pro`, `grok-4.7`, whatever a "fledge"
  is. Live from models.dev, cached when the wifi gives up.
- **Limits.** `omp usage` shows the 5h / weekly / monthly windows, so you can
  watch the monthly one climb like everyone else. Log in with a second account
  (`/login` again — or `omp login opencode`) and omp pools and load-balances
  across both, ranking by remaining quota. Two accounts, double the cope.
- **Fingerprint.** Same `User-Agent`, same headers, same bodies. The server
  cannot tell. That is the entire point of this repo.

## Proof

`bun test/parity.ts` diffs this plugin's requests against a trace recorded from
the actual opencode binary. 9/9 identical, modulo random ids. The README you
don't have to trust is in `src/`.

## Fine print

- Usage route has no golden trace; the harness never calls it. Sued for honesty.
- Limit windows are account-wide. Share with yourself responsibly.
- `ln -s ~/.bun/install/global/node_modules node_modules` if you want
  `typecheck`. omp resolves `@oh-my-pi` on its own.
