import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageDimensions } from './smoke-helpers.mjs';
import {
  MARKET_SHELLS,
  marketDisplayName,
  socialCardPath,
} from './generate-route-shells.mjs';
const TRUST_ROUTES = ['privacy', 'terms', 'community', 'support', 'status'];

function requireText(haystack, needle, label) {
  if (!haystack.includes(needle)) throw new Error(`${label} is missing ${needle}`);
}

export async function verifyReleaseAssets(outputDirectory = resolve('dist')) {
  const routeSpecificCardHashes = new Set();
  const routeSpecificCardCount = MARKET_SHELLS.filter(([slug, symbol]) => (
    socialCardPath(slug, symbol) !== 'og.jpg'
  )).length;
  for (const [slug, symbol] of MARKET_SHELLS) {
    const cardRelativePath = socialCardPath(slug, symbol);
    const html = await readFile(resolve(outputDirectory, `${slug}.html`), 'utf8');
    requireText(html, `<title>${marketDisplayName(symbol)} World · Tickerworld</title>`, `${slug}.html`);
    requireText(html, `<link rel="canonical" href="https://tickerworld.io/${slug}" />`, `${slug}.html`);
    requireText(html, `https://tickerworld.io/${cardRelativePath}`, `${slug}.html`);
    requireText(html, '<meta property="og:image:width" content="1200" />', `${slug}.html`);
    requireText(html, '<meta property="og:image:height" content="630" />', `${slug}.html`);
    if (/\$[\d,.]+/.test(html)) throw new Error(`${slug}.html embeds a cache-prone live price`);

    const cardPath = resolve(outputDirectory, cardRelativePath);
    const [card, cardStat] = await Promise.all([readFile(cardPath), stat(cardPath)]);
    const dimensions = imageDimensions(card);
    if (dimensions?.width !== 1200 || dimensions.height !== 630) {
      throw new Error(`${cardRelativePath} must be exactly 1200×630`);
    }
    if (cardStat.size < 20_000) throw new Error(`${cardRelativePath} is unexpectedly small`);
    if (cardRelativePath !== 'og.jpg') {
      routeSpecificCardHashes.add(createHash('sha256').update(card).digest('hex'));
    }
  }
  if (routeSpecificCardHashes.size !== routeSpecificCardCount) {
    throw new Error('Every finished market capture requires a unique social card');
  }

  for (const slug of TRUST_ROUTES) {
    const html = await readFile(resolve(outputDirectory, slug, 'index.html'), 'utf8');
    requireText(html, `rel="canonical" href="https://tickerworld.io/${slug}"`, `${slug}/index.html`);
  }
  const admin = await readFile(resolve(outputDirectory, 'admin.html'), 'utf8');
  requireText(admin, 'content="noindex, nofollow"', 'admin.html');
  return { markets: MARKET_SHELLS.length, trustPages: TRUST_ROUTES.length };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const result = await verifyReleaseAssets();
  process.stdout.write(`Verified ${result.markets} market shells/cards and ${result.trustPages} trust pages.\n`);
}
