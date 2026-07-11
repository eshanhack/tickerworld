import { isIP } from 'node:net';

/** Overwritten from the raw Node socket before Colyseus builds AuthContext. */
export const TRUSTED_PEER_HEADER = 'x-tickerworld-transport-peer';

interface Network {
  version: 4 | 6;
  bytes: Uint8Array;
  prefix: number;
}

function normalizeIp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let candidate = value.trim().replace(/^"|"$/g, '');
  if (candidate.startsWith('[')) {
    const closing = candidate.indexOf(']');
    if (closing > 0) candidate = candidate.slice(1, closing);
  } else if (isIP(candidate) === 0 && /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(candidate)) {
    candidate = candidate.slice(0, candidate.lastIndexOf(':'));
  }
  candidate = candidate.split('%')[0] ?? candidate;
  const mapped = candidate.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped?.[1] && isIP(mapped[1]) === 4) return mapped[1];
  return isIP(candidate) === 0 ? null : candidate.toLowerCase();
}

function ipv4Bytes(value: string): Uint8Array | null {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return Uint8Array.from(parts);
}

function ipv6Groups(value: string): number[] | null {
  const embeddedIpv4 = value.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  let normalized = value;
  if (embeddedIpv4) {
    const bytes = ipv4Bytes(embeddedIpv4);
    if (!bytes) return null;
    const groups = [((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0), ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)];
    normalized = `${value.slice(0, -embeddedIpv4.length)}${groups.map((group) => group.toString(16)).join(':')}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (!half) return [];
    const groups = half.split(':').map((part) => Number.parseInt(part, 16));
    return groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)
      ? null
      : groups;
  };
  const left = parseHalf(halves[0] ?? '');
  const right = parseHalf(halves[1] ?? '');
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  return missing >= 1 ? [...left, ...Array<number>(missing).fill(0), ...right] : null;
}

function ipBytes(value: string): { version: 4 | 6; bytes: Uint8Array } | null {
  const version = isIP(value);
  if (version === 4) {
    const bytes = ipv4Bytes(value);
    return bytes ? { version, bytes } : null;
  }
  if (version === 6) {
    const groups = ipv6Groups(value);
    if (!groups) return null;
    const bytes = new Uint8Array(16);
    groups.forEach((group, index) => {
      bytes[index * 2] = group >>> 8;
      bytes[index * 2 + 1] = group & 0xff;
    });
    return { version, bytes };
  }
  return null;
}

function parseNetwork(value: string): Network {
  const [rawAddress, rawPrefix, trailing] = value.trim().split('/');
  const address = normalizeIp(rawAddress);
  if (!address || trailing !== undefined) throw new Error(`Invalid trusted proxy CIDR: ${value}`);
  const parsed = ipBytes(address);
  if (!parsed) throw new Error(`Invalid trusted proxy CIDR: ${value}`);
  const maxPrefix = parsed.version === 4 ? 32 : 128;
  const prefix = rawPrefix === undefined ? maxPrefix : Number(rawPrefix);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new Error(`Invalid trusted proxy CIDR: ${value}`);
  }
  if (prefix === 0) {
    throw new Error(`Universal trusted proxy CIDR is forbidden: ${value}`);
  }
  return { ...parsed, prefix };
}

function networkContains(network: Network, address: string): boolean {
  const candidate = ipBytes(address);
  if (!candidate || candidate.version !== network.version) return false;
  const fullBytes = Math.floor(network.prefix / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (candidate.bytes[index] !== network.bytes[index]) return false;
  }
  const remainder = network.prefix % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return ((candidate.bytes[fullBytes] ?? 0) & mask) === ((network.bytes[fullBytes] ?? 0) & mask);
}

/** Resolves a client IP without trusting spoofable forwarding headers by default. */
export class CanonicalIpResolver {
  private readonly trusted: readonly Network[];

  constructor(trustedProxyCidrs: readonly string[] = []) {
    this.trusted = trustedProxyCidrs.map(parseNetwork);
  }

  resolve(peerAddress: unknown, forwardedFor?: string | readonly string[]): string {
    const peer = normalizeIp(peerAddress);
    if (!peer) return 'unknown';
    if (!this.isTrusted(peer)) return peer;
    const forwarded = (Array.isArray(forwardedFor) ? forwardedFor : [forwardedFor])
      .flatMap((entry) => typeof entry === 'string' ? entry.split(',') : [])
      .map(normalizeIp)
      .filter((entry): entry is string => entry !== null);
    const chain = [...forwarded, peer];
    let index = chain.length - 1;
    while (index > 0 && this.isTrusted(chain[index]!)) index -= 1;
    return chain[index] ?? peer;
  }

  private isTrusted(address: string): boolean {
    return this.trusted.some((network) => networkContains(network, address));
  }
}

function contextHeader(context: {
  headers?: Headers | Record<string, unknown>;
  req?: { headers?: Headers | Record<string, unknown> };
}, name: string): unknown {
  const headers = context.headers ?? context.req?.headers;
  if (!headers) return undefined;
  if ('get' in headers && typeof headers.get === 'function') return headers.get(name);
  const record = headers as Record<string, unknown>;
  return record[name] ?? record[name.toLowerCase()];
}

export function websocketPeer(context: {
  headers?: Headers | Record<string, unknown>;
  req?: { headers?: Headers | Record<string, unknown> };
}): { peer: unknown; forwarded: string | readonly string[] | undefined } {
  const forwarded = contextHeader(context, 'x-forwarded-for');
  return {
    // Never use AuthContext.ip: Colyseus 0.17 derives it from client-supplied
    // forwarding headers during matchmaking. Only the server-overwritten raw
    // transport header is an acceptable immediate peer.
    peer: contextHeader(context, TRUSTED_PEER_HEADER),
    forwarded: typeof forwarded === 'string' || Array.isArray(forwarded)
      ? forwarded as string | readonly string[]
      : undefined,
  };
}

export function websocketOrigin(context: {
  headers?: Headers | Record<string, unknown>;
  req?: { headers?: Headers | Record<string, unknown> };
}): string | null {
  const value = contextHeader(context, 'origin');
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
