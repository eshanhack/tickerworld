import { createHash } from 'node:crypto';
import { imageDimensions } from './smoke-helpers.mjs';
import { socialCardExtension } from './generate-route-shells.mjs';

const MARKETS = [
  ['btc', 'BTC'],
  ['eth', 'ETH'],
  ['sol', 'SOL'],
  ['xrp', 'XRP'],
  ['doge', 'DOGE'],
  ['bnb', 'BNB'],
  ['link', 'LINK'],
  ['avax', 'AVAX'],
  ['wti', 'WTI'],
  ['test', 'TEST'],
  ['pump', 'PUMP'],
  ['ansem', 'ANSEM'],
  ['shfl', 'SHFL'],
];
const MARKET_SYMBOLS = new Set(MARKETS.map(([, symbol]) => symbol));
const TRUST_ROUTES = [
  ['/privacy', 'Privacy policy · Tickerworld', ['Privacy, without surprises.', 'privacy@tickerworld.io', 'Report evidence: up to 90 days']],
  ['/terms', 'Terms · Tickerworld', ['Hyperliquid perpetual-market pricing', 'not financial advice', 'Public wallet authentication']],
  ['/community', 'Community rules · Tickerworld', ['Keep the little world kind.', 'seed-phrase requests', 'Impersonate Tickerworld staff']],
  ['/support', 'Support · Tickerworld', ['privacy@tickerworld.io', 'Hyperliquid perpetual markets', 'in-game report flow']],
  ['/status', 'Service status · Tickerworld', ['Truthful status, in plain language.', 'one capped Colyseus process', 'Production never substitutes fictional players']],
];

