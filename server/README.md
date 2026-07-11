# Tickerworld multiplayer server

Independent Colyseus 0.17 service for the eight bounded market worlds. The root
Vite application does not install this package.

## Local development

```sh
npm install
npm run build
npm test
npm run dev
```

Development uses SQLite by default. `docker compose up --build` uses Postgres.
Production startup fails unless `DATABASE_URL`, independent HMAC secrets, and a
treasury address are present. Wallet sign-in is verified locally with Ed25519.
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

## Canonical HTTP contract

- `POST /api/anonymous/session` returns a signed opaque `{ actorId, animal,
  expiresAt, token }`; protocol v2 room joins must supply `anonymousToken`.
- `POST /api/auth/challenge` accepts `{ publicKey, actorId, anonymousToken }`.
  The actor and nonce are included in the wallet-signed message.
- `POST /api/auth/verify` accepts the challenge, signature, actor and anonymous
  proof, returning `{ sessionToken, profile, blocks }`.
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
4. Point `multiplayer.tickerworld.io` at that persistent WebSocket service and
   verify TLS/WebSocket upgrades from the production origin.
5. Deploy the Vercel client only after the server and solo fallback both pass.

The `market` room filters by ticker and sorts by descending client count. Each
room auto-locks at 50, so `joinOrCreate('market', { market, ... })` fills the
most populated non-full shard before creating an overflow shard.
Launch admission is capped at 400 connections and 16 rooms. A hot market may
use at most eight shards, leaving room capacity for all eight destinations.
