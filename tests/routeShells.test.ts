import { describe, expect, it } from 'vitest';
import {
  MARKET_SHELLS,
  marketDisplayName,
  renderAdminShell,
  renderMarketShell,
  routeDescription,
  socialCardPath,
} from '../scripts/generate-route-shells.mjs';

const template = `<!doctype html><html><head>
  <meta name="description" content="old" />
  <meta property="og:title" content="old" />
  <meta property="og:description" content="old" />
  <meta property="og:url" content="https://tickerworld.io/" />
  <meta property="og:image" content="https://tickerworld.io/og.jpg" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="https://tickerworld.io/og.jpg" />
  <link rel="canonical" href="https://tickerworld.io/" />
  <title>Tickerworld</title></head><body><div id="app"></div></body></html>`;

describe('static market entry shells', () => {
  it('defines every live and demo launch route', () => {
    expect(MARKET_SHELLS.map(([slug]) => slug)).toEqual([
      'btc', 'eth', 'sol', 'xrp', 'doge', 'bnb', 'link', 'avax',
      'wti', 'test',
      'pump', 'ansem', 'shfl',
      'skhynix', 'hype', 'xyz100', 'sp500', 'micron', 'spacex',
      'nvidia', 'gold', 'apple', 'meta', 'google',
    ]);
  });

  it('renders route-specific crawler metadata without live prices', () => {
    const html = renderMarketShell(template, 'btc', 'BTC');
    expect(html).toContain('<title>BTC World · Tickerworld</title>');
    expect(html).toContain('Walk inside BTC’s live one-minute chart with other tiny characters.');
    expect(html).toContain('https://tickerworld.io/social/btc.jpg');
    expect(html).toContain('<meta property="og:image:width" content="1200" />');
    expect(html).toContain('<meta property="og:image:height" content="630" />');
    expect(html).toContain('content="BTC world and live chart in Tickerworld"');
    expect(html).toContain('https://tickerworld.io/btc');
    expect(html).toContain('BTC WORLD · LIVE');
    expect(html).toContain('Enter BTC world');
    expect(html).toContain('No signup · no wallet · sound starts after tap');
    expect(html).not.toMatch(/\$[\d,.]+/);
  });

  it('labels TEST as simulated and WTI as the live CL crude-oil world', () => {
    const test = renderMarketShell(template, 'test', 'TEST');
    expect(test).toContain('TEST WORLD · SIMULATED');
    expect(test).toContain('Enter TEST lab');
    expect(test).toContain('deliberately wild simulated market');
    expect(test).toContain('https://tickerworld.io/social/test.png');

    const wti = renderMarketShell(template, 'wti', 'WTI');
    expect(wti).toContain('WTI WORLD · LIVE');
    expect(wti).toContain('CL crude-oil perpetual');
    expect(wti).toContain('https://tickerworld.io/social/wti.png');
  });

  it('gives every new 24/7 world truthful derivative copy and a canonical direct route', () => {
    const expected = [
      ['skhynix', 'SKHYNIX', 'SK hynix', 'share-tracking perpetual', 'stacked-memory garden'],
      ['hype', 'HYPE', 'HYPE', '24/7 perpetual', 'HyperCore archipelago'],
      ['xyz100', 'XYZ100', 'XYZ100', 'modified U.S. 100 index-tracking perpetual', 'innovation skyline'],
      ['sp500', 'SP500', 'S&P 500', 'S&P 500 index-tracking perpetual', 'American market mosaic'],
      ['micron', 'MU', 'Micron (MU)', 'share-tracking perpetual', 'memory canyon'],
      ['spacex', 'SPACEX', 'SpaceX', 'share-tracking perpetual', 'reusable-launch coast'],
      ['nvidia', 'NVDA', 'NVIDIA (NVDA)', 'share-tracking perpetual', 'AI factory garden'],
      ['gold', 'GOLD', 'Gold', 'gold perpetual', 'auric vault grotto'],
      ['apple', 'AAPL', 'Apple (AAPL)', 'share-tracking perpetual', 'orchard of ideas'],
      ['meta', 'META', 'Meta', 'share-tracking perpetual', 'connection loom'],
      ['google', 'GOOGL', 'Google (GOOGL)', 'share-tracking perpetual', 'information atlas'],
    ] as const;

    for (const [slug, symbol, displayName, instrument, setting] of expected) {
      expect(marketDisplayName(symbol)).toBe(displayName);
      expect(routeDescription(symbol)).toContain(instrument);
      expect(routeDescription(symbol)).toContain(setting);
      const html = renderMarketShell(template, slug, symbol);
      expect(html).toContain(`<title>${displayName} World · Tickerworld</title>`);
      expect(html).toContain(`<link rel="canonical" href="https://tickerworld.io/${slug}" />`);
      expect(html).toContain(`${symbol} WORLD · LIVE`);
      expect(html).toContain(`Enter ${displayName} world`);
      expect(html).toContain('https://tickerworld.io/og.jpg');
      expect(html).toContain('Tickerworld entry card over a pastel market world');
      expect(socialCardPath(slug, symbol)).toBe('og.jpg');
      expect(html).not.toMatch(/\$[\d,.]+/);
    }
  });

  it('marks the admin shell as noindex', () => {
    expect(renderAdminShell(template)).toContain('content="noindex, nofollow"');
  });
});
