import { describe, expect, it } from 'vitest';
import {
  MARKET_SHELLS,
  renderAdminShell,
  renderMarketShell,
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
    ]);
  });

  it('renders route-specific crawler metadata without live prices', () => {
    const html = renderMarketShell(template, 'btc', 'BTC');
    expect(html).toContain('<title>BTC World · Tickerworld</title>');
    expect(html).toContain('Walk inside BTC’s live one-minute chart with other tiny animals.');
    expect(html).toContain('https://tickerworld.io/social/btc.jpg');
    expect(html).toContain('<meta property="og:image:width" content="1200" />');
    expect(html).toContain('<meta property="og:image:height" content="630" />');
    expect(html).toContain('content="BTC shrine and live chart in Tickerworld"');
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

  it('marks the admin shell as noindex', () => {
    expect(renderAdminShell(template)).toContain('content="noindex, nofollow"');
  });
});
