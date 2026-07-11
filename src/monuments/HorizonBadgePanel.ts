import {
  BoxGeometry,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  TorusGeometry,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Text } from 'troika-three-text';
import {
  PRICE_HORIZONS,
  type FeedMode,
  type HorizonChange,
  type PriceHorizon,
  type TickDirection,
} from '../types';
import { getCandleCountdown } from '../markets/horizons';

const COLORS = {
  ink: 0x31373d,
  cream: 0xfff1cf,
  green: 0x628f75,
  red: 0xa96868,
  flat: 0x77736c,
} as const;

const OVERLAY_LAYER = {
  card: 0,
  clock: 1,
  hand: 2,
  text: 3,
} as const;

export const HORIZON_BADGE_LAYOUT = {
  cardWidth: 1.9,
  cardHeight: 0.78,
  clockCenterX: -0.66,
  clockOuterRadius: 0.15,
  textStartX: -0.38,
  timeframeY: 0.18,
  changeY: -0.14,
  sideX: 8.35,
} as const;

const BADGE_POSITIONS: ReadonlyArray<readonly [number, number]> = [
  [-HORIZON_BADGE_LAYOUT.sideX, -0.68],
  [-HORIZON_BADGE_LAYOUT.sideX, -1.92],
  [-HORIZON_BADGE_LAYOUT.sideX, -3.16],
  [-HORIZON_BADGE_LAYOUT.sideX, -4.4],
  [HORIZON_BADGE_LAYOUT.sideX, -1.3],
  [HORIZON_BADGE_LAYOUT.sideX, -2.54],
  [HORIZON_BADGE_LAYOUT.sideX, -3.78],
];

interface BadgeVisual {
  readonly horizon: PriceHorizon;
  readonly root: Group;
  readonly card: Mesh<RoundedBoxGeometry, MeshBasicMaterial>;
  readonly changeText: Text;
  readonly secondHand: Mesh<BoxGeometry, MeshBasicMaterial>;
  readonly minuteHand: Mesh<BoxGeometry, MeshBasicMaterial>;
  readonly baseY: number;
  readonly phase: number;
}

function arrowFor(direction: TickDirection): string {
  if (direction === 'up') return '\u2191';
  if (direction === 'down') return '\u2193';
  return '\u2192';
}

function formatRatio(change: HorizonChange): string {
  if (change.changeRatio === null || !Number.isFinite(change.changeRatio)) {
    return '\u2014';
  }
  const percent = change.changeRatio * 100;
  const precision = Math.abs(percent) >= 10 ? 1 : 2;
  const sign = percent > 0 ? '+' : '';
  return `${arrowFor(change.direction)}  ${sign}${percent.toFixed(precision)}%`;
}

export class HorizonBadgePanel {
  readonly root = new Group();

  private readonly badges: BadgeVisual[] = [];
  private readonly texts = new Set<Text>();
  private readonly geometries = new Set<{ dispose(): void }>();
  private readonly materials = new Set<Material>();
  private readonly directionMaterials: Record<TickDirection, MeshBasicMaterial>;
  private readonly countdownText = new Text();
  private readonly countdownCard: Mesh<RoundedBoxGeometry, MeshBasicMaterial>;
  private lastCountdownText = '';
  private disposed = false;

