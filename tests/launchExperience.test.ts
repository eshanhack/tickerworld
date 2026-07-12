import { describe, expect, it, vi } from 'vitest';
import { ASSET_SYMBOLS } from '../src/types';
import { PREMIUM_SKINS } from '../shared/src/index.js';
import {
  baseWardrobeEntries,
  colorWardrobeEntries,
  chooseQualityTier,
  entryFeedStatusLabel,
  entryRoomStatusLabel,
  entryShellForMarket,
  freeWardrobeEntries,
  normalizeWardrobeUsername,
  OnboardingJourney,
  OverlayCoordinator,
  parseStoredQualityTier,
  qualityProfile,
} from '../src/ui';

describe('route-specific entry shell', () => {
  it('gives every market a truthful route-specific entry', () => {
    const models = ASSET_SYMBOLS.map(entryShellForMarket);
    expect(models).toHaveLength(8);
    for (const model of models) {
      expect(model.kicker).toBe(`${model.symbol} WORLD · LIVE`);
      expect(model.title).toBe('Tickerworld');
      expect(model.description).toBe(`Walk inside ${model.symbol}’s live one-minute chart with other tiny animals.`);
      expect(model.enterLabel).toBe(`Enter ${model.symbol} world`);
    }
  });

  it('keeps connection copy explicit rather than implying live data', () => {
    expect(entryFeedStatusLabel('connecting')).toBe('Market connecting');
    expect(entryFeedStatusLabel('reconnecting')).toBe('Market reconnecting');
    expect(entryRoomStatusLabel('offline')).toBe('Solo mode ready');
    expect(entryRoomStatusLabel('online')).toBe('Shared plaza online');
  });
});

describe('action-gated onboarding journey', () => {
  it('does not advance until real requirements for the current step are met', () => {
    const journey = new OnboardingJourney();
    expect(journey.snapshot.currentStep).toBe('identity');

    journey.record('move');
    journey.record('jump');
    expect(journey.snapshot.currentStep).toBe('identity');

    journey.record('identity');
    expect(journey.snapshot.currentStep).toBe('move-jump');
    journey.record('move');
    expect(journey.snapshot.currentStep).toBe('move-jump');
    journey.record('jump');
    expect(journey.snapshot.currentStep).toBe('glide');
    journey.record('glide');
    expect(journey.snapshot.currentStep).toBe('emote');
    journey.record('emote');
    expect(journey.snapshot.currentStep).toBe('portal-share');
    journey.record('share');
    expect(journey.snapshot).toMatchObject({ currentStep: null, completed: true, progress: 1 });
  });

  it('treats portal or completed sharing as the final discovery action', () => {
    for (const finalAction of ['portal', 'share'] as const) {
      const journey = new OnboardingJourney();
      for (const action of ['identity', 'move', 'jump', 'glide', 'emote'] as const) journey.record(action);
      journey.record(finalAction);
      expect(journey.snapshot.completed).toBe(true);
    }
  });

  it('emits only for newly observed actions', () => {
    const journey = new OnboardingJourney();
    const listener = vi.fn();
    journey.subscribe(listener);
    expect(journey.record('identity')).toBe(true);
    expect(journey.record('identity')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('launch overlay discipline', () => {
  it('allows only one large overlay while preserving compact emotes', () => {
    const coordinator = new OverlayCoordinator();
    coordinator.set('news', true);
    coordinator.set('emote', true);
    expect(coordinator.largeOwner).toBe('news');
    expect(coordinator.has('emote')).toBe(true);

    const transition = coordinator.set('wardrobe', true);
    expect(transition.displaced).toBe('news');
    expect(coordinator.largeOwner).toBe('wardrobe');
    expect(coordinator.has('news')).toBe(false);
  });

  it('lets share participate in the same modal ownership surface', () => {
    const coordinator = new OverlayCoordinator();
    coordinator.set('settings', true);
    expect(coordinator.set('share', true)).toMatchObject({ displaced: 'settings', largeOwner: 'share' });
    coordinator.set('share', false);
    expect(coordinator.largeOwner).toBeNull();
  });

  it('does not let shortcuts displace portal transfer or WebGL recovery', () => {
    const coordinator = new OverlayCoordinator();
    coordinator.set('portal', true);
    expect(coordinator.set('chat', true)).toMatchObject({ opened: null, largeOwner: 'portal' });
    expect(coordinator.has('chat')).toBe(false);

    expect(coordinator.set('context', true)).toMatchObject({ opened: 'context', displaced: 'portal' });
    expect(coordinator.set('share', true)).toMatchObject({ opened: null, largeOwner: 'context' });
    expect(coordinator.has('share')).toBe(false);
  });
});

describe('free launch wardrobe', () => {
  it('contains eight base creatures and all eight color looks without commerce metadata', () => {
    const entries = baseWardrobeEntries();
    expect(entries.map(({ animal }) => animal)).toEqual([
      'fox', 'penguin', 'frog', 'duck', 'bear', 'rabbit', 'cat', 'axolotl',
    ]);
    expect(entries.every(({ skin }) => skin === 'base')).toBe(true);
    const colors = colorWardrobeEntries();
    expect(colors.map(({ skin }) => skin).sort()).toEqual([...PREMIUM_SKINS].sort());
    expect(new Set(colors.map(({ animal }) => animal)).size).toBe(8);
    expect(freeWardrobeEntries()).toHaveLength(16);
    expect(freeWardrobeEntries().every((entry) => (
      !('price' in entry) && !('entitlement' in entry) && !('owned' in entry)
    ))).toBe(true);
  });

  it('normalizes a valid browser display name and rejects invalid characters or length', () => {
    expect(normalizeWardrobeUsername('  Magic_Fox  ')).toBe('Magic_Fox');
    expect(normalizeWardrobeUsername('ab')).toBeNull();
    expect(normalizeWardrobeUsername('two words')).toBeNull();
    expect(normalizeWardrobeUsername('ticker-world')).toBeNull();
  });
});

describe('genuine low quality tier', () => {
  it('selects low for phone-sized or resource-limited devices', () => {
    expect(chooseQualityTier({
      coarsePointer: true,
      devicePixelRatio: 3,
      viewportWidth: 430,
      deviceMemory: 8,
      hardwareConcurrency: 8,
    })).toBe('low');
    expect(chooseQualityTier({
      coarsePointer: false,
      devicePixelRatio: 1,
      viewportWidth: 1440,
      deviceMemory: 4,
      hardwareConcurrency: 8,
    })).toBe('low');
  });

  it('reduces scene work, not only display resolution', () => {
    const high = qualityProfile('high', 2.5);
    const low = qualityProfile('low', 2.5);
    expect(low.antialias).toBe(false);
    expect(low.shadows).toBe(false);
    expect(low.activeChunkRadius).toBeLessThan(high.activeChunkRadius);
    expect(low.chunkSegments).toBeLessThan(high.chunkSegments);
    expect(low.fireworkCapacity).toBeLessThan(high.fireworkCapacity);
    expect(low.pixelRatio).toBeLessThan(high.pixelRatio);
  });

  it('migrates the old numeric quality preference safely', () => {
    expect(parseStoredQualityTier('0.9')).toBe('low');
    expect(parseStoredQualityTier('1.5')).toBe('high');
    expect(parseStoredQualityTier('broken')).toBeNull();
  });
});
