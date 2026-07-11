import * as THREE from 'three';
import nunitoFontUrl from '@fontsource/nunito/files/nunito-latin-700-normal.woff?url';
import { AudioEngine, MARKET_AUDIO_MAX_RADIUS, MARKET_MOVE_THRESHOLDS } from './audio';
import { DEBUG_MODE, GRAND_MONUMENTS, MULTIPLAYER_ALLOWED, WORLD_SEED } from './config';
import {
  HyperliquidMarketFeed,
  MarketCelebrationGate,
  type MarketCelebrationEvent,
  type MarketCelebrationTier,
} from './markets';
import { FireworkPool, Monument, MonumentSystem } from './monuments';
import { RoomClientSystem, type GuestIdentity, type RoomClientSnapshot } from './net';
import { BrowserNewsFeed, type NewsFeedMode, type NewsFeedUpdate } from './news';
import { PortalSystem, type PortalRoute } from './portals';
import { FoxPlayer, ThirdPersonCamera, type FootstepEvent, type FoxActionEvent } from './player';
import {
  marketSlugForSymbol,
  type MarketRouteHistory,
} from './routing';
import type { AssetState, AssetSymbol } from './types';
import {
  allocateSpawnAssignment,
  type CorrectionMessage,
  type MarketSlug,
  type NetPlayerState,
} from '../shared/src/index.js';
import { EconomySystem } from './economy/EconomySystem';
import { CanvasInteractionCoordinator } from './social/CanvasInteractionCoordinator';
import { accountBlockMerge } from './social/BlockStore';
import { RemoteAvatarSystem } from './social/RemoteAvatarSystem';
import { SocialSystem } from './social/SocialSystem';
import { Hud, UiInteractionLock, type UiInteractionOwner } from './ui';
import { WayfindingSystem, WorldGuard, WorldSystem } from './world';

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

