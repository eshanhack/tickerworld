import { describe, expect, it } from 'vitest';
import community from '../public/community/index.html?raw';
import privacy from '../public/privacy/index.html?raw';
import robots from '../public/robots.txt?raw';
import sitemap from '../public/sitemap.xml?raw';
import status from '../public/status/index.html?raw';
import support from '../public/support/index.html?raw';
import terms from '../public/terms/index.html?raw';

const pages = [
  ['privacy', privacy, 'Privacy policy · Tickerworld', 'privacy@tickerworld.io'],
  ['terms', terms, 'Terms · Tickerworld', 'Hyperliquid perpetual-market pricing'],
  ['community', community, 'Community rules · Tickerworld', 'seed-phrase requests'],
  ['support', support, 'Support · Tickerworld', 'in-game report flow'],
  ['status', status, 'Service status · Tickerworld', 'Production never substitutes fictional players'],
] as const;

describe('public trust pages', () => {
  it.each(pages)('%s is canonical, readable, and contains its launch disclosure', (slug, html, title, disclosure) => {
    expect(html).toContain(`<title>${title}</title>`);
    expect(html).toContain(`rel="canonical" href="https://tickerworld.io/${slug}"`);
    expect(html).toContain(disclosure);
    expect(html).not.toMatch(/[�]|(?:Ã.|Â.|â€)/);
  });

  it('keeps admin out of search discovery while listing every public launch route', () => {
    expect(robots).toContain('Disallow: /admin');
    expect(sitemap).not.toContain('/admin');
    for (const path of [
      '/btc', '/eth', '/sol', '/xrp', '/doge', '/bnb', '/link', '/avax', '/wti', '/test',
      '/privacy', '/terms', '/community', '/support', '/status',
    ]) expect(sitemap).toContain(`<loc>https://tickerworld.io${path}</loc>`);
  });
});
