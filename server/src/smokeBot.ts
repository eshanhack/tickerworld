import { Client } from '@colyseus/sdk';
import {
  CLIENT_MESSAGES,
  MARKET_ROOM_NAME,
  PROTOCOL_VERSION,
  SERVER_MESSAGES,
  allocateSpawnAssignment,
  sampleBoundedTerrainHeight,
  type AnimalKind,
  type ChatMessage,
  type MarketSlug,
  type MoveSnapshot,
} from '@tickerworld/shared';

interface AnonymousSession {
  actorId: string;
  animal: AnimalKind;
  token: string;
  expiresAt: number;
}

function httpEndpoint(value: string): string {
  return value
    .replace(/^wss:/, 'https:')
    .replace(/^ws:/, 'http:')
    .replace(/\/$/, '');
}

const endpoint = process.env.MULTIPLAYER_URL?.trim() ?? 'ws://127.0.0.1:2567';
const market = (process.env.MARKET ?? 'btc') as MarketSlug;
const lifetimeMs = Math.max(1_000, Number(process.env.SMOKE_DURATION_MS) || 30_000);
const message = process.env.SMOKE_CHAT?.slice(0, 140);
const identityResponse = await fetch(`${httpEndpoint(endpoint)}/api/anonymous/session`, {
  method: 'POST',
  headers: { Accept: 'application/json' },
});
if (!identityResponse.ok) throw new Error(`Anonymous session failed (${identityResponse.status})`);
const identity = await identityResponse.json() as AnonymousSession;
const client = new Client(endpoint, {
  headers: { Origin: process.env.PUBLIC_ORIGIN?.split(',')[0]?.trim() ?? 'http://127.0.0.1:4173' },
});
const room = await client.joinOrCreate(MARKET_ROOM_NAME, {
  protocolVersion: PROTOCOL_VERSION,
  market,
  anonymousToken: identity.token,
  animal: identity.animal,
  skin: 'base',
});
room.onMessage(SERVER_MESSAGES.population, () => undefined);
let observedChat = message === undefined;
room.onMessage<ChatMessage>(SERVER_MESSAGES.chat, (entry) => {
  if (entry.actorId === identity.actorId && entry.text === message) observedChat = true;
});

interface SmokePlayerState {
  readonly actorId?: string;
  readonly x?: number;
  readonly z?: number;
}

function ownPlayer(): SmokePlayerState | null {
  let result: SmokePlayerState | null = null;
  const players = (room.state as {
    players?: { forEach?: (callback: (player: SmokePlayerState) => void) => void };
  }).players;
  players?.forEach?.((player) => {
    if (player.actorId === identity.actorId) result = player;
  });
  return result;
}

const fallbackSpawn = allocateSpawnAssignment(identity.actorId, market);
const joinedPlayer = ownPlayer();
const centreX = Number.isFinite(joinedPlayer?.x) ? Number(joinedPlayer?.x) : fallbackSpawn.x;
const centreZ = Number.isFinite(joinedPlayer?.z) ? Number(joinedPlayer?.z) : fallbackSpawn.z;
const initialX = centreX;
const initialZ = centreZ;

let sequence = 0;
let phase = 0;
const sendMove = (): void => {
  phase += 0.08;
  const x = centreX + Math.sin(phase) * 0.7;
  const z = centreZ + Math.cos(phase) * 0.7;
  const move: MoveSnapshot = {
    protocolVersion: PROTOCOL_VERSION,
    sequence: ++sequence,
    sentAt: Date.now(),
    x,
    y: sampleBoundedTerrainHeight(x, z),
    z,
    yaw: phase,
    speed: 1.28,
    verticalSpeed: 0,
    grounded: true,
    gait: 'walk',
  };
  room.send(CLIENT_MESSAGES.move, move);
};
const interval = setInterval(sendMove, 100);
if (message) {
  room.send(CLIENT_MESSAGES.chat, { protocolVersion: PROTOCOL_VERSION, text: message });
}
process.stdout.write(`Smoke bot ${identity.actorId} joined ${market}\n`);

await new Promise<void>((resolve) => setTimeout(resolve, lifetimeMs));
clearInterval(interval);
const finalPlayer = ownPlayer();
const synchronizedTravel = finalPlayer
  && Number.isFinite(finalPlayer.x)
  && Number.isFinite(finalPlayer.z)
  ? Math.hypot(Number(finalPlayer.x) - initialX, Number(finalPlayer.z) - initialZ)
  : 0;
if (synchronizedTravel < 0.1) {
  await room.leave(true);
  throw new Error('Smoke bot joined but did not observe synchronized movement');
}
if (!observedChat) {
  await room.leave(true);
  throw new Error('Smoke bot sent chat but did not observe its room broadcast');
}
await room.leave(true);
process.stdout.write(`Smoke bot observed ${synchronizedTravel.toFixed(2)} units and left cleanly\n`);
