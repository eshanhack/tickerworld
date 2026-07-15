import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  POSTCARD_HEIGHT,
  POSTCARD_WIDTH,
  calculatePostcardCamera,
  flipRgbaRows,
  formatPostcardPrice,
  marketShareAttribution,
  marketShareDescription,
  isPartyShareCurrent,
  parsePartyInvite,
  parsePartyToken,
  publicShareUrl,
  partyFailureFromError,
  shareOrCopyLink,
  sharePostcard,
  withoutPartyToken,
  withPartyToken,
} from '../src/share';

describe('party links', () => {
  it('parses only bounded hash tokens and preserves other hash parameters', () => {
    expect(parsePartyToken('#party=abc_DEF-123')).toBe('abc_DEF-123');
    expect(parsePartyToken('#party=short')).toBeNull();
    expect(parsePartyToken('#party=%3Cscript%3E')).toBeNull();
    const url = new URL(withPartyToken('https://tickerworld.io/btc#camera=wide', 'abc_DEF-123'));
    expect(url.hash).toContain('camera=wide');
    expect(parsePartyToken(url.hash)).toBe('abc_DEF-123');
    expect(parsePartyToken(new URL(withoutPartyToken(url.toString())).hash)).toBeNull();
    const publicUrl = new URL(publicShareUrl(
      'https://tickerworld.io/btc?data=sim&debug=1&seed=qa&news=sim&capture=1&ref=friend#party=abc_DEF-123',
    ));
    expect(publicUrl.searchParams.get('ref')).toBe('friend');
    expect(publicUrl.searchParams.has('data')).toBe(false);
    expect(publicUrl.searchParams.has('debug')).toBe(false);
    expect(publicUrl.searchParams.has('seed')).toBe(false);
    expect(publicUrl.searchParams.has('news')).toBe(false);
    expect(publicUrl.searchParams.has('capture')).toBe(false);
    expect(parsePartyToken(publicUrl.hash)).toBeNull();
  });

  it('validates invite replies and classifies truthful fallback reasons', () => {
    expect(parsePartyInvite({ requestId: 'request_123', token: 'token_123456', expiresAt: 5_000 }))
      .toEqual({ requestId: 'request_123', token: 'token_123456', expiresAt: 5_000 });
    expect(parsePartyInvite({ requestId: 'x', token: 'bad', expiresAt: 1 })).toBeNull();
    expect(partyFailureFromError(new Error('party_full'))).toBe('party_full');
    expect(partyFailureFromError({ code: 'party_expired' })).toBe('party_expired');
    expect(partyFailureFromError(new Error('network unavailable'))).toBeNull();
    const binding = { market: 'BTC', roomEpoch: 3, expiresAt: 5_000 };
    expect(isPartyShareCurrent(binding, 'BTC', 3, 4_999)).toBe(true);
    expect(isPartyShareCurrent(binding, 'ETH', 3, 4_999)).toBe(false);
    expect(isPartyShareCurrent(binding, 'BTC', 4, 4_999)).toBe(false);
    expect(isPartyShareCurrent(binding, 'BTC', 3, 5_000)).toBe(false);
  });
});

describe('share actions', () => {
  it('uses native Web Share and falls back to the clipboard for links', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    await expect(shareOrCopyLink({
      url: 'https://tickerworld.io/btc', title: 'BTC', text: 'Meet me', navigator: { share, clipboard },
    })).resolves.toEqual({ mode: 'native', completed: true });
    expect(clipboard.writeText).not.toHaveBeenCalled();

    share.mockRejectedValueOnce(new Error('not supported'));
    await expect(shareOrCopyLink({
      url: 'https://tickerworld.io/eth', title: 'ETH', text: 'Meet me', navigator: { share, clipboard },
    })).resolves.toEqual({ mode: 'clipboard', completed: true });
    expect(clipboard.writeText).toHaveBeenCalledWith('https://tickerworld.io/eth');
  });

  it('shares postcard files when supported and otherwise downloads plus copies', async () => {
    const png = new Blob(['png'], { type: 'image/png' });
    const file = { name: 'postcard.png' } as File;
    const nativeShare = vi.fn().mockResolvedValue(undefined);
    const createFile = vi.fn(() => file);
    await expect(sharePostcard({
      png, filename: 'postcard.png', url: 'https://tickerworld.io/btc', title: 'Postcard', text: 'BTC',
      navigator: { share: nativeShare, canShare: () => true }, createFile,
    })).resolves.toEqual({ mode: 'native', completed: true });

    const download = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    await expect(sharePostcard({
      png, filename: 'postcard.png', url: 'https://tickerworld.io/btc', title: 'Postcard', text: 'BTC',
      navigator: { canShare: () => false, clipboard: { writeText } }, createFile, download,
    })).resolves.toEqual({ mode: 'download', completed: true, linkCopied: true });
    expect(download).toHaveBeenCalledWith(png, 'postcard.png');
    expect(writeText).toHaveBeenCalledWith('https://tickerworld.io/btc');

    await expect(sharePostcard({
      png, filename: 'postcard.png', url: 'https://tickerworld.io/btc', title: 'Postcard', text: 'BTC',
      navigator: { canShare: () => false }, createFile, download,
    })).resolves.toEqual({ mode: 'download', completed: true, linkCopied: false });
  });
});

describe('postcard formatting', () => {
  it('labels live XYZ perpetuals and their reference-asset disclosure explicitly', () => {
    expect(marketShareAttribution('SPACEX', 'hyperliquid')).toEqual({
      displayName: 'SpaceX',
      providerLabel: 'HYPERLIQUID XYZ PERP',
      disclosureLabel: 'DERIVATIVE · NOT SHARES',
    });
    expect(marketShareAttribution('SP500', 'hyperliquid').disclosureLabel)
      .toBe('DERIVATIVE · NOT INDEX OWNERSHIP');
    expect(marketShareAttribution('GOLD', 'hyperliquid').disclosureLabel)
      .toBe('DERIVATIVE · NOT SPOT');
    expect(marketShareAttribution('HYPE', 'hyperliquid')).toEqual({
      displayName: 'HYPE',
      providerLabel: 'HYPERLIQUID PERP',
      disclosureLabel: null,
    });
    expect(marketShareDescription('NVDA', 'hyperliquid'))
      .toContain('hyperliquid xyz perp (derivative · not shares)');
    expect(marketShareAttribution('TEST', 'simulation').providerLabel).toBe('SIMULATED DATA');
  });

  it('keeps the social-card dimensions and flips WebGL rows', () => {
    expect([POSTCARD_WIDTH, POSTCARD_HEIGHT]).toEqual([1_200, 675]);
    const source = new Uint8Array([
      1, 2, 3, 4, 5, 6, 7, 8,
      9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    expect([...flipRgbaRows(source, 2, 2)]).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16,
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(formatPostcardPrice(64_123.456)).toBe('$64,123.46');
    expect(formatPostcardPrice(null)).toBe('—');
    const pose = calculatePostcardCamera(
      new THREE.Vector3(12, 0, 8),
      new THREE.Vector3(0, 0, 0),
    );
    expect(pose.position.distanceTo(pose.target)).toBeGreaterThan(18);
    expect(pose.target.y).toBeGreaterThan(3);
  });
});
