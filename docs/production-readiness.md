# Tickerworld production readiness

This is the release runbook for `tickerworld.io`. A checked source box is not a
substitute for the external-provider checks below. Never deploy credentials from
a developer `.env` file and never paste their values into issues or build logs.

## Pre-deployment external audit (12 July 2026)

- The production deployment that preceded this integration commit returned
  `200` at `https://tickerworld.io/`, while `/btc`, `/eth`, and `/admin` returned
  `404`. The SPA fallback in this commit is intended to clear the market/admin
  route failures; verify it with the post-deploy smoke below. Legal/support
  routes belong to the separate viral-launch pass and are not included here.
- `https://tickerworld.io/api/news` reports `unconfigured` with no items.
- The assigned Colyseus Cloud endpoint is
  `https://us-lax-489a84b6.colyseus.cloud`; `/healthz`, `/readyz`, and
  `/api/capabilities` must all be healthy before multiplayer is marked live.
- Vercel ownership is verified: `game-tickerworld`
  (`prj_dmFp2hMnB7xNMZBrAjkIvI47HObM`) owns `tickerworld.io` and remains connected
  to `eshanhack/tickerworld` on `main`. The three domain-less duplicate projects
  (`tickerworld`, `tickerworld-game`, and `tickerworld-lv1l`) were disconnected
  from Git on 12 July 2026 without deleting projects, domains, or deployments.
  The connected-app OAuth grant still needs reauthentication, but the authenticated
  Vercel CLI and REST API verified project/domain state and retain rollback access.

Re-run `npm run smoke:production` after every external change. The script is
read-only and must pass before a public announcement.

## Provider and credential checklist

### Vercel client

- Keep `game-tickerworld` as the sole Git-connected production project. Its Git
  remote is `eshanhack/tickerworld`, production branch is `main`, and its custom
  domain is `tickerworld.io`. The repository `vercel.json` owns Vite detection,
  the root build, and the `dist` output contract.
- Keep the three disconnected duplicate projects as rollback history until the
  owner deliberately archives them. Do not detach their default domains or delete
  their deployments as part of this release.
- Canonical production pages automatically probe
  `wss://us-lax-489a84b6.colyseus.cloud`; `VITE_MULTIPLAYER_URL` is reserved for an
  explicitly allowlisted local/preview server. Do not mark multiplayer live
  until the canonical server is healthy. Configure `X_BEARER_TOKEN` only as a
  server-side secret; never use a `VITE_` prefix.
- Verify all 24 direct tickerworld routes, `/admin` with its `X-Robots-Tag:
  noindex`, `/api/news`, and the legacy-domain redirect in a preview deployment
  before promotion. Route-specific launch metadata and legal pages belong to the
  separate viral-launch pass and are not represented as complete here.
- Enable privacy-safe Web Analytics/Speed Insights and an error-log destination.
  Scrub query strings, party tokens, wallets, chat, and raw IP data from events.

### Colyseus Cloud and DNS

- Create or select the Colyseus Cloud application in the owner account. Set its
  project root to `server/`, build command to `npm run build`, and PM2 ecosystem
  file to `ecosystem.config.cjs`. The committed configuration deliberately runs
  one `fork` with `wait_ready: true`.
- Store `DATABASE_URL`, `SERVER_HMAC_SECRET`, `IP_HMAC_SECRET`, and the exact
  `PUBLIC_ORIGIN=https://tickerworld.io` in encrypted Cloud settings. Generate the
  two HMAC secrets independently with at least 32 random bytes.
- The ecosystem file sets `NODE_ENV=production` in both the default and named
  PM2 environments so strict startup cannot depend on a provider-specific
  `--env production` flag. Confirm the value in `/readyz` deployment logs.
- Do not commit the generated `.colyseus-cloud.json`; it contains deployment
  credentials and is ignored by Git.
- Deploy the server and validate its assigned Colyseus Cloud URL, then test HTTP
  plus WebSocket upgrades from `tickerworld.io`. A custom domain remains optional.
