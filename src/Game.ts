import * as THREE from 'three';
import nunitoFontUrl from '@fontsource/nunito/files/nunito-latin-700-normal.woff?url';
import { AudioEngine, MARKET_AUDIO_MAX_RADIUS, MARKET_MOVE_THRESHOLDS } from './audio';
import {
  DEBUG_MODE,
  FORCE_SIMULATION,
  GRAND_MONUMENTS,
  LAUNCH_CAPTURE_MODE,
  MULTIPLAYER_ALLOWED,
  PARKOUR_QA_MODE,
  WORLD_SEED,
} from './config';
import {
  HyperliquidMarketFeed,
  MarketCelebrationGate,
  type MarketCelebrationEvent,
  type MarketCelebrationTier,
} from './markets';
import { FireworkPool, Monument, MonumentSystem } from './monuments';
import {
  fetchRuntimeCapabilities,
  OFFLINE_RUNTIME_CAPABILITIES,
  readGuestAppearance,
  readGuestIdentity,
  RoomClientSystem,
  writeGuestAppearance,
  type GuestAppearance,
  type GuestIdentity,
  type RoomClientSnapshot,
} from './net';
import { BrowserNewsFeed, type NewsFeedMode, type NewsFeedUpdate } from './news';
import {
  OnlinePopulationBadgeView,
  PortalSystem,
  WorldChannelNavigatorView,
  type PortalRoute,
  type WorldChannelSelection,
  type WorldChannelSnapshot,
  type WorldConnectionState,
  type WorldPopulationSnapshot,
} from './portals';
import { FoxPlayer, ThirdPersonCamera, type FootstepEvent, type FoxActionEvent } from './player';
import {
  marketSlugForSymbol,
  type MarketRouteHistory,
} from './routing';
import type { AssetState, AssetSymbol } from './types';
import {
  MARKET_TRADE_CONFIG,
  TradeTapeFeed,
  coalesceTradeAudioOrders,
  tradeTierProgress,
  type TradeTapeBatch,
  type TradeTapeSnapshot,
  type TradeTier,
} from './trades';
import { TelemetrySystem } from './telemetry';
import {
  allocateSpawnAssignment,
  MARKET_ROOM_MAX_CLIENTS,
  type CompactMarketMid,
  type CorrectionMessage,
  type MarketSlug,
  type NetPlayerState,
  type ParkourCheckpointId,
  type RuntimeCapabilities,
} from '../shared/src/index.js';
import {
  capturePostcard,
  parsePartyToken,
  ShareSystem,
  withoutPartyToken,
  type PartyJoinStatus,
} from './share';
import { CanvasInteractionCoordinator } from './social/CanvasInteractionCoordinator';
import { EmoteVisualSystem } from './social/EmoteVisualSystem';
import { createEmoteNonce } from './social/emotes';
import { RemoteAvatarSystem } from './social/RemoteAvatarSystem';
import { SocialSystem, socialInteractionLocksMovement } from './social/SocialSystem';
import {
  chooseQualityTier,
  Hud,
  ParkourHudView,
  TradeDebugPanel,
  createParkourRunResult,
  parseStoredQualityTier,
  qualityProfile,
  UiInteractionLock,
  type QualityTier,
  type UiInteractionOwner,
} from './ui';
import {
  CyberpunkDexDistrict,
  DesertOilDistrict,
  OilWorldEffects,
  ParkourParkSystem,
  WorldGuard,
  WorldSystem,
  worldEnvironmentTheme,
  type ParkourEvent,
} from './world';

const COMPASS_KEY = 'tickerworld:v1:compass';
const QUALITY_KEY = 'tickerworld:v1:quality';
const REDUCED_MOTION_KEY = 'tickerworld:v1:reduced-motion';
const NEWS_RESUME_CLOCK_SKEW_GRACE_MS = 1_500;

export function countFreshNewsAdditions(
  added: readonly { readonly createdAt: number }[],
  createdAtCutoff: number,
): number {
  return added.reduce((count, item) => (
    Number.isFinite(item.createdAt) && item.createdAt >= createdAtCutoff ? count + 1 : count
  ), 0);
}

export interface GameOptions {
  readonly activeMarket?: AssetSymbol;
  readonly routeHistory?: MarketRouteHistory;
}

function safeWrite(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preferences are deliberately optional.
  }
}

function safeReadBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === 'true';
  } catch {
    return fallback;
  }
}

