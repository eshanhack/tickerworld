import { MapSchema, Schema, type } from '@colyseus/schema';
import {
  PROTOCOL_VERSION,
  WORLD_DAY_DURATION_SECONDS,
  type MarketSlug,
  type MoveSnapshot,
  type SharedWorldEnvironment,
} from '@tickerworld/shared';

export class PlayerState extends Schema {
  @type('string') actorId = '';
  @type('float64') x = 0;
  @type('float64') y = 0;
  @type('float64') z = 21;
  @type('float32') yaw = 0;
  @type('float32') speed = 0;
  @type('float32') verticalSpeed = 0;
  @type('boolean') grounded = true;
  @type('string') gait: MoveSnapshot['gait'] = 'idle';
  @type('string') movementState = '';
  @type('float32') gaitPhase = 0;
  @type('float32') movementBlend = 0;
  @type('float32') runBlend = 0;
  @type('float32') airProgress = 1;
  @type('uint32') simulationTick = 0;
  @type('string') animal = 'fox';
  @type('string') skin = 'base';
  @type('string') username = '';
  @type('float64') updatedAt = 0;
}

/**
 * Colyseus-replicated room clock. Clients project forward from the latest
 * sample locally, then gently re-anchor at the next state patch. This keeps
 * day/night, rain, and deterministic thunder aligned without rendering a
 * network-timed animation at 10Hz.
 */
export class WorldEnvironmentState extends Schema implements SharedWorldEnvironment {
  @type('float64') elapsedSeconds = 0;
  @type('float64') updatedAt = 0;
  @type('float32') dayDurationSeconds = WORLD_DAY_DURATION_SECONDS;
}

export class MarketRoomState extends Schema {
  @type('string') market: MarketSlug = 'btc';
  @type('uint16') protocolVersion = PROTOCOL_VERSION;
  /** Positive capability: absent on pre-scoped-chat protocol-v2 servers. */
  @type('boolean') scopedChat = true;
  /** Positive capability; absent on earlier protocol-v2 room schemas. */
  @type('boolean') motionStateV1 = true;
  @type(WorldEnvironmentState) environment = new WorldEnvironmentState();
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
}
