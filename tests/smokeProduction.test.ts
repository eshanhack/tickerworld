import { describe, expect, it } from 'vitest';
import { jpegDimensions } from '../scripts/smoke-helpers.mjs';

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
});
