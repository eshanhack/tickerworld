import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKET_SHELLS = [
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
  ['skhynix', 'SKHYNIX'],
  ['hype', 'HYPE'],
  ['xyz100', 'XYZ100'],
  ['sp500', 'SP500'],
  ['micron', 'MU'],
  ['spacex', 'SPACEX'],
  ['nvidia', 'NVDA'],
  ['gold', 'GOLD'],
  ['apple', 'AAPL'],
  ['meta', 'META'],
  ['google', 'GOOGL'],
];

const MARKET_COPY = {
  SKHYNIX: {
    name: 'SK hynix',
    description: 'Explore SK hynix\u2019s live 24/7 share-tracking perpetual chart in a stacked-memory garden.',
  },
  HYPE: {
    name: 'HYPE',
    description: 'Explore HYPE\u2019s live 24/7 perpetual chart across a HyperCore archipelago.',
  },
  XYZ100: {
    name: 'XYZ100',
    description: 'Explore the live 24/7 modified U.S. 100 index-tracking perpetual chart inside an innovation skyline.',
  },
  SP500: {
    name: 'S&P 500',
    description: 'Explore the live 24/7 S&P 500 index-tracking perpetual chart inside an American market mosaic.',
  },
  MU: {
    name: 'Micron (MU)',
    description: 'Explore Micron\u2019s live 24/7 share-tracking perpetual chart inside a memory canyon.',
  },
  SPACEX: {
    name: 'SpaceX',
    description: 'Explore the live 24/7 SpaceX share-tracking perpetual chart from a reusable-launch coast.',
  },
  NVDA: {
    name: 'NVIDIA (NVDA)',
    description: 'Explore NVIDIA\u2019s live 24/7 share-tracking perpetual chart inside an AI factory garden.',
  },
  GOLD: {
    name: 'Gold',
    description: 'Explore the live 24/7 gold perpetual chart inside an auric vault grotto.',
  },
  AAPL: {
    name: 'Apple (AAPL)',
    description: 'Explore Apple\u2019s live 24/7 share-tracking perpetual chart inside an orchard of ideas.',
  },
  META: {
    name: 'Meta',
    description: 'Explore Meta\u2019s live 24/7 share-tracking perpetual chart inside a connection loom.',
  },
  GOOGL: {
    name: 'Google (GOOGL)',
    description: 'Explore Google\u2019s live 24/7 share-tracking perpetual chart inside an information atlas.',
  },
};

const SHARED_SOCIAL_CARD_SYMBOLS = new Set(Object.keys(MARKET_COPY));

function marketCopyFor(symbol) {
  return Object.hasOwn(MARKET_COPY, symbol) ? MARKET_COPY[symbol] : null;
}

export function marketDisplayName(symbol) {
  return marketCopyFor(symbol)?.name ?? symbol;
}

export function socialCardExtension(symbol) {
  return symbol === 'WTI' || symbol === 'TEST'
    || symbol === 'PUMP' || symbol === 'ANSEM' || symbol === 'SHFL'
    ? 'png'
    : 'jpg';
}

export function socialCardPath(slug, symbol) {
  // New worlds use the honest, non-live Tickerworld brand card until their
  // finished in-game scenes are available for route-specific captures.
  return SHARED_SOCIAL_CARD_SYMBOLS.has(symbol) ? 'og.jpg' : `social/${slug}.${socialCardExtension(symbol)}`;
}

export function routeDescription(symbol) {
  const copy = marketCopyFor(symbol);
  if (copy) return copy.description;
  if (symbol === 'TEST') return 'A deliberately wild simulated market for testing sounds, fireworks, and live-chart events.';
  if (symbol === 'WTI') return 'Walk inside the live CL crude-oil perpetual chart with other tiny characters.';
  if (symbol === 'PUMP' || symbol === 'ANSEM') return `Walk inside ${symbol}'s live Solana DEX chart with other tiny characters.`;
  if (symbol === 'SHFL') return "Walk inside SHFL's live Ethereum DEX chart with other tiny characters.";
  return `Walk inside ${symbol}’s live one-minute chart with other tiny characters.`;
}