function normalizeOrigin(value, fallback) {
  const url = new URL(value || fallback);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Expected an HTTP(S) origin, received ${url.protocol}`);
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

const clientOrigin = normalizeOrigin(
  process.env.TICKERWORLD_CLIENT_ORIGIN,
  'https://tickerworld.io',
);
const serverOrigin = normalizeOrigin(
  process.env.TICKERWORLD_SERVER_ORIGIN,
  'https://multiplayer.tickerworld.io',
);
const expectLiveNews = process.env.SMOKE_EXPECT_NEWS_LIVE === '1';
const expectMultiplayerLive = process.env.SMOKE_EXPECT_MULTIPLAYER_LIVE === '1';
const expectServerLive = expectMultiplayerLive || expectLiveNews;
const failures = [];
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

async function request(origin, path, label, headers = {}) {
  const url = new URL(path, origin);
  try {
    return await fetch(url, {
      headers: { 'user-agent': 'tickerworld-release-smoke/2.0', ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    failures.push(`${label} request failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function checkHtmlBasics(html, path, title, canonical) {
  check(html.includes(`<title>${title}</title>`), `${path} has the wrong title`);
  check(
    html.includes(`<link rel="canonical" href="${canonical}" />`)
      || html.includes(`<link rel="canonical" href="${canonical}">`),
    `${path} has the wrong canonical URL`,
  );
  check(!/[�]|(?:Ã.|Â.|â€)/.test(html), `${path} contains malformed UTF-8 copy`);
}

async function smokeRootAndUnknownRoutes() {
  const root = await request(clientOrigin, '/', '/');
  if (root) {
    check(root.ok, `/ returned ${root.status}`);
    check(root.headers.get('content-type')?.includes('text/html') === true, '/ did not return HTML');
    const html = await root.text();
    checkHtmlBasics(html, '/', 'Tickerworld', 'https://tickerworld.io/');
    check(html.includes('Walk inside live crypto markets with friends.'), '/ is missing launch positioning');
    check(html.includes('https://tickerworld.io/og.jpg'), '/ is missing its social card');
  }
  const unknown = await request(clientOrigin, '/not-a-market', '/not-a-market');
  if (unknown) {
    check(unknown.ok, `/not-a-market returned ${unknown.status}`);
    const html = await unknown.text();
    check(html.includes('<title>Tickerworld</title>'), 'unknown route did not return the chooser/app shell');
  }
}

async function smokeMarketRoutes() {
  const cardHashes = new Map();
  await Promise.all(MARKETS.map(async ([slug, symbol]) => {
    const extension = socialCardExtension(symbol);
    const path = `/${slug}`;
    const response = await request(clientOrigin, path, path);
    if (response) {
      check(response.ok, `${path} returned ${response.status}`);
      check(response.headers.get('content-type')?.includes('text/html') === true, `${path} did not return HTML`);
      const html = await response.text();
      const title = `${symbol} World · Tickerworld`;
      const canonical = `https://tickerworld.io/${slug}`;
      const image = `https://tickerworld.io/social/${slug}.${extension}`;
      const description = symbol === 'TEST'
        ? 'A deliberately wild simulated market for testing sounds, fireworks, and live-chart events.'
        : symbol === 'WTI'
          ? 'Walk inside the live CL crude-oil perpetual chart with other tiny animals.'
          : symbol === 'PUMP' || symbol === 'ANSEM'
            ? `Walk inside ${symbol}'s live Solana DEX chart with other tiny animals.`
            : symbol === 'SHFL'
              ? "Walk inside SHFL's live Ethereum DEX chart with other tiny animals."
          : `Walk inside ${symbol}’s live one-minute chart with other tiny animals.`;
      const status = symbol === 'TEST' ? 'SIMULATED' : 'LIVE';
      const enterLabel = symbol === 'TEST' ? 'Enter TEST lab' : `Enter ${symbol} world`;
      checkHtmlBasics(html, path, title, canonical);
      for (const expected of [
        description,
        `<meta property="og:url" content="${canonical}" />`,
        `<meta property="og:image" content="${image}" />`,
        '<meta property="og:image:width" content="1200" />',
        '<meta property="og:image:height" content="630" />',
        `<meta name="twitter:image" content="${image}" />`,
        `${symbol} WORLD · ${status}`,
        enterLabel,
        'No signup · no wallet · sound starts after tap',
      ]) check(html.includes(expected), `${path} is missing ${expected}`);
      check(!/\$[\d,.]+/.test(html), `${path} embeds a cache-prone price`);
    }

    const cardPath = `/social/${slug}.${extension}`;
    const card = await request(clientOrigin, cardPath, cardPath);
    if (!card) return;
    check(card.ok, `${cardPath} returned ${card.status}`);
    const expectedMime = extension === 'png' ? 'image/png' : 'image/jpeg';
    check(card.headers.get('content-type')?.includes(expectedMime) === true, `${cardPath} has the wrong image type`);
    const bytes = await card.arrayBuffer();
    const dimensions = imageDimensions(bytes);
    check(dimensions?.width === 1200 && dimensions?.height === 630, `${cardPath} is not 1200×630`);
    check(bytes.byteLength >= 20_000, `${cardPath} is unexpectedly small`);
    cardHashes.set(slug, createHash('sha256').update(Buffer.from(bytes)).digest('hex'));
  }));
  check(cardHashes.size === MARKETS.length, 'not every market social card was fetched');
  check(new Set(cardHashes.values()).size === MARKETS.length, 'market social cards are not route-specific');
}

async function smokeTrustRoutes() {
  await Promise.all(TRUST_ROUTES.map(async ([path, title, markers]) => {
    const response = await request(clientOrigin, path, path);
    if (!response) return;
    check(response.ok, `${path} returned ${response.status}`);
    check(response.headers.get('content-type')?.includes('text/html') === true, `${path} did not return HTML`);
    const html = await response.text();
    checkHtmlBasics(html, path, title, `https://tickerworld.io${path}`);
    for (const marker of markers) check(html.includes(marker), `${path} is missing “${marker}”`);
  }));

  const admin = await request(clientOrigin, '/admin', '/admin');
  if (admin) {
    check(admin.ok, `/admin returned ${admin.status}`);
    const html = await admin.text();
    const robots = `${admin.headers.get('x-robots-tag') ?? ''} ${html}`.toLowerCase();
    checkHtmlBasics(html, '/admin', 'Tickerworld safety desk', 'https://tickerworld.io/admin');
    check(robots.includes('noindex'), '/admin is missing noindex protection');
  }
}

async function smokePublicAssets() {
  const robots = await request(clientOrigin, '/robots.txt', '/robots.txt');
  if (robots) {
    check(robots.ok, `/robots.txt returned ${robots.status}`);
    const text = await robots.text();
    check(text.includes('Disallow: /admin'), 'robots.txt does not exclude /admin');
    check(text.includes('https://tickerworld.io/sitemap.xml'), 'robots.txt has the wrong sitemap');
  }
  const sitemap = await request(clientOrigin, '/sitemap.xml', '/sitemap.xml');
  if (sitemap) {
    check(sitemap.ok, `/sitemap.xml returned ${sitemap.status}`);
    const text = await sitemap.text();
    for (const path of [...MARKETS.map(([slug]) => `/${slug}`), ...TRUST_ROUTES.map(([path]) => path)]) {
      check(text.includes(`<loc>https://tickerworld.io${path}</loc>`), `sitemap is missing ${path}`);
    }
    check(!text.includes('/admin'), 'sitemap exposes /admin');
  }
  const manifest = await request(clientOrigin, '/site.webmanifest', '/site.webmanifest');
  if (manifest) {
    check(manifest.ok, `/site.webmanifest returned ${manifest.status}`);
    try {
      const payload = await manifest.json();
      check(payload?.start_url === '/btc', 'manifest start_url is not /btc');
      check(payload?.description === 'Walk inside live crypto markets with friends.', 'manifest positioning is stale');
    } catch {
      failures.push('/site.webmanifest did not return JSON');
    }
  }
  const statusScript = await request(clientOrigin, '/status/status.js', '/status/status.js');
  if (statusScript) {
    check(statusScript.ok, `/status/status.js returned ${statusScript.status}`);
    const text = await statusScript.text();
    check(text.includes('/api/capabilities'), 'status page does not read truthful capabilities');
    check(text.includes('/api/news'), 'status page does not read the centralized news cache');
  }
  for (const path of ['/favicon.png', '/og.jpg']) {
    const asset = await request(clientOrigin, path, path);
    if (!asset) continue;
    check(asset.ok, `${path} returned ${asset.status}`);
    check(asset.headers.get('content-type')?.startsWith('image/') === true, `${path} is not an image`);
  }
}

async function verifyNewsPayload(path, expectedScope = null) {
  const response = await request(clientOrigin, path, path);
  if (!response) return;
  check(response.ok, `${path} returned ${response.status}`);
  // Vercel consumes Vercel-CDN-Cache-Control at the edge instead of echoing it
  // to browsers. Locally we can inspect the directive; in production the
  // public proof is the deliberately revalidated response plus Vercel's
  // bounded MISS/HIT/STALE cache status.
  const edgeDirective = response.headers.get('vercel-cdn-cache-control') ?? '';
  const publicDirective = response.headers.get('cache-control') ?? '';
  const edgeStatus = response.headers.get('x-vercel-cache') ?? '';
  check(
    edgeDirective.includes('max-age=10')
      || (
        publicDirective.includes('public')
        && publicDirective.includes('max-age=0')
        && /^(?:MISS|HIT|STALE|BYPASS)$/.test(edgeStatus)
      ),
    `${path} lacks bounded CDN caching`,
  );
  let payload;
  try {
    payload = await response.json();
  } catch {
    failures.push(`${path} did not return JSON`);
    return;
  }
  check(['live', 'unconfigured', 'unavailable'].includes(payload?.mode), `${path} returned unexpected mode ${String(payload?.mode)}`);
  check(Number.isFinite(payload?.checkedAt), `${path} has no checkedAt timestamp`);
  check(Array.isArray(payload?.items), `${path} items is not an array`);
  if (Array.isArray(payload?.items)) {
    check(payload.items.every((item) => item?.demo === false && item?.source === 'x'), `${path} exposed simulated or unattributed content`);
    if (expectedScope) {
      check(payload.items.every((item) => item?.scope === 'global' || item?.scope === expectedScope), `${path} leaked another market's news`);
    }
  }
  if (expectLiveNews) check(payload?.mode === 'live', `${path} is not live`);
}

async function smokeNews() {
  await Promise.all([
    verifyNewsPayload('/api/news'),
    ...MARKETS.map(([, symbol]) => verifyNewsPayload(`/api/news?scope=${symbol}`, symbol)),
  ]);
  for (const path of ['/api/news?scope=INVALID', '/api/news?cache-bust=1']) {
    const response = await request(clientOrigin, path, path);
    if (response) check(response.status === 400, `${path} did not reject an unbounded cache variant`);
  }
}

async function smokeServer() {
  if (!expectServerLive) return;
  const originHeader = { origin: clientOrigin.origin };
  const health = await request(serverOrigin, '/healthz', 'multiplayer /healthz', originHeader);
  if (health) {
    check(health.ok, `multiplayer /healthz returned ${health.status}`);
    try {
      const payload = await health.json();
      check(payload?.status === 'ok', 'multiplayer /healthz is not ok');
      check(payload?.protocolVersion === 2, 'multiplayer protocolVersion is not 2');
    } catch {
      failures.push('multiplayer /healthz did not return JSON');
    }
  }

  let capabilities = null;
  const capabilityResponse = await request(serverOrigin, '/api/capabilities', 'multiplayer /api/capabilities', originHeader);
  if (capabilityResponse) {
    check(capabilityResponse.ok, `multiplayer /api/capabilities returned ${capabilityResponse.status}`);
    check(capabilityResponse.headers.get('cache-control')?.includes('no-store') === true, 'capabilities can be cached');
    check(capabilityResponse.headers.get('access-control-allow-origin') === clientOrigin.origin, 'capabilities CORS origin is incorrect');
    try { capabilities = await capabilityResponse.json(); } catch { failures.push('multiplayer /api/capabilities did not return JSON'); }
  }
  if (capabilities) {
    check(capabilities.protocolVersion === 2, 'capabilities protocolVersion is not 2');
    check(Number.isFinite(capabilities.updatedAt), 'capabilities updatedAt is missing');
    check(capabilities.maxPlayersPerShard === 50, 'capabilities shard cap is not 50');
    check(capabilities.maxProcessConnections === 400, 'capabilities process cap is not 400');
    for (const key of ['admissions', 'chatSend', 'newsIngest', 'directMarketFallback', 'publicWalletAuth', 'purchases', 'adminActions']) {
      check(typeof capabilities.switches?.[key] === 'boolean', `capabilities switch ${key} is missing`);
    }
    check(capabilities.switches?.publicWalletAuth === false, 'public wallet auth is enabled at launch');
    check(capabilities.switches?.purchases === false, 'purchases are enabled at launch');
    check(capabilities.switches?.directMarketFallback === true, 'active-market browser fallback is disabled');
    if (expectMultiplayerLive) {
      check(capabilities.multiplayerAvailable === true, 'multiplayer capability is unavailable');
      check(capabilities.switches?.admissions === true, 'multiplayer admissions are disabled');
      check(capabilities.switches?.chatSend === true, 'room chat is disabled');
      check(capabilities.marketRelayAvailable === true, 'central market relay is unavailable');
    }
    if (expectLiveNews) check(capabilities.newsAvailable === true, 'central news cache is unavailable');
  }

  const ready = await request(serverOrigin, '/readyz', 'multiplayer /readyz', originHeader);
  if (ready) {
    check(ready.ok, `multiplayer /readyz returned ${ready.status}`);
    try {
      const payload = await ready.json();
      check(payload?.status === 'ready', 'multiplayer /readyz is not ready');
      check(payload?.features?.database === true, 'multiplayer database is not ready');
      check(payload?.features?.trustedProxy === true, 'multiplayer trusted proxy is not ready');
      check(payload?.features?.walletAuth === false, 'public wallet auth unexpectedly reports ready');
      check(payload?.features?.purchases === false, 'purchases unexpectedly report ready');
      if (expectMultiplayerLive) {
        check(payload?.features?.marketRelay === true, 'market relay is not ready');
        check(Number.isFinite(payload?.features?.marketAgeMs) && payload.features.marketAgeMs <= 15_000, 'market relay data is stale');
      }
      if (expectLiveNews) check(payload?.features?.news === true, 'news ingestion is not ready');
      if (capabilities) {
        check(payload?.features?.administration === capabilities.switches?.adminActions, 'administration readiness disagrees with its switch');
      }
    } catch {
      failures.push('multiplayer /readyz did not return JSON');
    }
  }
}

await Promise.all([
  smokeRootAndUnknownRoutes(),
  smokeMarketRoutes(),
  smokeTrustRoutes(),
  smokePublicAssets(),
  smokeNews(),
  smokeServer(),
]);

if (failures.length > 0) {
  console.error(`Tickerworld production smoke failed (${failures.length} failures across ${checks} assertions):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Tickerworld production smoke passed (${checks} checks).`);
}