function safeReadString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export class Game {
  private readonly container: HTMLElement;
  private readonly scene = new THREE.Scene();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly world: WorldSystem;
  private readonly player: FoxPlayer;
  private readonly cameraRig: ThirdPersonCamera;
  private readonly market = new HyperliquidMarketFeed();
  private readonly tradeTape: TradeTapeFeed;
  private readonly news = new BrowserNewsFeed();
  private readonly telemetry = new TelemetrySystem();
  private readonly monuments: MonumentSystem;
  private readonly audio = new AudioEngine();
  private readonly fireworks: FireworkPool;
  private readonly oilEffects: OilWorldEffects;
  private readonly dexDistrict: CyberpunkDexDistrict;
  private readonly desertDistrict: DesertOilDistrict;
  private readonly parkour: ParkourParkSystem;
  private parkourHud?: ParkourHudView;
  private tradeDebugPanel?: TradeDebugPanel;
  private readonly celebrationGate = new MarketCelebrationGate();
  private readonly worldGuard = new WorldGuard();
  private readonly uiInteractionLock = new UiInteractionLock();
  private readonly portalSystem: PortalSystem;
  private readonly roomClient: RoomClientSystem;
  private readonly worldNavigator: WorldChannelNavigatorView;
  private readonly onlinePopulationBadge: OnlinePopulationBadgeView;
  private remoteAvatars?: RemoteAvatarSystem;
  private emotes?: EmoteVisualSystem;
  private social?: SocialSystem;
  private share?: ShareSystem;
  private canvasInteractions?: CanvasInteractionCoordinator;
  private readonly hud: Hud;
  private readonly routeHistory?: MarketRouteHistory;
  private readonly monumentIds = new Map<Monument, string>();
  private readonly latestStates = new Map<AssetSymbol, AssetState>();
  private readonly pendingRoomSpawns = new Map<MarketSlug, NetPlayerState>();
  private populationViewKey = '';
  private blockedActors: ReadonlySet<string> = new Set();
  private readonly clock = new THREE.Clock();
  private readonly tempPosition = new THREE.Vector3();
  private readonly newsCameraSpace = new THREE.Vector3();
  private readonly newsNdc = new THREE.Vector3();
  private readonly cameraTarget = new THREE.Vector3();
  private activeMarket: AssetSymbol;
  private activeMonument: Monument;
  private entered = false;
  private visible = true;
  private disposed = false;
  private frameHandle = 0;
  private marketSwitchGeneration = 0;
  private elapsed = 0;
  private worldElapsed = 0;
  private fps = 60;
  private fpsAccumulator = 0;
  private fpsFrames = 0;
  private qualityTimer = 0;
  private qualityTier: QualityTier;
  private pixelRatio: number;
  private compassEnabled = true;
  private reducedMotion = false;
  private newsMode: NewsFeedMode = 'connecting';
  private activeNewsCount = 0;
  private newsSoundCreatedAtCutoff = Number.NEGATIVE_INFINITY;
  private contextLost = false;
  private soloView = false;
  private guestAppearance: GuestAppearance;
  private activeDisplayUsername: string | null;
  private appearanceSyncKey: string | null = null;
  private runtimeCapabilities: RuntimeCapabilities = OFFLINE_RUNTIME_CAPABILITIES;
  private latestRelayMids: readonly CompactMarketMid[] = [];
  private readonly launchCaptureTimers: number[] = [];
  private latestTradeTapeSnapshot?: TradeTapeSnapshot;
  private readonly tradeTierTimes: Record<Exclude<TradeTier, 'dust'>, number[]> = {
    minor: [], notable: [], big: [], whale: [],
  };
  private lastTapeImbalanceSurgeAt = Number.NEGATIVE_INFINITY;
  private lastMinuteMoveSurgeAt = Number.NEGATIVE_INFINITY;

  constructor(container: HTMLElement, options: GameOptions = {}) {
    this.container = container;
    this.container.innerHTML = '';
    this.guestAppearance = readGuestAppearance();
    this.activeDisplayUsername = this.guestAppearance.username;
    this.activeMarket = options.activeMarket ?? 'BTC';
    this.tradeTape = new TradeTapeFeed({
      activeMarket: this.activeMarket,
      // The feed itself forces TEST into simulation. Keeping the constructor
      // override QA-only lets a session that starts in TEST recover to genuine
      // venue data after travelling to a live market.
      simulation: FORCE_SIMULATION,
      seed: `${WORLD_SEED}:trade-tape`,
    });
    this.routeHistory = options.routeHistory;
    document.title = `${this.activeMarket} World · Tickerworld`;
    const partyToken = parsePartyToken(location.hash);
    void this.market.setActiveMarket(this.activeMarket);
    this.news.setActiveMarket(this.activeMarket);
    this.telemetry.emitOnce({ name: 'landing_view', market: this.activeMarket });
    if (partyToken) this.telemetry.emitOnce({ name: 'party_link_activated', market: this.activeMarket });

    const coarsePointer = matchMedia('(pointer: coarse)').matches;
    const navigatorWithMemory = navigator as Navigator & { deviceMemory?: number };
    this.qualityTier = chooseQualityTier({
      coarsePointer,
      devicePixelRatio,
      viewportWidth: innerWidth,
      deviceMemory: navigatorWithMemory.deviceMemory,
      hardwareConcurrency: navigator.hardwareConcurrency,
    }, parseStoredQualityTier(safeReadString(QUALITY_KEY)));
    const launchQuality = qualityProfile(this.qualityTier, devicePixelRatio);
    safeWrite(QUALITY_KEY, this.qualityTier);
    this.renderer = new THREE.WebGLRenderer({
      antialias: launchQuality.antialias,
      alpha: false,
      powerPreference: launchQuality.powerPreference,
    });
    this.renderer.setSize(innerWidth, innerHeight);
    this.pixelRatio = launchQuality.pixelRatio;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.shadowMap.enabled = launchQuality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.domElement.setAttribute('aria-label', 'Tickerworld 3D game world');
    this.container.append(this.renderer.domElement);

    this.reducedMotion = safeReadBoolean(
      REDUCED_MOTION_KEY,
      matchMedia('(prefers-reduced-motion: reduce)').matches,
    );
    this.camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.08, 360);
    this.cameraRig = new ThirdPersonCamera({
      camera: this.camera,
      domElement: this.renderer.domElement,
      yaw: 0,
      pitch: 0.28,
      startAtMaxDistance: true,
      reducedMotion: this.reducedMotion,
    });

    this.monuments = new MonumentSystem({
      parent: this.scene,
      camera: this.camera,
      domElement: this.renderer.domElement,
      fontUrl: nunitoFontUrl,
      reducedMotion: this.reducedMotion,
      attachInteractionListeners: false,
    });
    this.world = new WorldSystem(this.scene, {
      seed: WORLD_SEED,
      activeMarket: this.activeMarket,
      reducedMotion: this.reducedMotion,
      monuments: GRAND_MONUMENTS,
      echoSuppressionRadius: Number.POSITIVE_INFINITY,
      activeRadius: launchQuality.activeChunkRadius,
      chunkSegments: launchQuality.chunkSegments,
      loadBudgetPerUpdate: this.qualityTier === 'low' ? 1 : 3,
      unloadBudgetPerUpdate: this.qualityTier === 'low' ? 2 : 4,
      onThunder: (intensity) => this.audio.playThunder(intensity),
      onVegetationInteraction: (event) => this.audio.playVegetationRustle({
        kind: event.kind,
        intensity: Math.min(1, event.intensity * (0.55 + event.speed * 0.08)),
      }),
    });
    this.dexDistrict = new CyberpunkDexDistrict({
      parent: this.scene,
      seed: WORLD_SEED,
      heightAt: (x, z) => this.world.heightAt(x, z),
      fontUrl: nunitoFontUrl,
      activeMarket: this.activeMarket,
      reducedMotion: this.reducedMotion,
    });
    this.desertDistrict = new DesertOilDistrict({
      parent: this.scene,
      seed: WORLD_SEED,
      heightAt: (x, z) => this.world.heightAt(x, z),
      activeMarket: this.activeMarket,
      reducedMotion: this.reducedMotion,
    });
    this.fireworks = new FireworkPool({
      capacity: launchQuality.fireworkCapacity,
      reducedMotion: this.reducedMotion,
    });
    this.scene.add(this.fireworks.points);
    this.oilEffects = new OilWorldEffects({
      parent: this.scene,
      heightAt: (x, z) => this.world.heightAt(x, z),
      reducedMotion: this.reducedMotion,
      onJetFlyby: (position, intensity) => this.audio.playJetFlyby(position, intensity),
      onExplosion: (position, intensity) => this.audio.playDistantExplosion(position, intensity),
    });
    this.oilEffects.setActiveMarket(this.activeMarket);
    this.parkour = new ParkourParkSystem({
      parent: this.scene,
      heightAt: (x, z) => this.world.heightAt(x, z),
      fontUrl: nunitoFontUrl,
      reducedMotion: this.reducedMotion,
      onEvent: (event) => this.onParkourEvent(event),
      onRespawnRequested: (point) => {
        const connection = this.roomClient?.state.connection ?? 'offline';
        if (connection === 'online') {
          const checkpointId = point.checkpointId as ParkourCheckpointId;
          if (!this.roomClient.requestParkourRespawn(checkpointId)) return false;
        } else if (connection !== 'offline') {
          // Do not create a client-only teleport while an authoritative room
          // may recover and disagree with it.
          return false;
        }
        this.player.setPosition(point.x, point.y, point.z);
        this.player.setHeadingYaw(point.yaw);
        return true;
      },
    });
    this.parkour.setVisualTheme(worldEnvironmentTheme(this.activeMarket));

    const spawnZ = 21;
    this.player = new FoxPlayer({
      spawn: new THREE.Vector3(0, this.world.heightAt(0, spawnZ), spawnZ),
      reducedMotion: this.reducedMotion,
    });
    this.player.input.setEnabled(false);
    this.scene.add(this.player.group);
    const guestIdentity = readGuestIdentity();
    this.roomClient = new RoomClientSystem({
      // QA seeds intentionally alter terrain. Keep them local so authoritative
      // movement validation never compares the player with tickerworld-v1.
      endpoint: MULTIPLAYER_ALLOWED && !PARKOUR_QA_MODE ? undefined : '',
      identity: guestIdentity,
      snapshot: () => {
        const playerState = this.player.snapshot;
        const locomotion = this.player.getMotionDebugSnapshot().locomotionState;
        return {
          x: playerState.x,
          y: playerState.y,
          z: playerState.z,
          yaw: this.player.headingYaw,
          speed: playerState.speed,
          verticalSpeed: playerState.verticalSpeed,
          grounded: playerState.grounded,
          gait: this.player.isGliding
            ? 'glide'
            : !playerState.grounded
              ? 'air'
              : locomotion === 'run'
                ? 'run'
                : locomotion === 'walk'
                  ? 'walk'
                  : 'idle',
        };
      },
      onCorrection: (correction) => this.applyRoomCorrection(correction),
      onSpawn: (market, player) => this.onRoomSpawn(market, player),
      onChatRejected: (rejection) => {
        this.hud?.showToast(rejection.code === 'rate_limited'
          ? 'A gentle pause before the next message.'
          : 'That message could not be shared.');
      },
      onReportAccepted: () => this.hud?.showToast('Report received. Thank you.'),
      onReportRejected: (rejection) => this.hud?.showToast(
        rejection.code === 'persistence_failed'
          ? 'The report could not be saved. Please try again.'
          : 'That report could not be sent.',
      ),
      onIdentityRefreshRejected: () => this.hud?.showToast(
        'Your room identity could not refresh. Your account remains safe.',
      ),
      onIdentityChanged: (identity) => this.onRoomIdentityChanged(identity),
      onEmote: (event) => this.emotes?.trigger(event),
      onPartyJoinStatus: (status) => this.onPartyJoinStatus(status),
      partyToken,
    });
    this.placeAtSpawn(this.activeMarket);

    this.activeMonument = this.monuments.add({
      symbol: this.activeMarket,
      kind: 'grand',
      position: { x: 0, y: this.world.heightAt(0, 0), z: 0 },
      scale: 1.25,
      initialState: this.market.getState(this.activeMarket),
    });
    this.monumentIds.set(this.activeMonument, `grand:${this.activeMarket}`);
    const initialHorizonPanel = this.activeMonument.root.getObjectByName('market-horizon-panel');
    if (initialHorizonPanel) initialHorizonPanel.visible = false;
    if (LAUNCH_CAPTURE_MODE) {
      const marketUi = this.activeMonument.root.getObjectByName(`${this.activeMarket}-market-ui`);
      if (marketUi) marketUi.visible = false;
    }
    this.player.setAnimal(this.guestAppearance.animal, this.guestAppearance.skin);

    this.hud = new Hud(this.container, {
      onEnter: () => this.enter(),
      onMuteToggle: () => this.audio.toggleMute(),
      onVolumeChange: (value) => this.audio.setVolume(value),
      onMusicMuteToggle: () => this.audio.toggleMusicMuted(),
      onMusicVolumeChange: (value) => this.audio.setMusicVolume(value),
      onSfxMuteToggle: () => this.audio.toggleSfxMuted(),
      onSfxVolumeChange: (value) => this.audio.setSfxVolume(value),
      onMarketMuteToggle: () => this.audio.toggleMarketMuted(),
      onMarketVolumeChange: (value) => this.audio.setMarketVolume(value),
      onTradeMuteToggle: () => this.audio.toggleTradeMuted(),
      onTradeVolumeChange: (value) => this.audio.setTradeVolume(value),
      onWeatherMuteToggle: () => this.audio.toggleWeatherMuted(),
      onWeatherVolumeChange: (value) => this.audio.setWeatherVolume(value),
      onMovementMuteToggle: () => this.audio.toggleMovementMuted(),
      onMovementVolumeChange: (value) => this.audio.setMovementVolume(value),
      onNewsDismiss: (itemId) => this.monuments.dismissNewsOverlay(itemId),
      onNewsInteractionChange: (active) => this.setUiInteraction('news', active),
      onAppearanceSelect: (animal, skin) => this.updateGuestAppearance({
        ...this.guestAppearance,
        animal,
        skin,
      }),
      onDisplayUsernameChange: (username) => this.updateGuestAppearance({
        ...this.guestAppearance,
        username,
      }),
      onEmoteRequest: (kind) => {
        const networkNonce = this.roomClient.sendEmote(kind);
        const nonce = networkNonce ?? createEmoteNonce();
        const played = this.emotes?.trigger({
          actorId: this.roomClient.identity.actorId,
          kind,
          nonce,
        }) ?? false;
        if (!networkNonce) this.hud?.showToast('Solo emote — other players will see new emotes once the room is online.');
        if (!played) return false;
        this.telemetry.emit({ name: 'emote_used', market: this.activeMarket, action: kind });
        return true;
      },
      onUiInteractionChange: (owner, active) => this.setUiInteraction(owner, active),
      onLargeOverlayOpen: (owner) => this.closeCompetingOverlays(owner),
      onContextRetry: () => location.reload(),
      onCompassToggle: (enabled) => {
        this.compassEnabled = enabled;
        safeWrite(COMPASS_KEY, String(enabled));
      },
      onReducedMotionToggle: (enabled) => {
        this.reducedMotion = enabled;
        this.player.setReducedMotion(enabled);
        this.cameraRig.setReducedMotion(enabled);
        this.fireworks.setReducedMotion(enabled);
        this.world.setReducedMotion(enabled);
        this.oilEffects.setReducedMotion(enabled);
        this.dexDistrict.setReducedMotion(enabled);
        this.desertDistrict.setReducedMotion(enabled);
        this.parkour.setReducedMotion(enabled);
        this.emotes?.setReducedMotion(enabled);
        this.portalSystem?.setReducedMotion(enabled);
        this.monuments.setReducedMotion(enabled);
        safeWrite(REDUCED_MOTION_KEY, String(enabled));
      },
      onVirtualInput: (x, forward, sprint) => this.player.setVirtualInput(x, forward, sprint),
      onJump: () => this.player.requestJump(),
      onGlideChange: (held) => this.player.setGlideHeld(held),
    }, {
      activeMarket: this.activeMarket,
      initialAnimal: this.guestAppearance.animal,
      initialSkin: this.guestAppearance.skin,
      initialUsername: this.guestAppearance.username,
    });

    try {
      this.compassEnabled = localStorage.getItem(COMPASS_KEY) !== 'false';
    } catch {
      this.compassEnabled = true;
    }
    this.hud.setCompassEnabled(this.compassEnabled);
    this.hud.setReducedMotion(this.reducedMotion);
    this.worldNavigator = new WorldChannelNavigatorView(
      this.hud.mountLayer('tickerworld-world-navigator-layer'),
      {
        activeMarket: this.activeMarket,
        canOpen: () => this.entered
          && !this.contextLost
          && !this.uiInteractionLock.has('portal'),
        onOpenChange: (open) => this.setWorldNavigatorOpen(open),
        onTravel: (selection) => this.quickTravel(selection),
      },
    );
    this.onlinePopulationBadge = new OnlinePopulationBadgeView(
      this.hud.mountLayer('tickerworld-online-population-layer'),
      { onBrowseWorlds: () => this.worldNavigator.open() },
    );
    this.parkourHud = new ParkourHudView(this.hud.mountLayer('tickerworld-parkour-layer'), {
      onQuit: () => this.parkour.quitRun(),
    });
    if (DEBUG_MODE) {
      this.tradeDebugPanel = new TradeDebugPanel(
        this.hud.mountLayer('tickerworld-trade-debug-layer'),
        {
          onOrder: (side, tier) => this.tradeTape.injectDebugOrder(side, tier),
          onSurge: (side) => this.triggerDebugTradeSurge(side),
        },
      );
    }
    this.portalSystem = new PortalSystem({
      parent: this.scene,
      activeMarket: this.activeMarket,
      fontUrl: nunitoFontUrl,
      heightAt: (x, z) => this.world.heightAt(x, z),
      overlayParent: this.container,
      reducedMotion: this.reducedMotion,
      onPortalChime: (route, stage) => {
        this.audio.playPortalChime(stage);
        if (stage === 'start') void this.market.prefetchMarket(route.destination);
      },
      onTravelRequested: (route) => this.travelThroughPortal(route),
    });
    // Keep the entry camera focused on the active monument and character. The
    // travel ring arrives only after the player deliberately enters.
    this.portalSystem.setVisible(false);

    this.remoteAvatars = new RemoteAvatarSystem({
      parent: this.scene,
      camera: this.camera,
      fontUrl: nunitoFontUrl,
      localPosition: () => this.player.position,
      localNameplate: {
        actorId: this.roomClient.identity.actorId,
        animal: () => this.player.animal,
        username: this.guestAppearance.username,
      },
      viewport: () => {
        const bounds = this.renderer.domElement.getBoundingClientRect();
        return {
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
          height: bounds.height,
        };
      },
      occlusionBounds: () => {
        const bounds = this.renderer.domElement.getBoundingClientRect();
        const chart = this.monuments.getChartOcclusionBounds({
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
          height: bounds.height,
        });
        return chart ? [chart] : [];
      },
    });
    if (LAUNCH_CAPTURE_MODE) this.remoteAvatars.setLabelsVisible(false);
    this.emotes = new EmoteVisualSystem({
      parent: this.scene,
      reducedMotion: this.reducedMotion,
      resolveActor: (actorId) => {
        if (actorId === this.roomClient.identity.actorId) return this.player.position;
        return this.roomClient.state.remotes.find((player) => player.actorId === actorId) ?? null;
      },
    });
    this.social = new SocialSystem({
      root: this.hud.mountLayer('tickerworld-social-layer'),
      transport: this.roomClient,
      localActorId: this.roomClient.identity.actorId,
      onInputFocusChange: (focused) => {
        if (focused) this.player.input.clear();
      },
      onInteractionChange: (owner, active) => {
        if (socialInteractionLocksMovement(owner)) return this.setUiInteraction(owner, active);
        return !active || (!this.uiInteractionLock.has('context') && !this.uiInteractionLock.has('portal'));
      },
      onSpeech: (message) => this.remoteAvatars?.showSpeech(message),
      onBlocksChanged: (blocked) => {
        this.blockedActors = new Set(blocked);
        this.remoteAvatars?.setBlockedActors(blocked);
        this.emotes?.setBlockedActors(blocked);
        this.populationViewKey = '';
        this.refreshPopulationViews(this.roomClient.state);
      },
      onSoloViewChange: (active) => this.setSoloView(active),
    });
    this.share = new ShareSystem({
      root: this.hud.mountLayer('tickerworld-share-layer'),
      context: () => {
        const state = this.market.getState(this.activeMarket);
        return {
          symbol: this.activeMarket,
          price: state.price,
          provider: state.provider,
          url: location.href,
          roomEpoch: this.roomClient.sessionRoomEpoch,
        };
      },
      party: this.roomClient,
      capturePostcard: (partyUrl) => capturePostcard({
        renderer: this.renderer,
        scene: this.scene,
        camera: this.camera,
        frame: {
          player: this.player.position,
          shrine: this.activeMonument.root.getWorldPosition(new THREE.Vector3()),
        },
        metadata: {
          market: this.activeMarket,
          price: this.market.getState(this.activeMarket).price,
          provider: this.market.getState(this.activeMarket).provider,
          capturedAt: Date.now(),
          partyUrl,
        },
        beforeCapture: () => {
          const remoteVisibility = this.remoteAvatars?.root.visible ?? false;
          this.remoteAvatars?.setVisible(false);
          return () => this.remoteAvatars?.setVisible(remoteVisibility);
        },
      }),
      onInteractionChange: (active) => {
        if (active && (this.uiInteractionLock.has('context') || this.uiInteractionLock.has('portal'))) {
          return false;
        }
        this.setUiInteraction('share', active);
        return true;
      },
      onShareComplete: (output, mode) => {
        this.markShareComplete();
        this.telemetry.emit({
          name: output === 'party-invite' ? 'invite_created' : 'share_completed',
          market: this.activeMarket,
          action: `${output}:${mode}`,
        });
      },
    });
    this.canvasInteractions = new CanvasInteractionCoordinator({
      element: this.renderer.domElement,
      activateNewsAt: (x, y) => this.monuments.activateNewsAt(x, y),
      pickPlayerAt: (x, y) => this.remoteAvatars?.pickAt(x, y, this.renderer.domElement) ?? null,
      openPlayerCard: (player) => this.social?.openPlayerCard(player),
    });
    this.roomClient.subscribe((state) => this.onRoomClientState(state));
    this.roomClient.subscribeChat((message) => {
      this.social?.acceptChat(message);
      if (message.actorId === this.roomClient.identity.actorId) {
        this.telemetry.emit({ name: 'chat_used', market: this.activeMarket });
      }
    });
    this.roomClient.subscribeChatRejected((rejection) => this.social?.acceptChatRejection(rejection));
    this.roomClient.subscribeReportAccepted(() => this.social?.acceptReportAccepted());
    this.roomClient.subscribeReportRejected((rejection) => this.social?.acceptReportRejection(rejection));
    this.roomClient.subscribeMarketMids((mids) => { this.latestRelayMids = mids; });
    this.roomClient.subscribeMarket((state) => {
      this.market.acceptRelayState(state, this.latestRelayMids);
    });

    this.audio.subscribe((state) => {
      this.hud.setMusicMuted(state.musicMuted);
      this.hud.setMusicVolume(state.musicVolume);
      this.hud.setSfxMuted(state.sfxMuted);
      this.hud.setSfxVolume(state.sfxVolume);
      this.hud.setMarketMuted(state.marketMuted);
      this.hud.setMarketVolume(state.marketVolume);
      this.hud.setTradeMuted(state.tradeMuted);
      this.hud.setTradeVolume(state.tradeVolume);
      this.hud.setWeatherMuted(state.weatherMuted);
      this.hud.setWeatherVolume(state.weatherVolume);
      this.hud.setMovementMuted(state.movementMuted);
      this.hud.setMovementVolume(state.movementVolume);
      if (state.status === 'resume-failed') this.hud.showToast('Tap the music button to wake the sound.');
    });

    this.market.subscribe((state) => this.onMarketState(state));
    this.tradeTape.subscribe((batch) => this.onTradeTapeBatch(batch));
    this.tradeTape.subscribeState((state) => {
      const previous = this.latestTradeTapeSnapshot;
      if (
        previous
        && (
          previous.symbol !== state.symbol
          || (previous.mode === 'simulated') !== (state.mode === 'simulated')
        )
      ) {
        for (const history of Object.values(this.tradeTierTimes)) history.length = 0;
      }
      this.latestTradeTapeSnapshot = state;
    });
    this.news.subscribe((update) => this.onNewsUpdate(update));
    this.refreshAudioSources();
    this.audio.updateProximityPosition(this.player.position);
    this.prewarmWorld();
    this.cameraRig.setChaseMotion(
      this.player.headingYaw,
      this.player.normalizedSpeed,
      this.player.chaseRecenterWeight,
    );
    this.cameraTarget.copy(this.player.position);
    this.cameraRig.update(0, this.cameraTarget, (x, z) => this.world.heightAt(x, z));
    this.hud.setEnterReady(true);
    this.telemetry.emitOnce({ name: 'game_ready', market: this.activeMarket });

    addEventListener('resize', this.resize);
    addEventListener('focus', this.focus);
    document.addEventListener('visibilitychange', this.visibility);
    addEventListener('beforeunload', this.dispose);
    this.renderer.domElement.addEventListener('webglcontextlost', this.webglContextLost);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.webglContextRestored);
    this.container.addEventListener('tickerworld:share-complete', this.shareCompleteEvent);

    void this.market.start();
    this.tradeTape.start();
    void this.news.start();
    void this.roomClient.connect(marketSlugForSymbol(this.activeMarket));
    void this.refreshRuntimeCapabilities();
    this.clock.start();
    if (DEBUG_MODE) {
      Object.defineProperty(window, '__tickerworldDebug', {
        value: {
          scene: this.scene,
          renderer: this.renderer,
          camera: this.camera,
          cameraRig: this.cameraRig,
          player: this.player,
          world: this.world,
          market: this.market,
          tradeTape: this.tradeTape,
          news: this.news,
          monuments: this.monuments,
          audio: this.audio,
          roomClient: this.roomClient,
          fireworks: this.fireworks,
          oilEffects: this.oilEffects,
          triggerLargeUp: () => this.triggerDebugMarketEvent('up', 'large'),
          triggerExceptionalUp: () => this.triggerDebugMarketEvent('up', 'exceptional'),
          triggerLargeDown: () => this.triggerDebugMarketEvent('down', 'large'),
          triggerExceptionalDown: () => this.triggerDebugMarketEvent('down', 'exceptional'),
          triggerTradeOrder: (side: 'buy' | 'sell', tier: Exclude<TradeTier, 'dust'>) => (
            this.tradeTape.injectDebugOrder(side, tier)
          ),
          triggerTradeSurge: (side: 'buy' | 'sell') => this.triggerDebugTradeSurge(side),
        },
        configurable: true,
      });
    }
    if (LAUNCH_CAPTURE_MODE) {
      this.cameraRig.setOrbit(this.player.headingYaw, -0.1, 12.5);
      void this.enter();
    }
    this.frameHandle = requestAnimationFrame(this.frame);
  }

  private async enter(): Promise<void> {
    if (this.entered) return;
    this.entered = true;
    this.player.input.setEnabled(!this.uiInteractionLock.locked);
    this.hud.setEntered();
    this.portalSystem.setVisible(this.visible && !LAUNCH_CAPTURE_MODE);
    this.telemetry.emitOnce({ name: 'entry', market: this.activeMarket });
    if (LAUNCH_CAPTURE_MODE) {
      for (const delay of [260, 1_080, 1_900]) {
        this.launchCaptureTimers.push(window.setTimeout(
          () => this.triggerDebugMarketEvent('up', 'exceptional'),
          delay,
        ));
      }
      this.launchCaptureTimers.push(
        window.setTimeout(() => this.player.setVirtualInput(0.16, 0.72, false), 320),
        window.setTimeout(() => this.player.setVirtualInput(0, 0, false), 2_550),
        window.setTimeout(() => this.emotes?.trigger({
          actorId: this.roomClient.identity.actorId,
          kind: 'wave',
          nonce: 'launch-capture-wave',
        }), 3_050),
        window.setTimeout(() => this.emotes?.trigger({
          actorId: this.roomClient.identity.actorId,
          kind: 'sparkle-heart',
          nonce: 'launch-capture-heart',
        }), 4_350),
        window.setTimeout(() => this.emotes?.trigger({
          actorId: this.roomClient.identity.actorId,
          kind: 'cheer',
          nonce: 'launch-capture-cheer',
        }), 5_250),
      );
    }
    const audioReady = await this.audio.unlock();
    if (!audioReady && !this.audio.state.available) {
      this.hud.showToast('Sound is unavailable here, but the world is still yours.');
    } else {
      this.hud.showToast('Wander slowly—markets can be heard before they are seen.');
    }
  }

  public get marketSymbol(): AssetSymbol {
    return this.activeMarket;
  }

  public async switchMarket(
    destination: AssetSymbol,
    previousMarket = this.activeMarket,
    selectedChannelRoomId: string | null = null,
    forceMatchmaking = false,
  ): Promise<boolean> {
    if (this.disposed) return false;
    const originMarket = this.activeMarket;
    const releasePortalLock = this.acquireUiInteraction('portal');
    const switchGeneration = ++this.marketSwitchGeneration;
    try {
      const destinationSlug = marketSlugForSymbol(destination);
      if (destination === this.activeMarket
        && this.roomClient.state.market === destinationSlug
        && (selectedChannelRoomId
          ? selectedChannelRoomId === this.roomClient.state.currentRoomId
          : !forceMatchmaking)) {
        this.portalSystem.cancelTravel();
        return true;
      }

      this.portalSystem.beginTransfer(destination);
      // Keep the old world behind the loading veil until matchmaking has either
      // joined the destination room or returned control to its reconnect path. This
      // prevents movement in a new world while the client is still in the old
      // room and keeps browser history travel consistent with physical portals.
      const channelResult = selectedChannelRoomId
        ? await this.roomClient.switchChannel(destinationSlug, selectedChannelRoomId)
        : null;
      if (!selectedChannelRoomId) await this.roomClient.switchMarket(destinationSlug);
      if (this.disposed || switchGeneration !== this.marketSwitchGeneration) return false;
      if (destination === this.activeMarket) {
        this.portalSystem.cancelTravel();
        this.refreshPopulationViews(this.roomClient.state);
        if (channelResult?.status === 'fallback') {
          const channel = this.roomClient.state.currentChannel?.channel;
          this.hud.showToast(channel
            ? `That channel filled up — joined Channel ${channel}.`
            : 'That channel filled up — joined the best open channel.');
        } else if (channelResult?.status === 'offline') {
          this.hud.showToast('The shared room is reconnecting.');
        } else if (channelResult?.status === 'joined') {
          const channel = this.roomClient.state.currentChannel?.channel;
          if (channel) this.hud.showToast(`Channel ${channel}`);
        }
        return true;
      }
      await this.market.setActiveMarket(destination);
      this.tradeTape.setActiveMarket(destination);
      this.lastTapeImbalanceSurgeAt = Number.NEGATIVE_INFINITY;
      this.lastMinuteMoveSurgeAt = Number.NEGATIVE_INFINITY;
      for (const history of Object.values(this.tradeTierTimes)) history.length = 0;
      this.news.setActiveMarket(destination);
      if (this.disposed || switchGeneration !== this.marketSwitchGeneration) return false;
      this.world.setActiveMarket(destination);
      this.dexDistrict.setActiveMarket(destination);
      this.desertDistrict.setActiveMarket(destination);
      this.parkour.setVisualTheme(worldEnvironmentTheme(destination));
      this.monuments.clearBigOrders();
      this.world.clearTradeSurge();
      this.monuments.remove(this.activeMonument, true);
      this.monumentIds.delete(this.activeMonument);
      this.activeMarket = destination;
      document.title = `${destination} World · Tickerworld`;
      this.activeMonument = this.monuments.add({
        symbol: destination,
        kind: 'grand',
        position: { x: 0, y: this.world.heightAt(0, 0), z: 0 },
        scale: 1.25,
        initialState: this.market.getState(destination),
      });
      this.monumentIds.set(this.activeMonument, `grand:${destination}`);
      const horizonPanel = this.activeMonument.root.getObjectByName('market-horizon-panel');
      if (horizonPanel) horizonPanel.visible = false;
      if (LAUNCH_CAPTURE_MODE) {
        const marketUi = this.activeMonument.root.getObjectByName(`${destination}-market-ui`);
        if (marketUi) marketUi.visible = false;
      }
      this.hud.setActiveMarket(destination);
      this.worldNavigator.setActiveMarket(destination);
      const destinationState = this.market.getState(destination);
      const roomConnection = this.roomClient.state.connection;
      this.hud.setEntryStatus(
        destinationState.mode,
        roomConnection === 'online'
          ? 'online'
          : roomConnection === 'connecting' || roomConnection === 'reconnecting'
            ? 'connecting'
            : 'offline',
      );
      this.portalSystem.setActiveMarket(destination);
      this.oilEffects.setActiveMarket(destination);
      this.parkour.resetRun();

      this.placeAtSpawn(destination, previousMarket);
      this.refreshPopulationViews(this.roomClient.state);
      this.refreshAudioSources();
      this.audio.updateProximityPosition(this.player.position);
      this.hud.showToast(`${destination} world`);
      if (channelResult?.status === 'fallback') {
        const channel = this.roomClient.state.currentChannel?.channel;
        this.hud.showToast(channel
          ? `Selected channel filled up — joined Channel ${channel}.`
          : 'Selected channel filled up — joined the best open channel.');
      } else if (channelResult?.status === 'offline') {
        this.hud.showToast('Travel complete. The shared room is reconnecting.');
      }
      if (destination !== originMarket) this.hud.recordOnboardingAction('portal');
      if (destination !== originMarket) {
        this.telemetry.emit({ name: 'portal_completed', market: destination });
      }
      return true;
    } finally {
      releasePortalLock();
      this.refreshInputLock();
    }
  }

  private async travelThroughPortal(route: PortalRoute): Promise<void> {
    if (route.activeMarket !== this.activeMarket) return;
    const previous = this.activeMarket;
    if (await this.switchMarket(route.destination, previous)) {
      this.routeHistory?.push(route.destination);
    }
  }

  private async quickTravel(selection: WorldChannelSelection): Promise<boolean> {
    const previous = this.activeMarket;
    const travelled = await this.switchMarket(
      selection.symbol,
      previous,
      selection.channelId,
      selection.channelId === null,
    );
    if (travelled && selection.symbol !== previous) this.routeHistory?.push(selection.symbol);
    return travelled;
  }

  private setSoloView(active: boolean): void {
    if (this.disposed || this.soloView === active) return;
    this.soloView = active;
    this.remoteAvatars?.setRemotePlayersVisible(!active);
    this.emotes?.setVisible(this.visible && !active);
    this.populationViewKey = '';
    this.refreshPopulationViews(this.roomClient.state);
    this.hud.showToast(active
      ? 'Solo mode on — other players and their chat are hidden.'
      : 'Back in the shared world.');
  }

  private setWorldNavigatorOpen(open: boolean): boolean {
    if (open) {
      if (this.uiInteractionLock.has('context') || this.uiInteractionLock.has('portal')) return false;
      this.share?.close();
      this.social?.setVisible(false);
      this.onlinePopulationBadge?.collapse();
      void this.roomClient.refreshPopulations();
    } else {
      this.social?.setVisible(this.visible);
    }
    return this.setUiInteraction('worlds', open);
  }

  private setUiInteraction(owner: UiInteractionOwner, active: boolean): boolean {
    if (active
      && owner !== 'context'
      && (this.uiInteractionLock.has('context')
        || (owner !== 'portal' && this.uiInteractionLock.has('portal')))) {
      return false;
    }
    if (active && owner === 'share') {
      this.social?.setVisible(false);
      this.social?.setVisible(this.visible);
    } else if (active && (owner === 'chat' || owner === 'player')) {
      this.share?.close();
    }
    this.uiInteractionLock.set(owner, active);
    this.hud?.setExternalOverlayOpen(owner, active);
    if (!active && owner === 'context' && this.uiInteractionLock.has('portal')) {
      this.hud?.setExternalOverlayOpen('portal', true);
    }
    this.refreshInputLock();
    return true;
  }

  /** Shared modal hook for independently-owned launch UI such as sharing. */
  public setOverlayOpen(owner: UiInteractionOwner, active: boolean): boolean {
    return this.setUiInteraction(owner, active);
  }

  public markShareComplete(): void {
    this.hud.recordOnboardingAction('share');
  }

  private onPartyJoinStatus(status: PartyJoinStatus): void {
    this.share?.setPartyJoinStatus(status);
    try {
      const cleaned = withoutPartyToken(location.href);
      if (cleaned !== location.href) history.replaceState(history.state, '', cleaned);
    } catch {
      // Hash cleanup is cosmetic; a successful/fallback room join remains valid.
    }
  }

  private closeCompetingOverlays(owner: UiInteractionOwner): void {
    if (owner !== 'share') this.share?.close();
    if (owner !== 'chat' && owner !== 'player') {
      this.social?.setVisible(false);
      this.social?.setVisible(this.visible);
    }
  }

  private acquireUiInteraction(owner: UiInteractionOwner): () => void {
    const release = this.uiInteractionLock.acquire(owner);
    this.closeCompetingOverlays(owner);
    this.hud?.setExternalOverlayOpen(owner, true);
    this.refreshInputLock();
    return () => {
      release();
      this.hud?.setExternalOverlayOpen(owner, false);
      this.refreshInputLock();
    };
  }

  private refreshInputLock(): void {
    this.player.input.clear();
    this.player.input.setEnabled(this.visible && this.entered && !this.uiInteractionLock.locked);
  }

  private applyRoomCorrection(correction: CorrectionMessage): void {
    const distance = Math.hypot(
      correction.x - this.player.position.x,
      correction.z - this.player.position.z,
    );
    if (correction.hard || distance > 1.5) {
      this.player.setPosition(correction.x, correction.y, correction.z);
      return;
    }
    this.player.position.x = THREE.MathUtils.lerp(this.player.position.x, correction.x, 0.2);
    this.player.position.y = THREE.MathUtils.lerp(this.player.position.y, correction.y, 0.12);
    this.player.position.z = THREE.MathUtils.lerp(this.player.position.z, correction.z, 0.2);
  }

  private updateGuestAppearance(appearance: GuestAppearance): true {
    this.guestAppearance = writeGuestAppearance(appearance);
    this.activeDisplayUsername = this.guestAppearance.username;
    this.player.setAnimal(this.guestAppearance.animal, this.guestAppearance.skin);
    this.hud?.setSelectedAppearance(this.guestAppearance.animal, this.guestAppearance.skin);
    this.hud?.setDisplayUsername(this.guestAppearance.username);
    this.remoteAvatars?.setLocalUsername(this.guestAppearance.username);
    const appearanceKey = this.guestAppearanceSyncKey(this.roomClient.state.market);
    if (this.roomClient.setAppearance(
      this.guestAppearance.animal,
      this.guestAppearance.skin,
      this.guestAppearance.username,
    )) {
      this.appearanceSyncKey = appearanceKey;
    } else {
      this.appearanceSyncKey = null;
    }
    return true;
  }

  private guestAppearanceSyncKey(market: MarketSlug): string {
    return [
      market,
      this.roomClient.identity.actorId,
      this.guestAppearance.animal,
      this.guestAppearance.skin,
      this.guestAppearance.username ?? '',
    ].join(':');
  }

  private onRoomIdentityChanged(identity: GuestIdentity): void {
    this.social?.setLocalActorId(identity.actorId);
    this.remoteAvatars?.setLocalActorId(identity.actorId);
    this.appearanceSyncKey = null;
    if (this.roomClient.sessionToken) {
      const skin = identity.skin ?? 'base';
      this.player.setAnimal(identity.animal, skin);
      this.hud?.setSelectedAppearance(identity.animal, skin);
      this.hud?.setDisplayUsername(identity.username ?? null);
      this.remoteAvatars?.setLocalUsername(identity.username ?? null);
      this.activeDisplayUsername = identity.username ?? null;
    } else {
      this.guestAppearance = readGuestAppearance();
      this.activeDisplayUsername = this.guestAppearance.username;
      this.player.setAnimal(this.guestAppearance.animal, this.guestAppearance.skin);
      this.hud?.setSelectedAppearance(this.guestAppearance.animal, this.guestAppearance.skin);
      this.hud?.setDisplayUsername(this.guestAppearance.username);
      this.remoteAvatars?.setLocalUsername(this.guestAppearance.username);
    }
    if (!this.entered) this.placeAtSpawn(this.activeMarket);
  }

  private placeAtSpawn(destination: AssetSymbol, previousMarket?: AssetSymbol): void {
    const destinationSlug = marketSlugForSymbol(destination);
    const authoritative = this.pendingRoomSpawns.get(destinationSlug);
    if (authoritative) {
      this.pendingRoomSpawns.delete(destinationSlug);
      this.applyAuthoritativeSpawn(authoritative);
      return;
    }
    // Direct and solo entries use the clear south approach so the character,
    // chart, and monument share the first frame without a lamp or portal
    // occluding the camera. An online room can still replace this immediately
    // with its authoritative collision-free slot.
    if (!previousMarket) {
      const x = PARKOUR_QA_MODE ? 30 : 0;
      const z = PARKOUR_QA_MODE ? 2 : -18;
      const yaw = PARKOUR_QA_MODE ? -Math.PI * 0.5 : Math.PI;
      this.player.setPosition(x, this.groundHeightAt(x, z), z);
      this.player.setHeadingYaw(yaw);
      this.cameraRig.setOrbit(yaw, this.cameraRig.pitch, this.cameraRig.zoomDistance);
      return;
    }
    const assignment = allocateSpawnAssignment(
      this.roomClient.identity.actorId,
      destinationSlug,
      previousMarket ? marketSlugForSymbol(previousMarket) : undefined,
    );
    this.player.setPosition(
      assignment.x,
      this.groundHeightAt(assignment.x, assignment.z),
      assignment.z,
    );
    this.player.setHeadingYaw(assignment.yaw);
    this.cameraRig.setOrbit(assignment.yaw, this.cameraRig.pitch, this.cameraRig.zoomDistance);
  }

  private onRoomSpawn(market: MarketSlug, player: NetPlayerState): void {
    this.pendingRoomSpawns.set(market, player);
    if (market !== marketSlugForSymbol(this.activeMarket)) return;
    this.pendingRoomSpawns.delete(market);
    this.applyAuthoritativeSpawn(player);
  }

  private applyAuthoritativeSpawn(player: NetPlayerState): void {
    this.player.setPosition(player.x, this.groundHeightAt(player.x, player.z), player.z);
    this.player.setHeadingYaw(player.yaw);
    this.cameraRig.setOrbit(player.yaw, this.cameraRig.pitch, this.cameraRig.zoomDistance);
  }

  private refreshPopulationViews(state: RoomClientSnapshot): void {
    const connection: WorldConnectionState = state.connection === 'online'
      ? 'online'
      : state.connection === 'connecting' || state.connection === 'reconnecting'
        ? 'connecting'
        : 'offline';
    const populations: WorldPopulationSnapshot[] = [];
    for (const symbol of GRAND_MONUMENTS.map(({ symbol }) => symbol)) {
      const population = state.populations.get(marketSlugForSymbol(symbol));
      const channels: WorldChannelSnapshot[] = (population?.channels ?? []).map((channel) => {
        const fill = channel.capacity > 0 ? channel.online / channel.capacity : 1;
        return {
          id: channel.roomId,
          label: `Channel ${channel.channel}`,
          online: channel.online,
          capacity: channel.capacity,
          state: connection === 'offline'
            ? 'offline'
            : channel.online >= channel.capacity
              ? 'full'
              : fill >= 0.8
                ? 'busy'
                : 'available',
        };
      });
      populations.push({
        symbol,
        online: population?.online ?? (connection === 'offline' ? null : 0),
        shards: population?.shards ?? (connection === 'offline' ? null : 0),
        connection,
        currentChannelId: symbol === this.activeMarket ? state.currentRoomId : null,
        channels,
      });
    }
    const usernames = state.members
      .filter((member) => member.actorId === this.roomClient.identity.actorId
        || (!this.soloView && !this.blockedActors.has(member.actorId)))
      .map((member) => {
      if (member.username) return member.username;
      if (member.animal === 'saylor') return 'Michael Saylor (guest)';
      return `${member.animal.slice(0, 1).toUpperCase()}${member.animal.slice(1)} (guest)`;
      });
    const nextKey = JSON.stringify({
      activeMarket: this.activeMarket,
      connection,
      totalOnline: state.totalOnline,
      marketOnline: state.marketOnline,
      currentRoomId: state.currentRoomId,
      soloView: this.soloView,
      populations,
      usernames,
    });
    if (nextKey === this.populationViewKey) return;
    this.populationViewKey = nextKey;
    this.worldNavigator.setPopulations(populations);
    const activePopulation = state.populations.get(marketSlugForSymbol(this.activeMarket));
    const advertisedWorldCapacity = (activePopulation?.channels ?? [])
      .reduce((sum, channel) => sum + Math.max(0, channel.capacity), 0);
    const worldCapacity = advertisedWorldCapacity > 0
      ? advertisedWorldCapacity
      : Math.max(1, activePopulation?.shards ?? 1) * MARKET_ROOM_MAX_CLIENTS;
    this.onlinePopulationBadge.setSnapshot({
      totalOnline: connection === 'offline' ? null : state.totalOnline,
      worldOnline: connection === 'offline' ? null : state.marketOnline,
      worldCapacity,
      world: this.activeMarket,
      usernames,
      connection,
    });
  }

  private onRoomClientState(state: RoomClientSnapshot): void {
    this.social?.setChatContext(state.market, state.currentRoomId);
    this.social?.setScopedChatAvailable(state.scopedChatAvailable);
    if (state.connection !== 'online') {
      this.appearanceSyncKey = null;
      this.latestRelayMids = [];
    } else if (!this.roomClient.sessionToken) {
      const appearanceKey = this.guestAppearanceSyncKey(state.market);
      if (appearanceKey !== this.appearanceSyncKey
        && this.roomClient.setAppearance(
          this.guestAppearance.animal,
          this.guestAppearance.skin,
          this.guestAppearance.username,
        )) {
        this.appearanceSyncKey = appearanceKey;
      }
    } else {
      // Account identity refresh remains authoritative if that dormant flow is
      // re-enabled; anonymous browser preferences must not overwrite it.
      this.appearanceSyncKey = `account:${state.market}:${this.roomClient.identity.actorId}`;
    }
    this.remoteAvatars?.setPlayers(state.remotes);
    this.emotes?.setActors(state.remotes.map((player) => player.actorId));
    if (state.remotes.length > 0) {
      this.telemetry.emitOnce({ name: 'remote_player_seen', market: this.activeMarket });
    }
    if (state.connection !== 'online') {
      this.market.setRelayAvailable(false, this.runtimeCapabilities.switches.directMarketFallback);
    } else if (this.runtimeCapabilities.marketRelayAvailable) {
      this.market.setRelayAvailable(true, this.runtimeCapabilities.switches.directMarketFallback);
    }
    this.social?.setConnectionState(
      state.connection,
      state.connection === 'online' ? state.channelOnline : 0,
      state.lastError,
    );
    this.refreshPopulationViews(state);
    const connectionMode = state.connection === 'online'
      ? 'online'
      : state.connection === 'connecting' || state.connection === 'reconnecting'
        ? 'connecting'
        : 'offline';
    this.hud?.setEntryStatus(
      this.market.getState(this.activeMarket).mode,
      connectionMode === 'online' ? 'online' : connectionMode === 'connecting' ? 'connecting' : 'offline',
    );
    for (const definition of GRAND_MONUMENTS) this.refreshPortalLiveData(definition.symbol);
  }

  private refreshPortalLiveData(symbol: AssetSymbol): void {
    const state = this.market.getState(symbol);
    const room = this.roomClient.state;
    const destinationPopulation = room.populations.get(marketSlugForSymbol(symbol));
    const connectionMode = room.connection === 'online'
      ? 'online'
      : room.connection === 'connecting' || room.connection === 'reconnecting'
        ? 'connecting'
        : 'offline';
    const advertisedCapacity = (destinationPopulation?.channels ?? [])
      .reduce((sum, channel) => sum + Math.max(0, channel.capacity), 0);
    const capacity = advertisedCapacity > 0
      ? advertisedCapacity
      : Math.max(1, destinationPopulation?.shards ?? 1) * MARKET_ROOM_MAX_CLIENTS;
    this.portalSystem.setLiveData(symbol, {
      price: state.price,
      feedMode: state.mode,
      population: destinationPopulation?.online ?? null,
      capacity,
      connectionMode,
    });
  }

  private prewarmWorld(): void {
    for (let index = 0; index < 12; index += 1) this.world.update(this.player.position, 0);
  }

  private readonly frame = (): void => {
    if (!this.visible || this.disposed || this.contextLost) return;
    const delta = Math.min(this.clock.getDelta(), 0.05);
    this.elapsed += delta;
    if (this.entered) this.worldElapsed += delta;

    this.player.update(
      delta,
      this.cameraRig.yaw,
      (x, z) => this.groundHeightAt(x, z),
      (x, z) => this.groundSurfaceAt(x, z),
      (footstep) => this.onFootstep(footstep),
      (action) => this.onFoxAction(action),
      this.resolvePlayerHorizontal,
    );
    this.parkour.setPlayerProbe({
      x: this.player.position.x,
      y: this.player.position.y,
      z: this.player.position.z,
      grounded: this.player.snapshot.grounded,
      enabled: this.entered,
    });
    this.parkour.update(delta, this.elapsed);
    if (this.entered && this.player.normalizedSpeed > 0.045) {
      this.hud.recordOnboardingAction('move');
      this.telemetry.emitOnce({ name: 'first_movement', market: this.activeMarket });
    }
    if (this.entered && this.player.isGliding) this.hud.recordOnboardingAction('glide');
    this.roomClient.update(delta);
    const worldTimelineElapsed = this.roomClient.getWorldElapsedSeconds(this.worldElapsed);
    this.world.update(this.player.position, worldTimelineElapsed);
    this.dexDistrict.update(delta, worldTimelineElapsed, {
      nightFactor: this.world.nightFactor,
      rainIntensity: this.world.rainLevel,
      playerPosition: this.player.position,
    });
    this.desertDistrict.update(delta, worldTimelineElapsed, {
      nightFactor: this.world.nightFactor,
      playerPosition: this.player.position,
    });
    this.oilEffects.update(delta, worldTimelineElapsed, this.player.position);
    this.audio.setRainIntensity(this.world.rainLevel);
    this.portalSystem.setPlayerProbe({
      x: this.player.position.x,
      z: this.player.position.z,
      grounded: this.player.snapshot.grounded,
      enabled: this.entered && !this.uiInteractionLock.locked,
    });
    this.portalSystem.update(delta, this.elapsed);
    this.cameraRig.setChaseMotion(
      this.player.headingYaw,
      this.player.normalizedSpeed,
      this.player.chaseRecenterWeight,
    );
    this.cameraTarget.copy(this.player.position);
    this.cameraRig.update(
      delta,
      this.cameraTarget,
      (x, z) => this.groundHeightAt(x, z),
      (x, y, z) => this.cameraObstacleAt(x, y, z),
    );
    this.monuments.setNightFactor(this.world.nightFactor);
    this.monuments.update(delta, this.elapsed);
    this.remoteAvatars?.update(delta);
    this.emotes?.update();
    this.social?.update();
    this.share?.update();
    this.updateNewsOverlay();
    this.fireworks.update(delta);
    this.audio.setEnvironment({ nightFactor: this.world.nightFactor });
    this.audio.updateProximityPosition(this.player.position);
    this.audio.updateListener(this.camera);
    this.updateHud();
    this.updatePerformance(delta);
    this.renderer.render(this.scene, this.camera);
    if (!this.contextLost) this.frameHandle = requestAnimationFrame(this.frame);
  };

  private onFootstep(event: FootstepEvent): void {
    if (!this.entered) return;
    this.audio.playFootstep({
      surface: event.surface,
      sprinting: event.sprinting,
      side: event.side,
      leg: event.leg,
      intensity: event.intensity,
    });
    const vegetation = this.world.sampleVegetation(event.position.x, event.position.z);
    if (vegetation) {
      this.audio.playVegetationRustle({
        kind: vegetation.kind,
        intensity: Math.min(1, vegetation.intensity * (0.45 + event.intensity * 0.5)),
      });
    }
  }

  private onFoxAction(event: FoxActionEvent): void {
    if (!this.entered) return;
    if (event.type === 'land') {
      this.audio.playLanding(event.surface, event.intensity);
      return;
    }
    this.hud.recordOnboardingAction('jump');
    this.audio.playJump(event.type);
  }

  private onParkourEvent(event: ParkourEvent): void {
    if (!this.entered) return;
    if (event.type === 'start') {
      this.hud?.showToast('Parkour started — the clock is running!');
      return;
    }
    if (event.type === 'checkpoint') {
      this.hud?.showToast(event.checkpointId.endsWith('-b') ? 'Final checkpoint reached ✦' : 'Checkpoint reached ✦');
      return;
    }
    if (event.type === 'finish') {
      const result = createParkourRunResult({
        username: this.activeDisplayUsername,
        animal: this.player.animal,
        actorId: this.roomClient.identity.actorId,
        elapsedSeconds: event.elapsedSeconds,
        market: this.activeMarket,
        completedAt: Date.now(),
      });
      this.parkourHud?.addResult(result);
      this.hud?.showToast(`${result.displayName} cleared parkour in ${event.elapsedSeconds.toFixed(1)}s!`);
      return;
    }
    if (event.type === 'respawn') {
      this.hud?.showToast(event.checkpointId === 'parkour-start' ? 'Back to START' : 'Back to checkpoint');
      return;
    }
    if (event.type === 'quit') {
      this.hud?.showToast('Parkour run ended. You stayed right where you were.');
      return;
    }
    this.hud?.showToast('Parkour reset — multiplayer kept your position authoritative.');
  }

  private onMarketState(state: AssetState): void {
    const previous = this.latestStates.get(state.symbol);
    this.latestStates.set(state.symbol, state);
    this.monuments.updateAsset(state);
    this.refreshPortalLiveData(state.symbol);
    if (state.symbol === this.activeMarket) {
      if (state.mode === 'live' && state.price !== null) {
        this.telemetry.emitOnce({
          name: 'first_live_market_update',
          market: state.symbol,
          mode: state.provider === 'simulation' ? 'simulated' : 'live',
        });
      }
      const connection = this.roomClient.state.connection;
      this.hud?.setEntryStatus(
        state.mode,
        connection === 'online'
          ? 'online'
          : connection === 'connecting' || connection === 'reconnecting'
            ? 'connecting'
            : 'offline',
      );
    }
    const previousOpen = previous?.candles.at(-1)?.openTime;
    const currentOpen = state.candles.at(-1)?.openTime;
    const isTradePresentation = state.updateKind === 'trade'
      || state.updateKind === 'quote'
      || state.updateKind === 'simulation';
    const focusedMarket = this.monuments.nearestTo(this.player.position, MARKET_AUDIO_MAX_RADIUS);
    const isFocusedSymbol = focusedMarket?.monument.symbol === state.symbol;
    if (
      isTradePresentation
      && isFocusedSymbol
      && previousOpen !== undefined
      && currentOpen !== undefined
      && previousOpen !== currentOpen
    ) {
      const id = focusedMarket ? this.monumentIds.get(focusedMarket.monument) : undefined;
      if (id) this.audio.playCandleClose(id);
    }

    if (!isTradePresentation || !previous || state.presentationTick <= previous.presentationTick) return;
    if (state.price === null || previous.price === null) return;
    const tickMoveRatio = previous.price > 0 ? Math.abs(state.price - previous.price) / previous.price : 0;
    const minuteChange = state.horizonChanges.find((change) => change.horizon === '1m');
    const minuteMoveRatio = Math.abs(minuteChange?.changeRatio ?? 0);
    const minuteDirection = minuteChange?.direction ?? 'flat';
    if (
      this.entered
      && this.visible
      && state.symbol === this.activeMarket
      && minuteDirection !== 'flat'
    ) {
      const tradeConfig = MARKET_TRADE_CONFIG[state.symbol];
      const nowSeconds = performance.now() / 1_000;
      if (
        minuteMoveRatio >= tradeConfig.surge.minuteMoveRatio
        && nowSeconds - this.lastMinuteMoveSurgeAt >= tradeConfig.surge.cooldownSeconds
      ) {
        this.lastMinuteMoveSurgeAt = nowSeconds;
        this.world.triggerTradeSurge(minuteDirection, state.symbol);
      }
    }
    const moveRatio = Math.max(tickMoveRatio, minuteMoveRatio);
    // Calm updates rearm the authoritative event gate even when the fox is far
    // away; energetic distant updates are never consumed as local alerts.
    this.celebrationGate.observe(state.symbol, minuteMoveRatio);
    if (!this.entered || !this.visible) return;
    if (!focusedMarket || !isFocusedSymbol) return;
    const nearbyMonument = focusedMarket.monument;
    const sourceId = this.monumentIds.get(nearbyMonument);
    if (!sourceId) return;
    this.audio.playTradePulse(sourceId, state.direction, moveRatio);

    const celebration = this.celebrationGate.evaluate(
      state.symbol,
      minuteDirection,
      minuteMoveRatio,
      performance.now() / 1_000,
    );
    if (!celebration) return;
    this.dispatchMarketAccent(nearbyMonument, sourceId, celebration);
  }

  private onTradeTapeBatch(batch: TradeTapeBatch): void {
    if (batch.symbol !== this.activeMarket || this.disposed) return;
    const cutoff = batch.publishedAt - 60_000;
    for (const order of batch.orders) {
      if (order.tier === 'dust') continue;
      const history = this.tradeTierTimes[order.tier];
      history.push(batch.publishedAt);
      while (history[0] !== undefined && history[0] < cutoff) history.shift();
    }

    // Tier histories remain useful for debug readouts before entry, but no
    // world/audio presentation may leak through the entry veil or a hidden tab.
    if (!this.entered || !this.visible) return;
    this.considerTapeImbalance(batch);

    const focused = this.monuments.nearestTo(this.player.position, MARKET_AUDIO_MAX_RADIUS);
    const sourceId = focused?.monument.symbol === batch.symbol
      ? this.monumentIds.get(focused.monument)
      : undefined;
    const orders = [...batch.orders].sort((left, right) => right.notionalUsd - left.notionalUsd);
    if (sourceId) {
      const audioOrders = coalesceTradeAudioOrders(
        orders,
        MARKET_TRADE_CONFIG[batch.symbol].audio.maxVoices,
      );
      for (const order of audioOrders) {
        const tierProgress = tradeTierProgress(order.symbol, order.tier, order.notionalUsd);
        this.audio.playAggregatedTrade(sourceId, { ...order, tierProgress });
      }
    }
    for (const order of orders) {
      if (order.tier === 'dust') continue;
      const tierProgress = tradeTierProgress(order.symbol, order.tier, order.notionalUsd);
      if (order.tier !== 'big' && order.tier !== 'whale') continue;
      const displayed = this.monuments.showBigOrder(order);
      if ((displayed?.materialized || displayed?.promotedToWhale) && sourceId) {
        const shimmerPosition = this.monuments.getBigOrderHologramAudioPosition(this.tempPosition)
          ?? this.activeMonument.getFireworkOrigin(this.tempPosition);
        this.audio.playHologramShimmer(
          shimmerPosition,
          {
            side: order.side,
            tier: displayed.tier,
            intensity: displayed.promotedToWhale ? 1 : 0.55 + tierProgress * 0.45,
          },
        );
      }
      if (order.tier === 'whale' || displayed?.promotedToWhale) {
        this.world.triggerTradeSurge(order.side, order.symbol);
      }
      if (DEBUG_MODE) {
        console.info(
          `[trade-tape] ${order.symbol} ${order.tier} ${order.side} $${Math.round(order.notionalUsd).toLocaleString()} across ${order.sourceCount} venue${order.sourceCount === 1 ? '' : 's'}${order.simulated ? ' (simulated)' : ''}`,
        );
      }
    }
  }

  private considerTapeImbalance(batch: TradeTapeBatch): void {
    const config = MARKET_TRADE_CONFIG[batch.symbol].surge;
    const window = batch.stats.windows['10s'];
    const total = window.buy.notionalUsd + window.sell.notionalUsd;
    if (
      total < config.minimumTenSecondNotionalUsd
      || Math.abs(window.imbalance) < config.imbalanceRatio
    ) return;
    const nowSeconds = batch.publishedAt / 1_000;
    if (nowSeconds - this.lastTapeImbalanceSurgeAt < config.cooldownSeconds) return;
    this.lastTapeImbalanceSurgeAt = nowSeconds;
    this.world.triggerTradeSurge(window.imbalance > 0 ? 'buy' : 'sell', batch.symbol);
  }

  private triggerDebugTradeSurge(side: 'buy' | 'sell'): void {
    this.world.triggerTradeSurge(side, this.activeMarket);
  }

  private dispatchMarketAccent(
    monument: Monument,
    sourceId: string,
    event: MarketCelebrationEvent,
  ): void {
    this.audio.playMarketAccent(sourceId, {
      direction: event.direction,
      tier: event.tier,
      moveRatio: event.magnitude,
    });
    if (event.direction === 'up') {
      this.fireworks.launch(monument.getFireworkOrigin(this.tempPosition), 'up', event.tier);
      this.world.triggerRiseFlash(event.tier);
      return;
    }
    this.world.triggerDropFlash(event.tier);
  }

  private triggerDebugMarketEvent(
    direction: 'up' | 'down',
    tier: MarketCelebrationTier,
  ): void {
    const nearest = this.monuments.nearestTo(this.player.position, MARKET_AUDIO_MAX_RADIUS)
      ?? this.monuments.nearestTo(this.player.position, Number.POSITIVE_INFINITY);
    if (!nearest) return;
    const sourceId = this.monumentIds.get(nearest.monument);
    if (!sourceId) return;
    const magnitude = tier === 'exceptional'
      ? MARKET_MOVE_THRESHOLDS.exceptional * 1.1
      : MARKET_MOVE_THRESHOLDS.large * 1.1;
    this.dispatchMarketAccent(nearest.monument, sourceId, {
      symbol: nearest.monument.symbol,
      direction,
      tier,
      magnitude,
    });
  }

  private onNewsUpdate(update: NewsFeedUpdate): void {
    this.newsMode = update.mode;
    this.activeNewsCount = update.items.length;
    this.monuments.setNewsItems(update.items, Date.now());
    const freshAdditionCount = countFreshNewsAdditions(
      update.added,
      this.newsSoundCreatedAtCutoff,
    );
    if (this.entered && this.visible && freshAdditionCount > 0) {
      this.audio.playNewsAlert(Math.min(1, 0.66 + (freshAdditionCount - 1) * 0.08));
    }
  }

  private refreshAudioSources(): void {
    const sources = this.monuments.getAll().map((monument) => {
      monument.root.getWorldPosition(this.tempPosition);
      return {
        id: this.monumentIds.get(monument) ?? `${monument.kind}:${monument.symbol}`,
        symbol: monument.symbol,
        position: {
          x: this.tempPosition.x,
          y: this.tempPosition.y + 3.2 * monument.root.scale.y,
          z: this.tempPosition.z,
        },
        gain: monument.kind === 'echo' ? 0.72 : 1,
      };
    });
    this.audio.setMonumentSources(sources);
  }

  private updateHud(): void {
    this.hud.setWorldTime(
      this.world.minutesSinceMidnight,
      this.world.nightFactor,
      this.world.raining,
    );
    const nearest = this.monuments.nearestTo(this.player.position, 78);
    if (nearest) {
      const state = this.market.getState(nearest.monument.symbol);
      const stateWithAge = state as AssetState & { readonly ageMs?: number | null };
      this.hud.setNearby({
        symbol: state.symbol,
        price: state.price,
        mode: state.mode,
        distance: nearest.distance,
        ageMs: stateWithAge.ageMs,
        tradeTapeMode: this.latestTradeTapeSnapshot?.symbol === state.symbol
          ? this.latestTradeTapeSnapshot.mode
          : undefined,
      });
    } else {
      this.hud.setNearby(null);
    }
    const chartFocused = this.entered
      && nearest?.monument === this.activeMonument
      && nearest.distance <= 42;
    const horizonPanel = this.activeMonument.root.getObjectByName('market-horizon-panel');
    if (horizonPanel) horizonPanel.visible = chartFocused && !LAUNCH_CAPTURE_MODE;
    this.hud.setChartFocused(chartFocused);
    this.hud.setCompass(0, null);
    const parkour = this.parkour.getDebugStats();
    this.parkourHud?.setRunState({
      active: parkour.active,
      elapsedSeconds: parkour.elapsedSeconds,
      checkpointIndex: parkour.checkpointId === 'parkour-checkpoint-b'
        ? 2
        : parkour.checkpointId === 'parkour-checkpoint-a' ? 1 : 0,
      checkpointTotal: 2,
    });
  }

  private updateNewsOverlay(): void {
    if (!this.entered) {
      this.hud.setNewsOverlay(null);
      return;
    }
    const overlay = this.monuments.getNearestNewsOverlay(this.player.position, 48);
    if (!overlay) {
      this.hud.setNewsOverlay(null);
      return;
    }

    this.camera.updateMatrixWorld();
    this.newsCameraSpace.copy(overlay.candleAnchor).applyMatrix4(this.camera.matrixWorldInverse);
    if (this.newsCameraSpace.z >= 0) {
      this.hud.setNewsOverlay(null);
      return;
    }

    this.newsNdc.copy(overlay.candleAnchor).project(this.camera);
    if (this.newsNdc.z < -1 || this.newsNdc.z > 1) {
      this.hud.setNewsOverlay(null);
      return;
    }
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.hud.setNewsOverlay({
      symbol: overlay.symbol,
      item: overlay.item,
      dismissed: overlay.dismissed,
      anchor: {
        x: bounds.left + (this.newsNdc.x + 1) * 0.5 * bounds.width,
        y: bounds.top + (1 - this.newsNdc.y) * 0.5 * bounds.height,
      },
    });
  }

  private cameraObstacleAt(x: number, y: number, z: number): boolean {
    return this.worldGuard.collides(x, z)
      || this.monuments.collidesCamera(x, y, z)
      || this.dexDistrict.collidesCamera(x, y, z)
      || this.desertDistrict.collidesCamera(x, y, z)
      || this.parkour.collidesCamera(x, y, z);
  }

  private readonly resolvePlayerHorizontal = (
    previousX: number,
    previousZ: number,
    proposedX: number,
    proposedZ: number,
  ): { x: number; z: number } => {
    const guarded = this.worldGuard.resolve(previousX, previousZ, proposedX, proposedZ);
    const district = this.dexDistrict.resolveHorizontal(
      guarded.x,
      guarded.z,
      0.7,
      previousX,
      previousZ,
    );
    const desert = this.desertDistrict.resolveHorizontal(
      district.x,
      district.z,
      0.7,
      previousX,
      previousZ,
    );
    return this.parkour.resolveHorizontal(
      previousX,
      previousZ,
      desert.x,
      desert.z,
      this.player.position.y,
    );
  };

  private groundHeightAt(x: number, z: number): number {
    const terrainHeight = this.world.heightAt(x, z);
    const monumentGround = this.monuments.sampleGround(x, z);
    const parkourGround = this.parkour.sampleGround(x, z);
    return Math.max(
      terrainHeight,
      monumentGround?.height ?? Number.NEGATIVE_INFINITY,
      parkourGround?.height ?? Number.NEGATIVE_INFINITY,
    );
  }

  private groundSurfaceAt(x: number, z: number) {
    const terrainHeight = this.world.heightAt(x, z);
    const monumentGround = this.monuments.sampleGround(x, z);
    const parkourGround = this.parkour.sampleGround(x, z);
    if (parkourGround
      && parkourGround.height >= terrainHeight - 0.03
      && parkourGround.height >= (monumentGround?.height ?? Number.NEGATIVE_INFINITY)) {
      return parkourGround.surface;
    }
    if (monumentGround && monumentGround.height >= terrainHeight - 0.03) {
      return monumentGround.surface;
    }
    return this.world.surfaceAt(x, z);
  }

  private updatePerformance(delta: number): void {
    this.fpsAccumulator += delta;
    this.fpsFrames += 1;
    this.qualityTimer += delta;
    if (this.fpsAccumulator >= 1) {
      this.fps = this.fpsFrames / this.fpsAccumulator;
      this.fpsAccumulator = 0;
      this.fpsFrames = 0;
    }
    if (this.qualityTimer >= 4) {
      this.qualityTimer = 0;
      if (this.fps < 43 && this.qualityTier === 'high') {
        this.qualityTier = 'low';
        this.pixelRatio = Math.min(this.pixelRatio, 0.9);
        this.renderer.setPixelRatio(this.pixelRatio);
        this.renderer.shadowMap.enabled = false;
        safeWrite(QUALITY_KEY, this.qualityTier);
        this.hud.showToast('Gentle graphics enabled to keep roaming smooth.');
      }
    }
    if (DEBUG_MODE) {
      const world = this.world.getDebugStats();
      const activeMarketState = this.market.getState(this.activeMarket);
      const audioState = this.audio.state;
      const playerState = this.player.snapshot;
      const oil = this.oilEffects.getDebugStats();
      const parkour = this.parkour.getDebugStats();
      const holograms = this.monuments.bigOrderHolograms.getDebugStats();
      this.updateTradeDebugPanel();
      this.hud.setDebug([
        `fps ${this.fps.toFixed(1)} · ${this.qualityTier} · dpr ${this.pixelRatio.toFixed(2)}`,
        `draws ${this.renderer.info.render.calls} · tris ${this.estimateTriangles()}`,
        `chunks ${world.loadedChunks}/${world.desiredChunks} · queued ${world.queuedLoads}`,
        `props ${world.propInstances} · portals ${this.portalSystem.getDebugStats().portals}`,
        `market ${this.activeMarket} ${activeMarketState.mode} · tick ${activeMarketState.presentationTick} · candles ${activeMarketState.candles.length} · ${this.market.getDebugStatus()}`,
        `room ${this.roomClient.state.connection} · remotes ${this.roomClient.state.remotes.length}${this.roomClient.state.lastError ? ` · ${this.roomClient.state.lastError.slice(0, 72)}` : ''}`,
        `news ${this.newsMode} · posts ${this.activeNewsCount} · fireworks ${this.fireworks.getDebugStats().activeParticles} · holograms ${holograms.visible}/${holograms.capacity}`,
        `weather rain ${world.rainIntensity.toFixed(2)} · oil jets ${oil.jets} · blasts ${oil.blasts}`,
        `parkour ${parkour.active ? `${parkour.elapsedSeconds.toFixed(1)}s` : 'idle'} · checkpoint ${parkour.checkpointId}`,
        `audio ${audioState.status} · music ${Math.round(audioState.musicVolume * 100)}${audioState.musicMuted ? 'x' : ''} · fx ${Math.round(audioState.sfxVolume * 100)}${audioState.sfxMuted ? 'x' : ''}`,
        `fox ${playerState.grounded ? 'grounded' : this.player.isGliding ? 'gliding' : 'airborne'} · jumps ${playerState.jumpsUsed}/2 · vy ${playerState.verticalSpeed.toFixed(2)}`,
        `pos ${this.player.position.x.toFixed(2)}, ${this.player.position.z.toFixed(2)} · yaw ${this.cameraRig.yaw.toFixed(2)}`,
        `textures ${this.renderer.info.memory.textures} · geometries ${this.renderer.info.memory.geometries}`,
      ].join('\n'));
    }
  }

  private updateTradeDebugPanel(): void {
    const snapshot = this.latestTradeTapeSnapshot;
    if (!snapshot || !this.tradeDebugPanel) return;
    const now = Date.now();
    const cutoff = now - 60_000;
    const tierRates: Partial<Record<Exclude<TradeTier, 'dust'>, number>> = {};
    for (const tier of ['minor', 'notable', 'big', 'whale'] as const) {
      const history = this.tradeTierTimes[tier];
      while (history[0] !== undefined && history[0] < cutoff) history.shift();
      tierRates[tier] = history.length;
    }
    const one = snapshot.stats.windows['1s'];
    const ten = snapshot.stats.windows['10s'];
    const minute = snapshot.stats.windows['1m'];
    this.tradeDebugPanel.setSnapshot({
      mode: snapshot.mode,
      sources: snapshot.health.filter((item) => item.mode === 'live').map((item) => item.exchange),
      buy1s: one.buy.notionalUsd,
      sell1s: one.sell.notionalUsd,
      buy10s: ten.buy.notionalUsd,
      sell10s: ten.sell.notionalUsd,
      buy60s: minute.buy.notionalUsd,
      sell60s: minute.sell.notionalUsd,
      tierRates,
    });
  }

  private estimateTriangles(): string {
    let triangles = 0;
    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.InstancedMesh)) return;
      const geometry = object.geometry;
      const base = geometry.index
        ? geometry.index.count / 3
        : (geometry.getAttribute('position')?.count ?? 0) / 3;
      const instances = object instanceof THREE.InstancedMesh ? object.count : 1;
      const contribution = base * instances;
      if (Number.isFinite(contribution)) triangles += contribution;
    });
    return Math.round(triangles).toLocaleString();
  }

  private readonly resize = (): void => {
    this.cameraRig.resize(innerWidth, innerHeight);
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.setPixelRatio(this.pixelRatio);
  };

  /** A displaced background tab may reclaim its seat as soon as the user returns. */
  private readonly focus = (): void => {
    if (!document.hidden) this.roomClient.setVisible(true);
  };

  private readonly visibility = (): void => {
    this.visible = !document.hidden;
    this.audio.setVisible(this.visible);
    this.parkour.setVisible(this.visible);
    this.portalSystem.setVisible(this.visible && this.entered && !LAUNCH_CAPTURE_MODE);
    this.roomClient.setVisible(this.visible);
    this.remoteAvatars?.setVisible(this.visible);
    this.remoteAvatars?.setRemotePlayersVisible(!this.soloView);
    this.emotes?.setVisible(this.visible && !this.soloView);
    this.social?.setVisible(this.visible);
    this.share?.setVisible(this.visible);
    this.player.input.setEnabled(this.visible && this.entered && !this.uiInteractionLock.locked);
    this.player.input.clear();
    if (!this.visible) {
      cancelAnimationFrame(this.frameHandle);
      this.market.pause();
      this.tradeTape.pause();
      this.news.pause();
      return;
    }
    this.market.resume();
    this.tradeTape.resume();
    // The resumed fetch still restores every active card and candle pin, but
    // posts published while the tab was hidden must not replay their chime.
    this.newsSoundCreatedAtCutoff = Date.now() - NEWS_RESUME_CLOCK_SKEW_GRACE_MS;
    this.news.resume();
    this.clock.getDelta();
    if (!this.contextLost) this.frameHandle = requestAnimationFrame(this.frame);
  };

  private readonly webglContextLost = (event: Event): void => {
    event.preventDefault();
    if (this.contextLost || this.disposed) return;
    this.contextLost = true;
    cancelAnimationFrame(this.frameHandle);
    this.player.input.clear();
    this.player.input.setEnabled(false);
    this.hud.setContextLost(true);
  };

  private readonly webglContextRestored = (): void => {
    if (!this.contextLost || this.disposed) return;
    this.contextLost = false;
    this.hud.setContextLost(false);
    this.hud.showToast('The world found its light again.');
    this.refreshInputLock();
    this.clock.getDelta();
    if (this.visible) this.frameHandle = requestAnimationFrame(this.frame);
  };

  private readonly shareCompleteEvent = (): void => this.markShareComplete();

  private async refreshRuntimeCapabilities(): Promise<void> {
    const capabilities = await fetchRuntimeCapabilities();
    if (this.disposed) return;
    this.runtimeCapabilities = capabilities;
    const useRelay = this.roomClient.state.connection === 'online' && capabilities.marketRelayAvailable;
    this.market.setRelayAvailable(useRelay, capabilities.switches.directMarketFallback);
  }

  readonly dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    removeEventListener('resize', this.resize);
    removeEventListener('focus', this.focus);
    document.removeEventListener('visibilitychange', this.visibility);
    removeEventListener('beforeunload', this.dispose);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.webglContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.webglContextRestored);
    this.container.removeEventListener('tickerworld:share-complete', this.shareCompleteEvent);
    for (const timer of this.launchCaptureTimers) window.clearTimeout(timer);
    this.launchCaptureTimers.length = 0;
    this.market.dispose();
    this.tradeTape.dispose();
    this.news.dispose();
    this.telemetry.dispose();
    this.roomClient.dispose();
    this.canvasInteractions?.dispose();
    this.worldNavigator.dispose();
    this.onlinePopulationBadge.dispose();
    this.social?.dispose();
    this.share?.dispose();
    this.uiInteractionLock.clear();
    this.emotes?.dispose();
    this.remoteAvatars?.dispose();
    this.audio.dispose();
    this.parkourHud?.dispose();
    this.tradeDebugPanel?.dispose();
    this.hud.dispose();
    this.monuments.dispose();
    this.fireworks.points.removeFromParent();
    this.fireworks.dispose();
    this.oilEffects.dispose();
    this.dexDistrict.dispose();
    this.desertDistrict.dispose();
    this.parkour.dispose();
    this.portalSystem.dispose();
    this.player.dispose();
    this.cameraRig.dispose();
    this.world.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    if (DEBUG_MODE) delete (window as Window & { __tickerworldDebug?: unknown }).__tickerworldDebug;
  };
}