function safeReadNumber(key: string): number | null {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : null;
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
  private readonly news = new BrowserNewsFeed();
  private readonly monuments: MonumentSystem;
  private readonly audio = new AudioEngine();
  private readonly fireworks: FireworkPool;
  private readonly celebrationGate = new MarketCelebrationGate();
  private readonly wayfinding: WayfindingSystem;
  private readonly worldGuard = new WorldGuard();
  private readonly uiInteractionLock = new UiInteractionLock();
  private readonly portalSystem: PortalSystem;
  private readonly roomClient: RoomClientSystem;
  private remoteAvatars?: RemoteAvatarSystem;
  private social?: SocialSystem;
  private economy?: EconomySystem;
  private canvasInteractions?: CanvasInteractionCoordinator;
  private readonly hud: Hud;
  private readonly routeHistory?: MarketRouteHistory;
  private readonly monumentIds = new Map<Monument, string>();
  private readonly latestStates = new Map<AssetSymbol, AssetState>();
  private readonly pendingRoomSpawns = new Map<MarketSlug, NetPlayerState>();
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
  private fps = 60;
  private fpsAccumulator = 0;
  private fpsFrames = 0;
  private qualityTimer = 0;
  private pixelRatio: number;
  private compassEnabled = true;
  private reducedMotion = false;
  private newsMode: NewsFeedMode = 'connecting';
  private activeNewsCount = 0;
  private newsSoundCreatedAtCutoff = Number.NEGATIVE_INFINITY;

  constructor(container: HTMLElement, options: GameOptions = {}) {
    this.container = container;
    this.container.innerHTML = '';
    this.activeMarket = options.activeMarket ?? 'BTC';
    this.routeHistory = options.routeHistory;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(innerWidth, innerHeight);
    const coarsePointer = matchMedia('(pointer: coarse)').matches;
    const maximumPixelRatio = Math.min(devicePixelRatio, coarsePointer ? 1.35 : 2);
    this.pixelRatio = Math.min(maximumPixelRatio, Math.max(0.9, safeReadNumber(QUALITY_KEY) ?? maximumPixelRatio));
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.shadowMap.enabled = true;
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
      distance: 9,
      reducedMotion: this.reducedMotion,
    });

    this.monuments = new MonumentSystem({
      parent: this.scene,
      camera: this.camera,
      domElement: this.renderer.domElement,
      fontUrl: nunitoFontUrl,
      attachInteractionListeners: false,
    });
    this.world = new WorldSystem(this.scene, {
      seed: WORLD_SEED,
      reducedMotion: this.reducedMotion,
      monuments: GRAND_MONUMENTS,
      echoSuppressionRadius: Number.POSITIVE_INFINITY,
    });
    this.wayfinding = new WayfindingSystem({
      parent: this.scene,
      fontUrl: nunitoFontUrl,
      heightAt: (x, z) => this.world.heightAt(x, z),
      activeMarket: this.activeMarket,
    });
    this.fireworks = new FireworkPool({ reducedMotion: this.reducedMotion });
    this.scene.add(this.fireworks.points);

    const spawnZ = 21;
    this.player = new FoxPlayer({
      spawn: new THREE.Vector3(0, this.world.heightAt(0, spawnZ), spawnZ),
      reducedMotion: this.reducedMotion,
    });
    this.player.input.setEnabled(false);
    this.scene.add(this.player.group);
    this.roomClient = new RoomClientSystem({
      // QA seeds intentionally alter terrain. Keep them local so authoritative
      // movement validation never compares the player with tickerworld-v1.
      endpoint: MULTIPLAYER_ALLOWED ? undefined : '',
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
    this.player.setAnimal(this.roomClient.identity.animal, 'base');

    this.hud = new Hud(this.container, {
      onEnter: () => this.enter(),
      onMuteToggle: () => this.audio.toggleMute(),
      onVolumeChange: (value) => this.audio.setVolume(value),
      onMusicMuteToggle: () => this.audio.toggleMusicMuted(),
      onMusicVolumeChange: (value) => this.audio.setMusicVolume(value),
      onSfxMuteToggle: () => this.audio.toggleSfxMuted(),
      onSfxVolumeChange: (value) => this.audio.setSfxVolume(value),
      onNewsDismiss: (itemId) => this.monuments.dismissNewsOverlay(itemId),
      onNewsInteractionChange: (active) => this.setUiInteraction('news', active),
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
        this.portalSystem?.setReducedMotion(enabled);
        safeWrite(REDUCED_MOTION_KEY, String(enabled));
      },
      onVirtualInput: (x, forward, sprint) => this.player.setVirtualInput(x, forward, sprint),
      onJump: () => this.player.requestJump(),
      onGlideChange: (held) => this.player.setGlideHeld(held),
    });

    try {
      this.compassEnabled = localStorage.getItem(COMPASS_KEY) !== 'false';
    } catch {
      this.compassEnabled = true;
    }
    this.hud.setCompassEnabled(this.compassEnabled);
    this.hud.setReducedMotion(this.reducedMotion);
    this.portalSystem = new PortalSystem({
      parent: this.scene,
      activeMarket: this.activeMarket,
      fontUrl: nunitoFontUrl,
      heightAt: (x, z) => this.world.heightAt(x, z),
      overlayParent: this.container,
      reducedMotion: this.reducedMotion,
      onPortalChime: (_route, stage) => this.audio.playPortalChime(stage),
      onTravelRequested: (route) => this.travelThroughPortal(route),
    });

    this.remoteAvatars = new RemoteAvatarSystem({
      parent: this.scene,
      camera: this.camera,
      fontUrl: nunitoFontUrl,
      localPosition: () => this.player.position,
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
    this.social = new SocialSystem({
      root: this.hud.mountLayer('tickerworld-social-layer'),
      transport: this.roomClient,
      localActorId: this.roomClient.identity.actorId,
      onInputFocusChange: (focused) => {
        if (focused) this.player.input.clear();
      },
      onInteractionChange: (owner, active) => this.setUiInteraction(owner, active),
      onSpeech: (message) => this.remoteAvatars?.showSpeech(message),
      onBlocksChanged: (blocked) => this.remoteAvatars?.setBlockedActors(blocked),
      persistBlock: (actorId, blocked) => this.economy?.persistBlock(actorId, blocked),
    });
    this.economy = new EconomySystem({
      root: this.hud.mountLayer('tickerworld-economy-layer'),
      actorId: () => this.roomClient.identity.actorId,
      anonymousAnimal: () => this.roomClient.identity.animal,
      anonymousToken: () => this.roomClient.anonymousToken,
      market: () => marketSlugForSymbol(this.activeMarket),
      onAppearanceChange: (animal, skin) => this.player.setAnimal(animal, skin),
      onAnonymousAppearance: (animal) => this.player.setAnimal(animal, 'base'),
      onProfileChange: (profile, sessionToken) => (
        this.roomClient.setAccountSession(sessionToken, profile)
      ),
      onBlocksLoaded: (actorIds) => this.mergeAccountBlocks(actorIds),
      onInteractionChange: (active) => this.setUiInteraction('economy', active),
    });
    this.canvasInteractions = new CanvasInteractionCoordinator({
      element: this.renderer.domElement,
      activateNewsAt: (x, y) => this.monuments.activateNewsAt(x, y),
      pickPlayerAt: (x, y) => this.remoteAvatars?.pickAt(x, y, this.renderer.domElement) ?? null,
      openPlayerCard: (player) => this.social?.openPlayerCard(player),
    });
    this.roomClient.subscribe((state) => this.onRoomClientState(state));
    this.roomClient.subscribeChat((message) => this.social?.acceptChat(message));
    this.roomClient.subscribeChatRejected((rejection) => this.social?.acceptChatRejection(rejection));
    this.roomClient.subscribeReportAccepted(() => this.social?.acceptReportAccepted());
    this.roomClient.subscribeReportRejected((rejection) => this.social?.acceptReportRejection(rejection));

    this.audio.subscribe((state) => {
      this.hud.setMusicMuted(state.musicMuted);
      this.hud.setMusicVolume(state.musicVolume);
      this.hud.setSfxMuted(state.sfxMuted);
      this.hud.setSfxVolume(state.sfxVolume);
      if (state.status === 'resume-failed') this.hud.showToast('Tap the music button to wake the sound.');
    });

    this.market.subscribe((state) => this.onMarketState(state));
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

    addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', this.visibility);
    addEventListener('beforeunload', this.dispose);

    void this.market.start();
    void this.news.start();
    void this.roomClient.connect(marketSlugForSymbol(this.activeMarket));
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
          news: this.news,
          monuments: this.monuments,
          audio: this.audio,
          roomClient: this.roomClient,
          fireworks: this.fireworks,
          wayfinding: this.wayfinding,
          triggerLargeUp: () => this.triggerDebugMarketEvent('up', 'large'),
          triggerExceptionalUp: () => this.triggerDebugMarketEvent('up', 'exceptional'),
          triggerLargeDown: () => this.triggerDebugMarketEvent('down', 'large'),
          triggerExceptionalDown: () => this.triggerDebugMarketEvent('down', 'exceptional'),
        },
        configurable: true,
      });
    }
    this.frameHandle = requestAnimationFrame(this.frame);
  }

  private async enter(): Promise<void> {
    if (this.entered) return;
    this.entered = true;
    this.player.input.setEnabled(!this.uiInteractionLock.locked);
    this.hud.setEntered();
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
  ): Promise<boolean> {
    if (this.disposed) return false;
    const releasePortalLock = this.acquireUiInteraction('portal');
    const switchGeneration = ++this.marketSwitchGeneration;
    try {
      const destinationSlug = marketSlugForSymbol(destination);
      if (destination === this.activeMarket && this.roomClient.state.market === destinationSlug) {
        this.portalSystem.cancelTravel();
        return true;
      }

      this.portalSystem.beginTransfer(destination);
      // Keep the old world behind the loading veil until matchmaking has either
      // joined the destination room or deliberately resolved to solo mode. This
      // prevents movement in a new world while the client is still in the old
      // room and keeps browser history travel consistent with physical portals.
      await this.roomClient.switchMarket(destinationSlug);
      if (this.disposed || switchGeneration !== this.marketSwitchGeneration) return false;
      if (destination === this.activeMarket) {
        this.portalSystem.cancelTravel();
        return true;
      }
      this.monuments.remove(this.activeMonument, true);
      this.monumentIds.delete(this.activeMonument);
      this.activeMarket = destination;
      this.activeMonument = this.monuments.add({
        symbol: destination,
        kind: 'grand',
        position: { x: 0, y: this.world.heightAt(0, 0), z: 0 },
        scale: 1.25,
        initialState: this.market.getState(destination),
      });
      this.monumentIds.set(this.activeMonument, `grand:${destination}`);
      this.portalSystem.setActiveMarket(destination);
      this.wayfinding.setActiveMarket(destination);
      this.economy?.syncLastMarket(marketSlugForSymbol(destination));

      this.placeAtSpawn(destination, previousMarket);
      this.refreshAudioSources();
      this.audio.updateProximityPosition(this.player.position);
      this.hud.showToast(`${destination} world`);
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

  private setUiInteraction(owner: UiInteractionOwner, active: boolean): void {
    this.uiInteractionLock.set(owner, active);
    this.refreshInputLock();
  }

  private acquireUiInteraction(owner: UiInteractionOwner): () => void {
    const release = this.uiInteractionLock.acquire(owner);
    this.refreshInputLock();
    return release;
  }

  private refreshInputLock(): void {
    this.player.input.clear();
    this.player.input.setEnabled(this.visible && this.entered && !this.uiInteractionLock.locked);
  }

  private mergeAccountBlocks(accountActorIds: readonly string[]): void {
    if (!this.social) return;
    const merge = accountBlockMerge(this.social.blockedActors, accountActorIds);
    this.social.mergeAccountBlocks([...merge.union]);
    for (const actorId of merge.localOnly) {
      void this.economy?.persistBlock(actorId, true).catch(() => undefined);
    }
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

  private onRoomIdentityChanged(identity: GuestIdentity): void {
    this.social?.setLocalActorId(identity.actorId);
    if (!this.roomClient.sessionToken) this.player.setAnimal(identity.animal, 'base');
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

  private onRoomClientState(state: RoomClientSnapshot): void {
    this.remoteAvatars?.setPlayers(state.remotes);
    this.social?.setConnectionState(
      state.connection,
      state.connection === 'online' ? state.remotes.length + 1 : 0,
    );
    const connectionMode = state.connection === 'online'
      ? 'online'
      : state.connection === 'connecting' || state.connection === 'reconnecting'
        ? 'connecting'
        : 'offline';
    for (const definition of GRAND_MONUMENTS) {
      const marketState = this.market.getState(definition.symbol);
      const slug = marketSlugForSymbol(definition.symbol);
      this.portalSystem.setLiveData(definition.symbol, {
        price: marketState.price,
        feedMode: marketState.mode,
        population: state.populations.get(slug)?.online ?? null,
        connectionMode,
      });
    }
  }

  private prewarmWorld(): void {
    for (let index = 0; index < 12; index += 1) this.world.update(this.player.position, 0);
  }

  private readonly frame = (): void => {
    if (!this.visible || this.disposed) return;
    const delta = Math.min(this.clock.getDelta(), 0.05);
    this.elapsed += delta;

    this.player.update(
      delta,
      this.cameraRig.yaw,
      (x, z) => this.groundHeightAt(x, z),
      (x, z) => this.groundSurfaceAt(x, z),
      (footstep) => this.onFootstep(footstep),
      (action) => this.onFoxAction(action),
      this.worldGuard.resolveHorizontal,
    );
    this.roomClient.update(delta);
    this.world.update(this.player.position, this.elapsed);
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
    this.social?.update();
    this.economy?.update();
    this.updateNewsOverlay();
    this.fireworks.update(delta);
    this.audio.setEnvironment({ nightFactor: this.world.nightFactor });
    this.audio.updateProximityPosition(this.player.position);
    this.audio.updateListener(this.camera);
    this.updateHud();
    this.updatePerformance(delta);
    this.renderer.render(this.scene, this.camera);
    this.frameHandle = requestAnimationFrame(this.frame);
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
  }

  private onFoxAction(event: FoxActionEvent): void {
    if (!this.entered) return;
    if (event.type === 'land') {
      this.audio.playLanding(event.surface, event.intensity);
      return;
    }
    this.audio.playJump(event.type);
  }

  private onMarketState(state: AssetState): void {
    const previous = this.latestStates.get(state.symbol);
    this.latestStates.set(state.symbol, state);
    this.monuments.updateAsset(state);
    this.onRoomClientState(this.roomClient.state);

    const previousOpen = previous?.candles.at(-1)?.openTime;
    const currentOpen = state.candles.at(-1)?.openTime;
    const isTradePresentation = state.updateKind === 'trade' || state.updateKind === 'simulation';
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
    const nearest = this.monuments.nearestTo(this.player.position, 78);
    if (nearest) {
      const state = this.market.getState(nearest.monument.symbol);
      this.hud.setNearby({ symbol: state.symbol, price: state.price, mode: state.mode, distance: nearest.distance });
    } else {
      this.hud.setNearby(null);
    }
    this.hud.setCompass(0, null);
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
    return this.worldGuard.collides(x, z) || this.monuments.collidesCamera(x, y, z);
  }

  private groundHeightAt(x: number, z: number): number {
    const terrainHeight = this.world.heightAt(x, z);
    const monumentGround = this.monuments.sampleGround(x, z);
    return monumentGround ? Math.max(terrainHeight, monumentGround.height) : terrainHeight;
  }

  private groundSurfaceAt(x: number, z: number) {
    const monumentGround = this.monuments.sampleGround(x, z);
    if (monumentGround && monumentGround.height >= this.world.heightAt(x, z) - 0.03) {
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
      if (this.fps < 43 && this.pixelRatio > 0.9) {
        this.pixelRatio = Math.max(0.9, this.pixelRatio - 0.15);
        this.renderer.setPixelRatio(this.pixelRatio);
        safeWrite(QUALITY_KEY, String(this.pixelRatio));
      }
    }
    if (DEBUG_MODE) {
      const world = this.world.getDebugStats();
      const activeMarketState = this.market.getState(this.activeMarket);
      const audioState = this.audio.state;
      const playerState = this.player.snapshot;
      this.hud.setDebug([
        `fps ${this.fps.toFixed(1)} · dpr ${this.pixelRatio.toFixed(2)}`,
        `draws ${this.renderer.info.render.calls} · tris ${this.estimateTriangles()}`,
        `chunks ${world.loadedChunks}/${world.desiredChunks} · queued ${world.queuedLoads}`,
        `props ${world.propInstances} · portals ${this.portalSystem.getDebugStats().portals}`,
        `market ${this.activeMarket} ${activeMarketState.mode} · tick ${activeMarketState.presentationTick} · candles ${activeMarketState.candles.length}`,
        `room ${this.roomClient.state.connection} · remotes ${this.roomClient.state.remotes.length}${this.roomClient.state.lastError ? ` · ${this.roomClient.state.lastError.slice(0, 72)}` : ''}`,
        `news ${this.newsMode} · posts ${this.activeNewsCount} · fireworks ${this.fireworks.getDebugStats().activeParticles}`,
        `audio ${audioState.status} · music ${Math.round(audioState.musicVolume * 100)}${audioState.musicMuted ? 'x' : ''} · fx ${Math.round(audioState.sfxVolume * 100)}${audioState.sfxMuted ? 'x' : ''}`,
        `fox ${playerState.grounded ? 'grounded' : this.player.isGliding ? 'gliding' : 'airborne'} · jumps ${playerState.jumpsUsed}/2 · vy ${playerState.verticalSpeed.toFixed(2)}`,
        `pos ${this.player.position.x.toFixed(2)}, ${this.player.position.z.toFixed(2)} · yaw ${this.cameraRig.yaw.toFixed(2)}`,
        `textures ${this.renderer.info.memory.textures} · geometries ${this.renderer.info.memory.geometries}`,
      ].join('\n'));
    }
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

  private readonly visibility = (): void => {
    this.visible = !document.hidden;
    this.audio.setVisible(this.visible);
    this.portalSystem.setVisible(this.visible);
    this.roomClient.setVisible(this.visible);
    this.remoteAvatars?.setVisible(this.visible);
    this.social?.setVisible(this.visible);
    this.economy?.setVisible(this.visible);
    this.player.input.setEnabled(this.visible && this.entered && !this.uiInteractionLock.locked);
    this.player.input.clear();
    if (!this.visible) {
      cancelAnimationFrame(this.frameHandle);
      this.market.pause();
      this.news.pause();
      return;
    }
    this.market.resume();
    // The resumed fetch still restores every active card and candle pin, but
    // posts published while the tab was hidden must not replay their chime.
    this.newsSoundCreatedAtCutoff = Date.now() - NEWS_RESUME_CLOCK_SKEW_GRACE_MS;
    this.news.resume();
    this.clock.getDelta();
    this.frameHandle = requestAnimationFrame(this.frame);
  };

  readonly dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    removeEventListener('resize', this.resize);
    document.removeEventListener('visibilitychange', this.visibility);
    removeEventListener('beforeunload', this.dispose);
    this.market.dispose();
    this.news.dispose();
    this.roomClient.dispose();
    this.canvasInteractions?.dispose();
    this.social?.dispose();
    this.economy?.dispose();
    this.uiInteractionLock.clear();
    this.remoteAvatars?.dispose();
    this.audio.dispose();
    this.hud.dispose();
    this.monuments.dispose();
    this.fireworks.points.removeFromParent();
    this.fireworks.dispose();
    this.portalSystem.dispose();
    this.wayfinding.dispose();
    this.player.dispose();
    this.cameraRig.dispose();
    this.world.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    if (DEBUG_MODE) delete (window as Window & { __tickerworldDebug?: unknown }).__tickerworldDebug;
  };
}
