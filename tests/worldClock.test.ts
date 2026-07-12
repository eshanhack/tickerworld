import { describe, expect, it } from 'vitest';
import { worldClockPresentation } from '../src/ui';

describe('world clock presentation', () => {
  it('formats the session-relative sun and moon clock with rain state', () => {
    expect(worldClockPresentation(12 * 60, 0, false)).toEqual({
      time: '12:00',
      icon: '☀',
      label: 'DAYLIGHT',
      night: false,
      raining: false,
    });
    expect(worldClockPresentation(0, 1, true)).toEqual({
      time: '00:00',
      icon: '☾',
      label: 'NIGHT · RAIN',
      night: true,
      raining: true,
    });
    expect(worldClockPresentation(1_501, 0.2, false).time).toBe('01:01');
  });
});
