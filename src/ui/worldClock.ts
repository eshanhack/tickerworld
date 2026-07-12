export interface WorldClockPresentation {
  readonly time: string;
  readonly icon: '☀' | '☾';
  readonly label: string;
  readonly night: boolean;
  readonly raining: boolean;
}

export function worldClockPresentation(
  minutesSinceMidnight: number,
  nightFactor: number,
  raining: boolean,
): WorldClockPresentation {
  const safeMinutes = Number.isFinite(minutesSinceMidnight) ? minutesSinceMidnight : 0;
  const totalMinutes = Math.floor(((safeMinutes % 1_440) + 1_440) % 1_440);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const night = raining || (Number.isFinite(nightFactor) && nightFactor >= 0.5);
  return {
    time: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
    icon: night ? '☾' : '☀',
    label: raining ? 'NIGHT · RAIN' : night ? 'NIGHT' : 'DAYLIGHT',
    night,
    raining,
  };
}
