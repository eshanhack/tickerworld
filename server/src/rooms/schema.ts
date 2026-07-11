import { MapSchema, Schema, type } from '@colyseus/schema';
import { PROTOCOL_VERSION, type MarketSlug, type MoveSnapshot } from '@tickerworld/shared';

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
  @type('string') animal = 'fox';
  @type('string') skin = 'base';
  @type('string') username = '';
  @type('float64') updatedAt = 0;
}

export class MarketRoomState extends Schema {
  @type('string') market: MarketSlug = 'btc';
  @type('uint16') protocolVersion = PROTOCOL_VERSION;
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
}