- Keep the process admission cap at 400 and the PM2 process count at one for the
  launch. Scaling to multiple processes requires shared Presence/Driver and
  distributed rate-limit/moderation state first.

### Neon/Postgres and proxy trust

- Provision a production Neon database in the selected region, use its pooled
  connection string where appropriate, and give the application role only the
  privileges required by migrations and runtime queries. Backups/restore access
  must be tested before launch.
- Production startup now requires the explicit `DATABASE_SSL=verify-full`
  contract. Local SQLite/Postgres development uses `disable`; production never
  infers a weaker policy from URL spelling.
- HTTP and WebSocket admission share one canonical IP resolver. Production
  requires an exact `TRUSTED_PROXY_CIDRS` allowlist, ignores forwarded headers
  from untrusted peers, and rejects universal `0.0.0.0/0` or `::/0` trust.
- Run migrations against a temporary production-like database, then against
  production before the compatible server starts. Confirm `/readyz` returns
  `features.database: true`.

### Solana, administration, and purchases

- The production multiplayer service is intentionally blocked from startup until
  the treasury, mainnet RPC, SOL/USD quote authority, and at least one valid admin
  wallet are configured. `/readyz` also fails unless the database, verified
  Solana genesis, trusted proxy policy, wallet authentication, purchases, and
  administration are all ready.
- Anonymous browser entry lazy-loads wallet support only after the user chooses
  to connect; the anonymous network trace must contain no Solana wallet chunk.
- When admin wallet authentication is intentionally enabled, configure only the
  allowlisted admin wallets and protect `/admin` with `noindex`. Do not enable
  purchase settlement until RPC cluster/genesis, recipient, reference, amount,
  payer, expiry, and idempotency verification have independent security review.

### X news

- Production without a live shared X cache may show the five-minute demo cadence only when every
  item is visibly marked `FICTIONAL DEMO`; simulated prices and players remain QA-only.
- Do not enable the token until ingestion uses a shared cache/stream rather than
  charging one upstream request path per browser/region. Configure X budget
  alerts, reset-header handling, backoff, and a remote `newsIngest` kill switch.
- Smoke tests must prove `/api/news` itself never fabricates provider content; the client-only demo
  remains labelled and cannot be confused with X attribution.

## Release sequence

1. Freeze a reviewed commit. Require the `Verify Tickerworld` GitHub check and run
   `npm run verify:release` locally with Node 22.
2. While external server credentials are unavailable, verify every route and
   the explicit solo fallback. The canonical endpoint probe must fail calmly.
3. For multiplayer activation, back up the database, apply migrations, deploy the
   backward-compatible server, and wait for healthy/readiness responses.
4. Run a two-client/bot smoke against the provider URL; verify movement, chat,
   reconnect, room isolation, capacity fallback, and clean server logs.
5. Point the client at the healthy assigned Cloud endpoint and repeat the smoke.
6. Build one preview against the explicitly configured provider URL, then
   promote that exact artifact only after the multiplayer smoke passes. The
   canonical build itself needs no endpoint variable.
7. Run `npm run smoke:production`; add `SMOKE_EXPECT_MULTIPLAYER_LIVE=1` only
   after activation. In that mode the smoke requires every readiness feature,
   not merely database connectivity. Scan early runtime errors.
8. Keep the prior Vercel deployment and prior compatible server image available.
   Roll back the client alias first for client regressions; for server regressions,
   disable admissions/chat as appropriate and restore the compatible server.

## Go/no-go evidence

- Record commit SHA, Vercel project/deployment IDs, Colyseus application/release
  ID, database migration version, DNS target, smoke output, and rollback owner.
- Legal pages remain a separate public-launch prerequisite and must be reviewed
  by the owner; repository copy is not legal advice.
- At minimum alert on server readiness, join failures, room count/capacity,
  disconnects, event-loop lag, heap, database errors, market/news freshness, Vercel
  function errors, and production smoke failures.
- No multiplayer activation while any provider, credential, DNS, proxy, or
  moderation gate above remains unresolved.
