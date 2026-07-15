# Tickerworld X launch runbook

Positioning: **Walk inside live markets with friends.**

Public launch stays closed until every go/no-go item below has real evidence. A successful build is
not evidence that multiplayer, news, DNS, moderation, or a human soft launch is ready.

## Production topology

- Canonical client: `https://tickerworld.io`
- Multiplayer/API: `https://us-lax-489a84b6.colyseus.cloud`
- Client hosting: the single `game-tickerworld` Vercel project
- Multiplayer: one capped Colyseus process, maximum 400 connected players and 50 per shard
- Market data: one process-wide Hyperliquid relay, including exact XYZ builder-deployed perpetual
  instruments; direct browsers load only the active market when the relay is unavailable and the
  remote fallback switch permits it
- News: one leased server-side X filtered stream, per-world account catalog, and ten-minute cache;
  browsers keep private watchlists and Vercel reads only `NEWS_CACHE_ORIGIN`; every rolling server
  instance uses the same production `DATABASE_URL`
- Public wallet authentication and purchases: off

## Launch switches

All are positive flags: `false` disables the feature.

| Environment variable | Launch value | Emergency use |
| --- | --- | --- |
| `ENABLE_ADMISSIONS` | `true` after soft-launch checks | Stop new shared-room joins; clients use solo mode |
| `ENABLE_CHAT_SEND` | `true` after moderation checks | Make rooms read-only without stopping movement |
| `ENABLE_NEWS_INGEST` | `true` only with paid token and budget | Stop every upstream X request |
| `ENABLE_DIRECT_MARKET_FALLBACK` | `true` | Stop active-market-only browser fallback fan-out |
| `ENABLE_PUBLIC_WALLET_AUTH` | `false` | Keep public wallet code unreachable |
| `ENABLE_PURCHASES` | `false` | Keep quotes and grants unavailable |
| `ENABLE_ADMIN_ACTIONS` | `false` until admin smoke passes | Stop remote moderation mutations |

`MARKET_RELAY_ENABLED=true`, `MAX_PROCESS_CONNECTIONS=400`, `MAX_ROOMS=18`, and
`MAX_MARKET_SHARDS=8` are the single-process launch ceiling. Do not start a second process until
Redis Presence/Driver and distributed safety/admission state are implemented.

## Compatible deployment order

1. Record the current Colyseus image/tag and Vercel deployment ID for rollback.
2. Apply database migrations once and verify their checksums.
3. Deploy the backward-compatible server image.
4. Verify `/healthz`, `/readyz`, `/api/capabilities`, market age, news cache mode, and structured logs.
5. Run two real bots through join, movement, emote, chat, block, invite, and portal transfer.
6. Deploy the Vercel client from `main`.
7. Verify all 24 direct tickerworld shells, `/admin` noindex, five trust pages, news truthfulness, and
   solo fallback. Public-launch approval requires 24 unique 1200×630 route cards captured from the
   finished worlds. Integration builds may use the canonical non-live brand card for an unfinished
   world's metadata, but that fallback remains a launch blocker rather than invented gameplay art.
8. Run the private soft launch. Start with 50 invited people, then increase only while telemetry and
   resource limits remain healthy.
9. Hold public launch for at least 24 stable hours.

## Private soft-launch evidence

- Browser matrix: iOS Safari, Android Chrome, X iOS in-app browser, X Android in-app browser,
  desktop Chrome/Edge, Firefox, and Safari.
- Both orientations remain playable; browser chrome and safe areas do not cover controls.
- Two party-link browsers land in the same shard, see the arrival bloom, move, emote, chat, block,
  and portal without the veil dropping early.
- At capacity or on a blackholed room service, a visitor reaches truthful solo mode within three
  seconds.
- No normal production URL or query displays simulated prices or players, and demo news is always
  visibly marked `FICTIONAL DEMO` rather than presented as live reporting.
- Anonymous network traces contain no Solana/wallet chunk.
- `privacy@tickerworld.io` accepts and delivers a private test message before the policy is publicised.

## Load gates

Use a production-shaped staging server, not a developer laptop result, for go/no-go:

- 500 clients for 30 minutes: CPU under 70%, p99 event-loop lag under 50 ms, p95 state age under
  250 ms, and plateauing heap.
- 1,000 simultaneous connection attempts: bounded rooms, clean rejections or solo fallback.
- 500 clients: one Hyperliquid upstream connection set for the process.
- 10,000 browser news polls: a fixed, bounded number of X requests.

## Launch creative

The game repository contains route-specific static social-card targets and the final 1200×675
in-game postcard renderer. Capture cards only from the finished build; do not put live prices in
cacheable OG art.

Launch video shot list (12–15 seconds, captions always on):

1. 0–3s — animal movement, Tickerworld title, live BTC world.
2. 3–6s — a candle and price pulse updating.
3. 6–10s — several real players using emotes.
4. 10–13s — a portal transition.
5. 13–15s — a genuine/debug-staged visual firework and `tickerworld.io/btc`.

`docs/launch-media/tickerworld-x-launch-draft.mp4` is the 14.1-second captioned timing and layout
draft generated from the finished game. It is internal review material, not public-launch footage:
replace its staged test avatars with the planned 10–20 consenting friends during the soft launch,
then review the final export before posting.

Recommended launch post:

> I turned live market charts into a tiny multiplayer world. Pick an animal, walk inside BTC, and
> bring a friend → tickerworld.io/btc

Invite 10–20 real friends into BTC for the recording and initial public session. Do not use bots,
invent player counts, or label staged market data as live.

## Rollback

1. Disable `ENABLE_ADMISSIONS`; existing clients continue locally.
2. Roll back the client by promoting the recorded previous Vercel deployment.
3. Roll back to the recorded compatible server image if server errors persist.
4. Do not reverse a database migration until its downgrade has been tested against both images.
5. Re-run the production smoke and confirm rollback completes within ten minutes.

## Public go/no-go

- [ ] DNS/TLS for both canonical domains is healthy.
- [ ] Real multiplayer and news credentials are configured in their correct service only.
- [ ] Privacy, terms, community rules, support, and status pages have owner review.
- [ ] Privacy/support inbox delivery is verified.
- [ ] Two-browser party and portal flow passes on desktop and mobile.
- [ ] Load and burst gates pass on production-shaped infrastructure.
- [ ] 24-hour soft-launch window is stable.
- [ ] Route cards and final video use the finished build and real people.
- [ ] Previous server and Vercel artifacts are recorded and restorable.

## Read-only production smoke

Run the default gate against the canonical client while external services are intentionally off:

```sh
npm run smoke:production
```

For the public multiplayer/news launch, require both live control-plane paths explicitly:

```sh
SMOKE_EXPECT_MULTIPLAYER_LIVE=1 SMOKE_EXPECT_NEWS_LIVE=1 npm run smoke:production
```

On PowerShell, set the two environment variables with `$env:...='1'` before running the command.
`TICKERWORLD_CLIENT_ORIGIN` and `TICKERWORLD_SERVER_ORIGIN` may point the same read-only gate at a
preview/staging pair. They are smoke-runner inputs, not Vercel or client build variables.
