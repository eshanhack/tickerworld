import { describe, expect, it } from 'vitest';
import { imageDimensions, jpegDimensions, pngDimensions } from '../scripts/smoke-helpers.mjs';

describe('production smoke helpers', () => {
  it('reads JPEG SOF dimensions and rejects non-images', () => {
    const card = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x11, 0x08,
      0x02, 0x76, // 630px high
      0x04, 0xb0, // 1200px wide
      0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
      0xff, 0xd9,
    ]);
    expect(jpegDimensions(card)).toEqual({ width: 1200, height: 630 });
    expect(jpegDimensions(new TextEncoder().encode('<html>fallback</html>'))).toBeNull();
  });

  it('reads PNG IHDR dimensions through the generic image helper', () => {
    const card = new Uint8Array(24);
    card.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    card.set([0x49, 0x48, 0x44, 0x52], 12);
    const view = new DataView(card.buffer);
    view.setUint32(16, 1200, false);
    view.setUint32(20, 630, false);
    expect(pngDimensions(card)).toEqual({ width: 1200, height: 630 });
    expect(imageDimensions(card)).toEqual({ width: 1200, height: 630 });
  });
});
