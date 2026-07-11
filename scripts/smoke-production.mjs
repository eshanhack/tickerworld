const MARKET_SLUGS = ['btc', 'eth', 'sol', 'xrp', 'doge', 'bnb', 'link', 'avax'];

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
const failures = [];
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

async function request(origin, path, label) {
  const url = new URL(path, origin);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'tickerworld-release-smoke/1.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    return response;
  } catch (error) {
    failures.push(`${label} request failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function smokeMarketRoutes() {
  const routes = ['/', ...MARKET_SLUGS.map((slug) => `/${slug}`)];
  for (const path of routes) {
    const response = await request(clientOrigin, path, path);
    if (!response) continue;
    check(response.ok, `${path} returned ${response.status}`);
    check(
      response.headers.get('content-type')?.includes('text/html') === true,
      `${path} did not return HTML`,
    );
    const html = await response.text();
    check(
      /<title>\s*Tickerworld\s*<\/title>/i.test(html),
      `${path} did not return the Tickerworld app shell`,
    );
  }
}

async function smokeStaticRoutes() {
  const admin = await request(clientOrigin, '/admin', '/admin');
  if (admin) {
    check(admin.ok, `/admin returned ${admin.status}`);
    const html = await admin.text();
    const robots = `${admin.headers.get('x-robots-tag') ?? ''} ${html}`.toLowerCase();
    check(robots.includes('noindex'), '/admin is missing noindex protection');
  }
}

async function smokeNews() {
  const response = await request(clientOrigin, '/api/news', '/api/news');
  if (!response) return;
  check(response.ok, `/api/news returned ${response.status}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    failures.push('/api/news did not return JSON');
    return;
  }
  check(
    ['live', 'unconfigured', 'unavailable'].includes(payload?.mode),
    `/api/news returned unexpected mode ${String(payload?.mode)}`,
  );
  check(Array.isArray(payload?.items), '/api/news items is not an array');
  if (Array.isArray(payload?.items)) {
    check(
      payload.items.every((item) => item?.demo !== true && item?.source !== 'simulation'),
      '/api/news exposed simulated content in production',
    );
  }
  if (expectLiveNews) check(payload?.mode === 'live', '/api/news is not live');
}

async function smokeMultiplayer() {
  // Production intentionally remains a fully playable solo experience until
  // the Colyseus/Neon/DNS credential checklist is complete. Set the explicit
  // flag only when multiplayer is expected to be live.
  if (!expectMultiplayerLive) return;
  const health = await request(serverOrigin, '/healthz', 'multiplayer /healthz');
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

  const ready = await request(serverOrigin, '/readyz', 'multiplayer /readyz');
  if (ready) {
    check(ready.ok, `multiplayer /readyz returned ${ready.status}`);
    try {
      const payload = await ready.json();
      check(payload?.status === 'ready', 'multiplayer /readyz is not ready');
      for (const feature of ['database', 'walletAuth', 'purchases', 'trustedProxy', 'administration']) {
        check(payload?.features?.[feature] === true, `multiplayer ${feature} is not ready`);
      }
    } catch {
      failures.push('multiplayer /readyz did not return JSON');
    }
  }
}

await Promise.all([
  smokeMarketRoutes(),
  smokeStaticRoutes(),
  smokeNews(),
  smokeMultiplayer(),
]);

if (failures.length > 0) {
  console.error(
    `Tickerworld production smoke failed (${failures.length} failures across ${checks} assertions):`,
  );
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Tickerworld production smoke passed (${checks} checks).`);
}
