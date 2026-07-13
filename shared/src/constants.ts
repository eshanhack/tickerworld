export const ASSET_SYMBOLS = [
  'BTC',
  'ETH',
  'SOL',
  'XRP',
  'DOGE',
  'BNB',
  'LINK',
  'AVAX',
  'WTI',
  'TEST',
  'PUMP',
  'ANSEM',
  'SHFL',
] as const;

export const MARKET_SLUGS = [
  'btc',
  'eth',
  'sol',
  'xrp',
  'doge',
  'bnb',
  'link',
  'avax',
  'wti',
  'test',
  'pump',
  'ansem',
  'shfl',
] as const;

export const ANIMAL_KINDS = [
  'fox',
  'penguin',
  'frog',
  'duck',
  'bear',
  'rabbit',
  'cat',
  'axolotl',
  'saylor',
] as const;

export const PREMIUM_SKINS = [
  'sunrise-fox',
  'amethyst-rabbit',
  'aurora-axolotl',
  'tide-cat',
  'golden-duck',
  'honey-bear',
  'bluebell-penguin',
  'alpine-frog',
] as const;

export const MODERATION_REASONS = [
  'harassment',
  'hate_or_profanity',
  'spam_or_scam',
  'impersonation',
  'other',
] as const;

export const ENTITLEMENT_SKUS = ['username-claim', ...PREMIUM_SKINS] as const;

export const PROTOCOL_VERSION = 2;
export const PREVIOUS_PROTOCOL_VERSION = 1;
export const ACCEPTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION, PREVIOUS_PROTOCOL_VERSION] as const;

export const MARKET_ROOM_NAME = 'market';
export const MARKET_ROOM_MAX_CLIENTS = 50;
export const STATE_PATCH_RATE_MS = 100;
export const MOVE_SEND_RATE_HZ = 10;
export const REMOTE_INTERPOLATION_DELAY_MS = 150;
export const CHAT_MAX_LENGTH = 140;
export const CHAT_HISTORY_LIMIT = 50;
export const CHAT_CLIENT_ROW_LIMIT = 200;
export const ACTOR_ID_MAX_LENGTH = 64;

export const WORLD_RADIUS = 84;
export const PODIUM_EXCLUSION_RADIUS = 10.6;
/** Network-authoritative ceiling used by the fastest lightweight species. */
export const MAX_SPRINT_SPEED = 8.4;
export const SPAWN_SLOT_COUNT = 50;
export const SPAWN_SLOT_SPACING = 1.8;

export const CLIENT_MESSAGES = {
  move: 'move',
  chat: 'chat',
  report: 'report',
  appearance: 'appearance',
  identityRefresh: 'identity-refresh',
  emote: 'emote',
  partyInviteRequest: 'party-invite-request',
  parkourRespawn: 'parkour-respawn',
} as const;

export const PARKOUR_CHECKPOINT_IDS = [
  'parkour-start',
  'parkour-checkpoint-a',
  'parkour-checkpoint-b',
] as const;

export const SERVER_MESSAGES = {
  correction: 'correction',
  chat: 'chat',
  chatRejected: 'chat-rejected',
  population: 'population',
  protocolRejected: 'protocol-rejected',
  reportAccepted: 'report-accepted',
  reportRejected: 'report-rejected',
  identityRefreshed: 'identity-refreshed',
  identityRejected: 'identity-rejected',
  emote: 'emote',
  partyInvite: 'party-invite',
  partyRejected: 'party-rejected',
  market: 'market',
  marketMids: 'market-mids',
} as const;
