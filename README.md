# Tickerworld

Tickerworld is a calm multiplayer browser world built around live crypto chart monuments. Each
shareable market route (`/btc`, `/eth`, and the other supported tickers) loads one bounded central
district; the game continues in solo mode whenever the room service is unavailable.

## Development

```sh
npm install
npm run dev
```

The client is always served at `http://127.0.0.1:4173`; the fixed origin keeps
Colyseus CORS, browser automation, and local smoke tests consistent.
Use `?data=sim` for deterministic simulated market data and `?debug=1` for runtime diagnostics.

## Multiplayer development

The browser client, dependency-free protocol, and persistent room server are deliberately separated:

- `shared/` contains the versioned room protocol and common validation rules.
- `server/` contains the Colyseus 0.17 service, SQLite/Postgres persistence, chat safety,
  moderation, wallet authentication, and purchase verification.
- `src/net`, `src/social`, `src/portals`, and `src/economy` are isolated client layers over the
  existing world, player, chart, market, news, and audio systems.

Run the server with Node 22 or newer:

```sh
cd server
npm install
npm run dev
```

Set `VITE_MULTIPLAYER_URL=ws://127.0.0.1:2567` in an ignored `.env.local`, then run the normal
Vite client. Or use `docker compose -f server/docker-compose.yml up --build` for local Postgres.
The `/admin` route is available only to signed Solana wallets listed in the server's
`ADMIN_WALLETS` setting.

Useful repository checks:

```sh
npm run verify:release
```

`npm run verify:release` includes both dependency audits.
`npm run smoke:production` performs read-only public route, admin noindex, news,
trust-page, route-card, canonical metadata, and (when explicitly required)
multiplayer health/readiness/capability checks after deployment. Use
`SMOKE_EXPECT_MULTIPLAYER_LIVE=1` and `SMOKE_EXPECT_NEWS_LIVE=1` for the public
launch gate. Production activation is fail-closed: the client remains playable
in truthful solo mode until the room service is ready. Follow
`docs/production-readiness.md`, `docs/integration-validation.md`, and
`server/README.md` for the evidence and compatible-server-first checklist.

## X news feed

One multiplayer server process owns the official X filtered stream for the shared account catalog,
uses user timelines for startup/gap recovery, and stores only the ten-minute post cache. Each browser
keeps an independent, per-world watchlist (up to eight accounts); adding a handle resolves it on the
server and safely expands the shared stream without exposing the X credential. Put the paid
`X_BEARER_TOKEN` on that process with `ENABLE_NEWS_INGEST=true`, a bounded
`X_DAILY_REQUEST_LIMIT`, the shared production `DATABASE_URL`, and the provider-side spend
controls. Live news deliberately refuses to start from production SQLite because rolling server
overlap must share the catalog, ten-minute cache, provider health, and stream lease.
Vercel receives only `NEWS_CACHE_ORIGIN=https://us-lax-489a84b6.colyseus.cloud`; its `/api/news`
function reads the shared cache and never contacts X or holds an X credential.

When the live X cache is unavailable, the client shows an unmistakably labelled fictional demo
headline and adds another every five minutes so the candle-pin experience remains visible. It never
presents demo copy as live reporting. `?news=sim`, `?data=sim`, and `?debug=1` remain local or
explicit-preview controls (`VITE_ENABLE_QA_MODE=1`); the production fallback does not simulate
prices, players, attribution, or causality.
