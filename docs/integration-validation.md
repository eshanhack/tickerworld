# Multiplayer integration validation

Validated locally on 12 July 2026 with Node 22-compatible tooling. Production
provider activation remains intentionally blocked by the checklist in
`production-readiness.md`.

This evidence records the then-supported eight crypto routes. The current
ten-world topology adds WTI and the TEST lab, so those two routes require fresh
release-gate and browser evidence rather than being implied by this historical run.

## Automated evidence

- `npm run verify:release`: 221 client/root tests and 61 server-package tests
  passed once each (282 unique tests); client, shared protocol, and server
  production builds passed. The
  release gate also audits both dependency trees at high severity.
- The server integration suite placed 50 clients in one AVAX shard and 25 in a
  second shard, while preserving unique deterministic spawn positions.
- The accelerated 30-minute logical world soak kept chunks and renderer-owned
  resources bounded and disposed them cleanly.
- Root and server production dependency audits reported zero vulnerabilities.
- The production bundle keeps `solanaWalletClient` in a separate dynamic chunk.
- Vercel's local platform router returned HTML for `/`, all eight then-supported market
  routes, and `/admin` (with `X-Robots-Tag: noindex, nofollow`), while
  `/api/news` remained JSON and truthfully reported `unconfigured`.

## Real browser evidence

- Two isolated WebGL browser sessions joined the same BTC shard at different
  safe spawn slots. The remote rabbit/penguin rendered with its pastel body and
  cream parts (not black).
- A held movement input in one browser moved the interpolated remote avatar in
  the other. Room chat arrived with the correct animal identity and blocking
  immediately removed the avatar, chat row, bubble, and picking surface.
- History navigation switched BTC → ETH → BTC, awaited the destination room,
  and released the loading/input lock. A deterministic solo QA session was
  placed inside the physical ETH portal for the full three-second dwell and
  arrived outside ETH's return portal facing inward.
- Restarting the local room process with stable signing secrets showed solo
  fallback during the outage, exhausted the short stale-room reconnect path,
  and automatically joined a fresh healthy shard.
- Portrait displayed the rotate-device veil above extension controls. Landscape
  rendered the game and safe-area HUD without console/page errors.
- A production Vite preview returned HTML for all eight then-supported direct market slugs and
  `/admin`; the admin application rendered its fail-closed unconfigured state.
- Anonymous preview entry requested neither the Solana wallet chunk nor a room
  endpoint, proving the solo production bundle does not eagerly load wallet code.
- A final uninterrupted WebGL soak ran for 30 minutes 50 seconds with 186
  ten-second samples on the finalized shared-guard build. The room stayed online
  in every sample, live presentation ticks advanced from 86 to 2,513, chunks
  stayed at 25, textures stayed at 2, and geometries ranged from 140–155 before
  ending at 141. JavaScript heap cycled from 40.8 MB through normal GC and ended
  lower at 38.3 MB; real smoke-bot joins appeared and disposed cleanly.
- The matching room process ran for 43.6 minutes, including movement/chat smoke
  bots, and ended at 260 handles, 8 threads, 20.1 MB working set, 56.5 MB private
  memory, and zero stderr bytes.

## External release gates

The client can ship in truthful solo mode. Do not set `VITE_MULTIPLAYER_URL` or
mark multiplayer live until Colyseus Cloud, Neon, DNS, trusted proxy CIDRs,
stable HMAC secrets, Solana mainnet RPC/genesis, treasury, SOL/USD authority,
admin wallets, and moderation ownership have all passed `/readyz` and the
server-first smoke sequence.

Live X news separately requires `X_BEARER_TOKEN`; without it, the browser shows
the clearly marked five-minute fictional news demo. Price and player simulation remain QA-only.