function escapeAttribute(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function replaceMeta(html, attribute, key, content) {
  const pattern = new RegExp(`<meta\\s+${attribute}="${key}"\\s+content="[^"]*"\\s*\\/?>(?![\\s\\S]*<meta\\s+${attribute}="${key}")`, 'i');
  const tag = `<meta ${attribute}="${key}" content="${escapeAttribute(content)}" />`;
  return pattern.test(html) ? html.replace(pattern, tag) : html.replace('</head>', `    ${tag}\n  </head>`);
}

function replaceCanonical(html, href) {
  const tag = `<link rel="canonical" href="${escapeAttribute(href)}" />`;
  return /<link\s+rel="canonical"[^>]*>/i.test(html)
    ? html.replace(/<link\s+rel="canonical"[^>]*>/i, tag)
    : html.replace('</head>', `    ${tag}\n  </head>`);
}

function staticEntryMarkup(slug, symbol, description) {
  const status = symbol === 'TEST' ? 'SIMULATED' : 'LIVE';
  const displayName = marketDisplayName(symbol);
  const enterLabel = symbol === 'TEST' ? 'Enter TEST lab' : `Enter ${displayName} world`;
  return `<style data-static-entry-style>
    .static-entry{min-height:100svh;display:grid;place-items:center;padding:1.25rem;background:#a9d6ce;color:#31373d;font-family:ui-rounded,system-ui,sans-serif}.static-entry section{width:min(100%,40rem);padding:clamp(1.4rem,5vw,3rem);border:1px solid #31373d20;border-radius:2rem;background:#fff1cfee;box-shadow:0 1.4rem 4rem #30484433;text-align:center}.static-entry small{color:#4c8179;font-weight:900;letter-spacing:.12em}.static-entry h1{margin:.55rem 0;font-size:clamp(2.8rem,10vw,5.5rem);line-height:.92;letter-spacing:-.06em}.static-entry p{max-width:32rem;margin:1rem auto;line-height:1.6}.static-entry a{display:inline-block;margin:.45rem 0;padding:.9rem 1.25rem;border-radius:999px;background:#c9744f;color:#fff1cf;font-weight:900;text-decoration:none}.static-entry footer{margin-top:.7rem;color:#31373d99;font-size:.82rem}
  </style><main class="static-entry" aria-label="${symbol} world entry"><section>
    <small>${symbol} WORLD · ${status}</small><h1>Tickerworld</h1><p>${description}</p>
    <p aria-live="polite">Checking live market and room status…</p>
    <a href="/${slug}">${enterLabel}</a><footer>No signup · no wallet · sound starts after tap</footer>
  </section></main>`;
}

export function renderMarketShell(template, slug, symbol) {
  const displayName = marketDisplayName(symbol);
  const title = `${displayName} World · Tickerworld`;
  const description = routeDescription(symbol);
  const canonical = `https://tickerworld.io/${slug}`;
  const cardPath = socialCardPath(slug, symbol);
  const image = `https://tickerworld.io/${cardPath}`;
  const imageAlt = cardPath === 'og.jpg'
    ? 'Tickerworld entry card over a pastel market world'
    : `${displayName} world and live chart in Tickerworld`;
  let html = template.replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`);
  html = replaceMeta(html, 'name', 'description', description);
  html = replaceMeta(html, 'property', 'og:title', title);
  html = replaceMeta(html, 'property', 'og:description', description);
  html = replaceMeta(html, 'property', 'og:url', canonical);
  html = replaceMeta(html, 'property', 'og:image', image);
  html = replaceMeta(html, 'property', 'og:image:width', '1200');
  html = replaceMeta(html, 'property', 'og:image:height', '630');
  html = replaceMeta(html, 'property', 'og:image:alt', imageAlt);
  html = replaceMeta(html, 'name', 'twitter:card', 'summary_large_image');
  html = replaceMeta(html, 'name', 'twitter:title', title);
  html = replaceMeta(html, 'name', 'twitter:description', description);
  html = replaceMeta(html, 'name', 'twitter:image', image);
  html = replaceMeta(html, 'name', 'twitter:image:alt', imageAlt);
  html = replaceCanonical(html, canonical);
  html = html.replace('<div id="app"></div>', `<div id="app">${staticEntryMarkup(slug, symbol, description)}</div>`);
  return html;
}

export function renderAdminShell(template) {
  let html = template.replace(/<title>[^<]*<\/title>/i, '<title>Tickerworld safety desk</title>');
  html = replaceMeta(html, 'name', 'robots', 'noindex, nofollow');
  html = replaceCanonical(html, 'https://tickerworld.io/admin');
  return html;
}

export async function generateRouteShells(outputDirectory = resolve('dist')) {
  const indexPath = resolve(outputDirectory, 'index.html');
  const template = await readFile(indexPath, 'utf8');
  await Promise.all(MARKET_SHELLS.map(async ([slug, symbol]) => {
    await writeFile(resolve(outputDirectory, `${slug}.html`), renderMarketShell(template, slug, symbol));
  }));
  await writeFile(resolve(outputDirectory, 'admin.html'), renderAdminShell(template));
  await mkdir(resolve(outputDirectory, 'social'), { recursive: true });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await generateRouteShells();
}