  constructor(fontUrl?: string) {
    this.root.name = 'market-horizon-panel';

    const cardGeometry = new RoundedBoxGeometry(1, 1, 1, 2, 0.16);
    const clockGeometry = new TorusGeometry(0.12, 0.022, 5, 18);
    const secondHandGeometry = new BoxGeometry(0.018, 0.105, 0.018);
    const minuteHandGeometry = new BoxGeometry(0.025, 0.075, 0.022);
    secondHandGeometry.translate(0, -0.0525, 0);
    minuteHandGeometry.translate(0, -0.0375, 0);
    const clockMaterial = new MeshBasicMaterial({ color: COLORS.cream, toneMapped: false });
    this.directionMaterials = {
      up: new MeshBasicMaterial({ color: COLORS.green, toneMapped: false }),
      down: new MeshBasicMaterial({ color: COLORS.red, toneMapped: false }),
      flat: new MeshBasicMaterial({ color: COLORS.flat, toneMapped: false }),
    };
    const countdownMaterial = new MeshBasicMaterial({ color: COLORS.ink, toneMapped: false });
    for (const geometry of [cardGeometry, clockGeometry, secondHandGeometry, minuteHandGeometry]) {
      this.geometries.add(geometry);
    }
    for (const material of [clockMaterial, countdownMaterial, ...Object.values(this.directionMaterials)]) {
      this.materials.add(material);
    }

    PRICE_HORIZONS.forEach((horizon, index) => {
      const badge = new Group();
      badge.name = `horizon-badge-${horizon}`;
      const [badgeX, baseY] = BADGE_POSITIONS[index] ?? [0, -2.5];
      badge.position.set(badgeX, baseY, 0.03);

      const card = new Mesh(cardGeometry, this.directionMaterials.flat);
      card.name = `horizon-card-${horizon}`;
      card.scale.set(
        HORIZON_BADGE_LAYOUT.cardWidth,
        HORIZON_BADGE_LAYOUT.cardHeight,
        0.08,
      );
      card.renderOrder = OVERLAY_LAYER.card;
      badge.add(card);

      const clock = new Mesh(clockGeometry, clockMaterial);
      clock.name = `horizon-clock-${horizon}`;
      clock.position.set(HORIZON_BADGE_LAYOUT.clockCenterX, 0, 0.065);
      clock.renderOrder = OVERLAY_LAYER.clock;
      const secondHand = new Mesh(secondHandGeometry, clockMaterial);
      secondHand.name = `horizon-second-hand-${horizon}`;
      secondHand.position.set(HORIZON_BADGE_LAYOUT.clockCenterX, 0.045, 0.07);
      secondHand.renderOrder = OVERLAY_LAYER.hand;
      const minuteHand = new Mesh(minuteHandGeometry, clockMaterial);
      minuteHand.name = `horizon-minute-hand-${horizon}`;
      minuteHand.position.set(HORIZON_BADGE_LAYOUT.clockCenterX, 0.033, 0.072);
      minuteHand.renderOrder = OVERLAY_LAYER.hand;
      badge.add(clock, secondHand, minuteHand);

      const timeframeText = new Text();
      timeframeText.name = `horizon-timeframe-${horizon}`;
      timeframeText.text = horizon;
      timeframeText.fontSize = 0.15;
      timeframeText.color = COLORS.cream;
      timeframeText.anchorX = 'left';
      timeframeText.anchorY = 'middle';
      timeframeText.position.set(
        HORIZON_BADGE_LAYOUT.textStartX,
        HORIZON_BADGE_LAYOUT.timeframeY,
        0.07,
      );
      timeframeText.depthOffset = -4;
      timeframeText.renderOrder = OVERLAY_LAYER.text;

      const changeText = new Text();
      changeText.name = `horizon-change-${horizon}`;
      changeText.text = '\u2014';
      changeText.fontSize = 0.19;
      changeText.color = COLORS.cream;
      changeText.anchorX = 'left';
      changeText.anchorY = 'middle';
      changeText.position.set(
        HORIZON_BADGE_LAYOUT.textStartX,
        HORIZON_BADGE_LAYOUT.changeY,
        0.07,
      );
      changeText.depthOffset = -4;
      changeText.renderOrder = OVERLAY_LAYER.text;
      if (fontUrl) {
        timeframeText.font = fontUrl;
        changeText.font = fontUrl;
      }
      if (typeof self !== 'undefined') {
        timeframeText.sync();
        changeText.sync();
      }
      badge.add(timeframeText, changeText);
      this.texts.add(timeframeText);
      this.texts.add(changeText);
      this.root.add(badge);
      this.badges.push({
        horizon,
        root: badge,
        card,
        changeText,
        secondHand,
        minuteHand,
        baseY,
        phase: index * 0.87,
      });
    });

    this.countdownCard = new Mesh(cardGeometry, countdownMaterial);
    this.countdownCard.name = 'candle-countdown-card';
    this.countdownCard.scale.set(2.55, 0.68, 0.09);
    this.countdownCard.position.set(3.72, 0, 0.025);
    this.countdownCard.renderOrder = OVERLAY_LAYER.card;
    this.root.add(this.countdownCard);

    this.countdownText.name = 'candle-countdown-text';
    this.countdownText.text = 'NEXT  \u2014';
    this.countdownText.fontSize = 0.26;
    this.countdownText.color = COLORS.cream;
    this.countdownText.anchorX = 'center';
    this.countdownText.anchorY = 'middle';
    this.countdownText.position.set(3.72, 0, 0.08);
    this.countdownText.depthOffset = -4;
    this.countdownText.renderOrder = OVERLAY_LAYER.text;
    if (fontUrl) this.countdownText.font = fontUrl;
    if (typeof self !== 'undefined') this.countdownText.sync();
    this.root.add(this.countdownText);
    this.texts.add(this.countdownText);
  }

  setChanges(changes: readonly HorizonChange[]): void {
    if (this.disposed) return;
    const byHorizon = new Map(changes.map((change) => [change.horizon, change]));
    for (const badge of this.badges) {
      const change = byHorizon.get(badge.horizon) ?? {
        horizon: badge.horizon,
        referenceTime: null,
        referencePrice: null,
        changeRatio: null,
        direction: 'flat' as const,
      };
      const text = formatRatio(change);
      if (badge.changeText.text !== text) {
        badge.changeText.text = text;
        if (typeof self !== 'undefined') badge.changeText.sync();
      }
      badge.card.material = this.directionMaterials[change.direction];
    }
  }

  update(elapsedSeconds: number, now: number, mode: FeedMode): void {
    if (this.disposed) return;
    for (const badge of this.badges) {
      badge.root.position.y = badge.baseY + Math.sin(elapsedSeconds * 0.9 + badge.phase) * 0.045;
      badge.secondHand.rotation.z = -elapsedSeconds * Math.PI * 0.52 - badge.phase;
      badge.minuteHand.rotation.z = -elapsedSeconds * Math.PI * 0.075 - badge.phase * 0.3;
    }

    const nextText = mode === 'live' || mode === 'simulated'
      ? `NEXT CANDLE  ${getCandleCountdown(now).label}`
      : mode === 'reconnecting'
        ? 'CANDLE  PAUSED'
        : 'NEXT CANDLE  \u2014';
    if (nextText !== this.lastCountdownText) {
      this.lastCountdownText = nextText;
      this.countdownText.text = nextText;
      if (typeof self !== 'undefined') this.countdownText.sync();
    }
  }

  get badgeCount(): number {
    return this.badges.length;
  }

  get countdownLabel(): string {
    return this.lastCountdownText;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const text of this.texts) text.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.texts.clear();
    this.geometries.clear();
    this.materials.clear();
    this.badges.length = 0;
    this.root.clear();
  }
}
