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
and (when explicitly required) multiplayer health/readiness checks after
deployment. Production activation is fail-closed: the client remains playable
in truthful solo mode until the room service is ready. Follow
`docs/production-readiness.md`, `docs/integration-validation.md`, and
`server/README.md` for the evidence and compatible-server-first checklist.

## X news feed

Tickerworld polls its server-side `/api/news` function for recent posts from
[@DeItaone](https://x.com/DeItaone). Create a paid X developer app, add its bearer token as the
server-only `X_BEARER_TOKEN` environment variable in Vercel (Production, Preview, and Development
as needed), and redeploy. Never expose this value through a `VITE_`-prefixed variable.
Set a spending limit and balance alert in the X Developer Console before enabling production reads.

Production must hide live news or report it unavailable when the token is absent;
it must never substitute fictional headlines. Use `?news=sim` only for explicit
local/QA simulation. For local testing of the live function, copy `.env.example`
to an ignored `.env.local`, add the token, and run `vercel dev`.
