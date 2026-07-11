import * as THREE from 'three';
import nunitoFontUrl from '@fontsource/nunito/files/nunito-latin-700-normal.woff?url';
import { AudioEngine, MARKET_AUDIO_MAX_RADIUS } from './audio';
import { DEBUG_MODE, GRAND_MONUMENTS, WORLD_SEED } from './config';
import { HyperliquidMarketFeed, MarketCelebrationGate } from './markets';
import { FireworkPool, Monument, MonumentSystem } from './monuments';
import { BrowserNewsFeed, type NewsFeedMode, type NewsFeedUpdate } from './news';
import { FoxPlayer, ThirdPersonCamera, type FootstepEvent, type FoxActionEvent } from './player';
import type { AssetState, AssetSymbol } from './types';
import { Hud } from './ui';
import { WayfindingSystem, WorldSystem, type EchoPlacementDescriptor } from './world';

const DISCOVERY_KEY = 'tickerworld:v1:discoveries';
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

function safeReadDiscoveries(): Set<AssetSymbol> {
  try {
    const saved = JSON.parse(localStorage.getItem(DISCOVERY_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(saved) ? saved.filter((value): value is AssetSymbol =>
      GRAND_MONUMENTS.some((monument) => monument.symbol === value)) : []);
  } catch {
    return new Set();
  }
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
  private readonly hud: Hud;
  private readonly grandMonuments = new Map<AssetSymbol, Monument>();
  private readonly echoMonuments = new Map<string, Monument>();
  private readonly monumentIds = new Map<Monument, string>();
  private readonly latestStates = new Map<AssetSymbol, AssetState>();
  private readonly discoveries = safeReadDiscoveries();
  private readonly clock = new THREE.Clock();
  private readonly tempPosition = new THREE.Vector3();
  private readonly cameraTarget = new THREE.Vector3();
  private entered = false;
  private visible = true;
  private disposed = false;
  private frameHandle = 0;
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

  constructor(container: HTMLElement) {
    this.container = container;
    this.container.innerHTML = '';

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
    });
    this.world = new WorldSystem(this.scene, {
      seed: WORLD_SEED,
      onEchoPlacementsChanged: (placements) => this.syncEchoMonuments(placements),
    });
    this.wayfinding = new WayfindingSystem({
      parent: this.scene,
      fontUrl: nunitoFontUrl,
      heightAt: (x, z) => this.world.heightAt(x, z),
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

    for (const definition of GRAND_MONUMENTS) {
      const monument = this.monuments.add({
        symbol: definition.symbol,
        kind: 'grand',
        position: {
          x: definition.x,
          y: this.world.heightAt(definition.x, definition.z),
          z: definition.z,
        },
        scale: definition.scale,
        initialState: this.market.getState(definition.symbol),
      });
      this.grandMonuments.set(definition.symbol, monument);
      this.monumentIds.set(monument, `grand:${definition.symbol}`);
    }

    this.hud = new Hud(this.container, {
      onEnter: () => this.enter(),
      onMuteToggle: () => this.audio.toggleMute(),
      onVolumeChange: (value) => this.audio.setVolume(value),
      onMusicMuteToggle: () => this.audio.toggleMusicMuted(),
      onMusicVolumeChange: (value) => this.audio.setMusicVolume(value),
      onSfxMuteToggle: () => this.audio.toggleSfxMuted(),
      onSfxVolumeChange: (value) => this.audio.setSfxVolume(value),
      onCompassToggle: (enabled) => {
        this.compassEnabled = enabled;
        safeWrite(COMPASS_KEY, String(enabled));
      },
      onReducedMotionToggle: (enabled) => {
        this.reducedMotion = enabled;
        this.player.setReducedMotion(enabled);
        this.cameraRig.setReducedMotion(enabled);
        this.fireworks.setReducedMotion(enabled);
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
          fireworks: this.fireworks,
          wayfinding: this.wayfinding,
        },
        configurable: true,
      });
    }
    this.frameHandle = requestAnimationFrame(this.frame);
  }

  private async enter(): Promise<void> {
    if (this.entered) return;
    this.entered = true;
    this.player.input.setEnabled(true);
    this.hud.setEntered();
    const audioReady = await this.audio.unlock();
    if (!audioReady && !this.audio.state.available) {
      this.hud.showToast('Sound is unavailable here, but the world is still yours.');
    } else {
      this.hud.showToast('Wander slowly—markets can be heard before they are seen.');
    }
  }

  private prewarmWorld(): void {
    for (let index = 0; index < 12; index += 1) this.world.update(this.player.position, 0);
    this.syncEchoMonuments(this.world.getActiveEchoPlacements());
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
    );
    this.world.update(this.player.position, this.elapsed);
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
    this.audio.playFootstep({ surface: event.surface, sprinting: event.sprinting, side: event.side });
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

    const previousOpen = previous?.candles.at(-1)?.openTime;
    const currentOpen = state.candles.at(-1)?.openTime;
    if (previousOpen !== undefined && currentOpen !== undefined && previousOpen !== currentOpen) {
      for (const monument of this.monuments.getForSymbol(state.symbol)) {
        const id = this.monumentIds.get(monument);
        if (id) this.audio.playCandleClose(id);
      }
    }

    if (!previous || state.presentationTick <= previous.presentationTick || state.direction === 'flat') return;
    if (state.price === null || previous.price === null) return;
    const tickMoveRatio = previous.price > 0 ? Math.abs(state.price - previous.price) / previous.price : 0;
    const minuteChange = state.horizonChanges.find((change) => change.horizon === '1m');
    const minuteMoveRatio = Math.abs(minuteChange?.changeRatio ?? 0);
    const minuteDirection = minuteChange?.direction ?? 'flat';
    const useMinuteDirection = minuteMoveRatio >= Math.max(0.00012, tickMoveRatio * 1.5)
      && minuteDirection !== 'flat';
    const soundDirection = useMinuteDirection ? minuteDirection : state.direction;
    const moveRatio = Math.max(tickMoveRatio, minuteMoveRatio);
    for (const monument of this.monuments.getForSymbol(state.symbol)) {
      const id = this.monumentIds.get(monument);
      if (id) this.audio.playTick(id, soundDirection, moveRatio);
    }

    if (!this.entered || !this.visible) return;
    const nearbyMonument = this.nearestMonumentForSymbol(
      state.symbol,
      MARKET_AUDIO_MAX_RADIUS,
    );
    if (!nearbyMonument) return;
    const celebration = this.celebrationGate.evaluate(
      state.symbol,
      soundDirection,
      moveRatio,
      performance.now() / 1_000,
    );
    if (!celebration) return;
    this.fireworks.launch(
      nearbyMonument.getFireworkOrigin(this.tempPosition),
      celebration.direction,
      celebration.tier,
    );
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

  private nearestMonumentForSymbol(symbol: AssetSymbol, maxDistance: number): Monument | null {
    let nearest: Monument | null = null;
    let distance = maxDistance;
    for (const monument of this.monuments.getForSymbol(symbol)) {
      const candidateDistance = monument.nearestDistance(this.player.position);
      if (candidateDistance > distance) continue;
      nearest = monument;
      distance = candidateDistance;
    }
    return nearest;
  }

  private syncEchoMonuments(placements: readonly EchoPlacementDescriptor[]): void {
    if (!this.world || !this.monuments) return;
    const desired = new Set(placements.map((placement) => placement.key));
    for (const [key, monument] of this.echoMonuments) {
      if (desired.has(key)) continue;
      this.monuments.remove(monument, true);
      this.monumentIds.delete(monument);
      this.echoMonuments.delete(key);
    }
    for (const placement of placements) {
      if (this.echoMonuments.has(placement.key)) continue;
      const monument = this.monuments.add({
        symbol: placement.symbol,
        kind: 'echo',
        position: {
          x: placement.x,
          y: this.world.heightAt(placement.x, placement.z),
          z: placement.z,
        },
        scale: placement.scale,
        initialState: this.market.getState(placement.symbol),
      });
      this.echoMonuments.set(placement.key, monument);
      this.monumentIds.set(monument, placement.key);
    }
    this.refreshAudioSources();
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

    const nearbyGrand = this.monuments.nearestTo(this.player.position, 24, true);
    if (this.entered && nearbyGrand && !this.discoveries.has(nearbyGrand.monument.symbol)) {
      this.discoveries.add(nearbyGrand.monument.symbol);
      safeWrite(DISCOVERY_KEY, JSON.stringify([...this.discoveries]));
      this.hud.showToast(`${nearbyGrand.monument.symbol} monument discovered`);
    }

    let closest: { symbol: AssetSymbol; monument: Monument; distance: number } | null = null;
    if (this.compassEnabled) {
      for (const [symbol, monument] of this.grandMonuments) {
        if (this.discoveries.has(symbol)) continue;
        const distance = monument.nearestDistance(this.player.position);
        if (!closest || distance < closest.distance) closest = { symbol, monument, distance };
      }
    }
    if (!closest) {
      this.hud.setCompass(0, null);
    } else {
      closest.monument.root.getWorldPosition(this.tempPosition);
      const dx = this.tempPosition.x - this.player.position.x;
      const dz = this.tempPosition.z - this.player.position.z;
      const relativeAngle = Math.atan2(dx, -dz) + this.cameraRig.yaw;
      this.hud.setCompass(relativeAngle, closest.symbol);
    }
  }

  private cameraObstacleAt(x: number, y: number, z: number): boolean {
    return this.monuments.collidesCamera(x, y, z);
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
      const btcMarket = this.market.getState('BTC');
      const audioState = this.audio.state;
      const playerState = this.player.snapshot;
      this.hud.setDebug([
        `fps ${this.fps.toFixed(1)} · dpr ${this.pixelRatio.toFixed(2)}`,
        `draws ${this.renderer.info.render.calls} · tris ${this.estimateTriangles()}`,
        `chunks ${world.loadedChunks}/${world.desiredChunks} · queued ${world.queuedLoads}`,
        `props ${world.propInstances} · echoes ${world.activeEchoes}`,
        `market ${btcMarket.mode} · tick ${btcMarket.presentationTick} · candles ${btcMarket.candles.length}`,
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
    this.audio.dispose();
    this.hud.dispose();
    this.monuments.dispose();
    this.fireworks.points.removeFromParent();
    this.fireworks.dispose();
    this.wayfinding.dispose();
    this.player.dispose();
    this.cameraRig.dispose();
    this.world.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    if (DEBUG_MODE) delete (window as Window & { __tickerworldDebug?: unknown }).__tickerworldDebug;
  };
}
