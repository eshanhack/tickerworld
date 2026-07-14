# Tickerworld multiplayer server

Independent Colyseus 0.17 service for the ten bounded ticker worlds. The root
Vite application does not install this package.

## Local development

```sh
npm install
npm run build
npm test
npm run dev
```

Development uses SQLite by default. `docker compose up --build` uses Postgres.
Production startup requires `DATABASE_URL` and independent HMAC secrets. The
single-process Colyseus Cloud launch bootstrap is the narrow exception: without
those values it uses local SQLite and per-process HMAC keys while wallet,
purchase, and admin features remain disabled. Browser-local anonymous identity,
username, character, skin, and settings still persist; durable accounts,
moderation history, and payments require Postgres plus stable secrets. Wallet
sign-in is verified locally with Ed25519.
Enabling production X ingestion ends that bootstrap exception: both
`DATABASE_URL` and `X_BEARER_TOKEN` are mandatory so rolling instances share one
catalog, ten-minute post cache, provider-health record, request budget, and lease.
Production requires explicit `DATABASE_SSL=verify-full` and a non-empty
`TRUSTED_PROXY_CIDRS`; there is no insecure production escape hatch. Forwarding
headers remain ignored unless the immediate peer is in that trusted proxy set.
Universal proxy ranges (`0.0.0.0/0` and `::/0`) are rejected at startup.
Set `SOL_USD_PRICE_URL` to a server-side JSON price authority and
`SOLANA_RPC_URL` to activate production purchases. The RPC verifier checks
genesis hash for the configured cluster before it becomes ready, then checks
signature status and the parsed transaction's signer, treasury, lamports,
reference key, cluster, and execution status. Missing or malformed provider
responses return `503`/reject confirmation; client claims never grant ownership.

`GET /api/capabilities` exposes the current positive launch switches without
secrets. `admissions`, `chatSend`, `newsIngest`, `directMarketFallback`,
`publicWalletAuth`, `purchases`, and `adminActions` can be changed through the
allowlisted `PATCH /api/admin/capabilities` recovery path. The endpoint refuses
to enable providers that are not ready. Production defaults keep public wallet
authentication, purchases, news ingestion, and admin actions off.

`MARKET_RELAY_ENABLED=true` creates one Hyperliquid socket set per process,
bootstraps bounded 30-candle windows, publishes active charts at 2.5Hz, and
freezes the last genuine state with an age/stale marker during outages. The
`directMarketFallback` capability tells clients whether active-market-only
browser fallback is allowed. X reads are likewise centralized through one
leased filtered stream with timeline gap recovery and a shared ten-minute
cache. Configure the paid token only here, set `ENABLE_NEWS_INGEST=true`, and
provide the shared production `DATABASE_URL`, then point Vercel's
`NEWS_CACHE_ORIGIN` at this service. No token means
`unconfigured`, never demo headlines. Reset headers, exponential backoff, a
daily request limit, catalog caps, and the runtime kill switch bound spend.

A six-hour retention job removes ordinary auth/IP challenge records after 24
hours, report evidence after 90 days, expired moderation audit records after 12
months, and old provider-budget rows after 14 days. Expired IP-throttle audit
rows are retained without their HMAC IP identifier after 24 hours. Active or
permanent safety actions are never removed by the audit-retention pass. Platform
runtime-log retention remains an infrastructure setting and must be capped at
14 days without request bodies, tokens, chat, wallet addresses, or raw IPs.

## Canonical HTTP contract

- `POST /api/anonymous/session` returns a signed opaque `{ actorId, animal,
  expiresAt, token }`; protocol v2 room joins must supply `anonymousToken`.
- `POST /api/auth/challenge` accepts `{ publicKey, actorId, anonymousToken }`.
  The actor and nonce are included in the wallet-signed message.
- `POST /api/auth/verify` accepts the challenge, signature, actor and anonymous
  proof, returning `{ sessionToken, profile, blocks }`.
- `POST /api/invites` issues a signed token for the authenticated actor's active
  shard. `POST /api/invites/redeem` returns a truthful room hint or
  `party_full`, `party_invalid`, or `party_expired`. Tokens last 30 minutes and
  allow 12 joins. The room message `party-invite-request` provides the same
  flow without separate HTTP authentication; clients redeem, use `joinById`,
  and pass `partyToken` again in the join options.
- `GET /api/capabilities`, `/api/populations`, and `/api/news?scope=BTC` expose
  bounded public launch state. Symbol news is isolated; global posts are shared.
- `GET /api/account` and `PATCH /api/account/profile` read/update the account.
- `GET /api/account/blocks` returns an actor-id array. `PUT` or `DELETE
  /api/account/blocks/:actorId` changes it.
- `POST /api/purchases/quote` accepts `{ sku, username? }`; `POST
  /api/purchases/confirm` returns `pending`, `confirmed`, or `credited`. A
  confirmed profile is returned only after atomic payment verification and
  entitlement grant. Username quotes carry
  an expiring reservation. Confirmation atomically claims a quote before RPC
  verification. If a reserved name cannot be assigned, payment grants a one-time
  username credit; once claimed, usernames are immutable.
- `/api/admin/reports` and `/api/admin/actions` require an allowlisted wallet
  session. Live kicks, mutes, wallet temp-bans and HMAC-IP throttles are enforced;
  report resolution uses `PATCH /api/admin/reports/:reportId`.
- `/api/admin/auth/challenge` and `/api/admin/auth/verify` are allowlist-first,
  so protected operations do not require enabling public wallet authentication.

## Deployment order

Colyseus Cloud must use `server/` as its project root. Its build command is
`npm run build`; `ecosystem.config.cjs` starts exactly one fork and waits for the
readiness message emitted by `src/index.ts` only after runtime initialization,
migrations, provider probes, peer capture, and the listening socket. Do not increase the process count
until shared Presence/Driver and distributed admission/moderation are implemented.

1. Configure Neon/Postgres and independent secrets from `.env.example` in the
   Colyseus Cloud environment settings. Never upload an `.env` file.
2. Resolve every production blocker in `../docs/production-readiness.md`, then
   build and run `npm run migrate` as the pre-deploy migration.
3. Deploy the compatible server first; wait for `/healthz` and `/readyz` to
   return `200`, then run a two-client room smoke test.
4. Verify TLS/WebSocket upgrades at the assigned Colyseus Cloud endpoint from
   the production origin; a custom multiplayer domain can be added later.
5. Deploy the Vercel client only after the server and solo fallback both pass.

The `market` room filters by ticker and sorts by descending client count. Each
room auto-locks at 50, so `joinOrCreate('market', { market, ... })` fills the
most populated non-full shard before creating an overflow shard.
Launch admission is capped at 400 connections and 18 rooms. A hot market may
use at most eight shards, leaving room capacity for all ten worlds.
