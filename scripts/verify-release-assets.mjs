import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jpegDimensions } from './smoke-helpers.mjs';

const MARKETS = [
  ['btc', 'BTC'], ['eth', 'ETH'], ['sol', 'SOL'], ['xrp', 'XRP'],
  ['doge', 'DOGE'], ['bnb', 'BNB'], ['link', 'LINK'], ['avax', 'AVAX'],
];
const TRUST_ROUTES = ['privacy', 'terms', 'community', 'support', 'status'];

function requireText(haystack, needle, label) {
  if (!haystack.includes(needle)) throw new Error(`${label} is missing ${needle}`);
}

export async function verifyReleaseAssets(outputDirectory = resolve('dist')) {
  const hashes = new Set();
  for (const [slug, symbol] of MARKETS) {
    const html = await readFile(resolve(outputDirectory, `${slug}.html`), 'utf8');
    requireText(html, `<title>${symbol} World · Tickerworld</title>`, `${slug}.html`);
    requireText(html, `<link rel="canonical" href="https://tickerworld.io/${slug}" />`, `${slug}.html`);
    requireText(html, `https://tickerworld.io/social/${slug}.jpg`, `${slug}.html`);
    requireText(html, '<meta property="og:image:width" content="1200" />', `${slug}.html`);
    requireText(html, '<meta property="og:image:height" content="630" />', `${slug}.html`);
    if (/\$[\d,.]+/.test(html)) throw new Error(`${slug}.html embeds a cache-prone live price`);

    const cardPath = resolve(outputDirectory, 'social', `${slug}.jpg`);
    const [card, cardStat] = await Promise.all([readFile(cardPath), stat(cardPath)]);
    const dimensions = jpegDimensions(card);
    if (dimensions?.width !== 1200 || dimensions.height !== 630) {
      throw new Error(`${slug}.jpg must be exactly 1200×630`);
    }
    if (cardStat.size < 20_000) throw new Error(`${slug}.jpg is unexpectedly small`);
    hashes.add(createHash('sha256').update(card).digest('hex'));
  }
  if (hashes.size !== MARKETS.length) throw new Error('Every market requires a unique social card');

  for (const slug of TRUST_ROUTES) {
    const html = await readFile(resolve(outputDirectory, slug, 'index.html'), 'utf8');
    requireText(html, `rel="canonical" href="https://tickerworld.io/${slug}"`, `${slug}/index.html`);
  }
  const admin = await readFile(resolve(outputDirectory, 'admin.html'), 'utf8');
  requireText(admin, 'content="noindex, nofollow"', 'admin.html');
  return { markets: MARKETS.length, trustPages: TRUST_ROUTES.length };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const result = await verifyReleaseAssets();
  process.stdout.write(`Verified ${result.markets} market shells/cards and ${result.trustPages} trust pages.\n`);
}
