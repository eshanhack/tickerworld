import {
  PROTOCOL_VERSION,
  type RuntimeCapabilities,
} from '../../shared/src/index.js';

/** Only the solo live-market fallback fails open when control-plane state is unreachable. */
export const OFFLINE_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  protocolVersion: PROTOCOL_VERSION,
  updatedAt: 0,
  switches: {
    admissions: false,
    chatSend: false,
    newsIngest: false,
    directMarketFallback: true,
    publicWalletAuth: false,
    purchases: false,
    adminActions: false,
  },
  multiplayerAvailable: false,
  marketRelayAvailable: false,
  newsAvailable: false,
  maxPlayersPerShard: 50,
  maxProcessConnections: 400,
};

export function multiplayerHttpOrigin(endpoint: string): string | null {
  const trimmed = endpoint.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function isRuntimeCapabilities(value: unknown): value is RuntimeCapabilities {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RuntimeCapabilities>;
  const switchKeys = [
    'admissions', 'chatSend', 'newsIngest', 'directMarketFallback',
    'publicWalletAuth', 'purchases', 'adminActions',
  ] as const;
  return typeof candidate.protocolVersion === 'number'
    && typeof candidate.updatedAt === 'number'
    && typeof candidate.multiplayerAvailable === 'boolean'
    && typeof candidate.marketRelayAvailable === 'boolean'
    && typeof candidate.newsAvailable === 'boolean'
    && typeof candidate.maxPlayersPerShard === 'number'
    && typeof candidate.maxProcessConnections === 'number'
    && Boolean(candidate.switches)
    && switchKeys.every((key) => typeof candidate.switches?.[key] === 'boolean');
}

export async function fetchRuntimeCapabilities(
  endpoint = import.meta.env.VITE_MULTIPLAYER_URL ?? '',
  fetcher: typeof fetch = fetch,
): Promise<RuntimeCapabilities> {
  const origin = multiplayerHttpOrigin(endpoint);
  if (!origin) return OFFLINE_RUNTIME_CAPABILITIES;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_500);
  try {
    const response = await fetcher(`${origin}/api/capabilities`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return OFFLINE_RUNTIME_CAPABILITIES;
    const payload = await response.json() as unknown;
    return isRuntimeCapabilities(payload) ? payload : OFFLINE_RUNTIME_CAPABILITIES;
  } catch {
    return OFFLINE_RUNTIME_CAPABILITIES;
  } finally {
    clearTimeout(timeout);
  }
}
