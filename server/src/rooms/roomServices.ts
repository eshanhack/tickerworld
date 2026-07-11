import {
  isProtocolVersionAccepted,
  type AnimalKind,
  type EntitlementSku,
  type JoinOptions,
  type SkinId,
} from '@tickerworld/shared';
import type { AuthService } from '../services/auth.js';
import type { AnonymousIdentityService } from '../services/anonymousIdentity.js';
import type { ChatSafety, SharedChatRateLimiter } from '../services/chatSafety.js';
import type { ModerationService } from '../services/moderation.js';
import { hashIp } from '../services/crypto.js';
import type { PopulationDirectory } from './PopulationDirectory.js';
import type { AdmissionControl } from '../services/admission.js';
import type { CanonicalIpResolver } from '../services/canonicalIp.js';

export interface RoomIdentity {
  actorId: string;
  accountId: string | null;
  walletAddress: string | null;
  username: string | null;
  animal: AnimalKind;
  skin: SkinId;
  entitlements: readonly EntitlementSku[];
}

export interface RoomServices {
  auth: AuthService;
  anonymous: AnonymousIdentityService;
  chatSafety: ChatSafety;
  chatLimits: SharedChatRateLimiter;
  moderation: ModerationService;
  populations: PopulationDirectory;
  admissions: AdmissionControl;
  clientIps: CanonicalIpResolver;
  ipHmacSecret: string;
  publicOrigins: readonly string[];
  requireWebSocketOrigin: boolean;
}

let current: RoomServices | null = null;

export function configureRoomServices(services: RoomServices): void {
  current = services;
}

export function getRoomServices(): RoomServices {
  if (!current) throw new Error('Room services have not been configured');
  return current;
}

export function isAllowedRoomOrigin(
  origin: string | null,
  allowedOrigins: readonly string[],
  required: boolean,
): boolean {
  if (!origin) return !required;
  return allowedOrigins.includes(origin);
}

export async function resolveRoomIdentity(
  options: JoinOptions,
  ip: string,
): Promise<RoomIdentity & { ipHash: string }> {
  return resolveRoomIdentityWithIpHash(options, hashIp(getRoomServices().ipHmacSecret, ip));
}

export async function resolveRoomIdentityWithIpHash(
  options: Pick<JoinOptions, 'protocolVersion' | 'sessionToken' | 'anonymousToken'>,
  ipHash: string,
): Promise<RoomIdentity & { ipHash: string }> {
  const services = getRoomServices();
  if (!isProtocolVersionAccepted(options.protocolVersion)) {
    throw new Error('protocol_mismatch');
  }
  if (options.sessionToken) {
    const account = await services.auth.authenticate(options.sessionToken);
    const profile = await services.auth.profileForAccount(account.accountId);
    return {
      actorId: account.actorId,
      accountId: account.accountId,
      walletAddress: account.walletAddress,
      username: account.username,
      animal: account.selectedAnimal,
      skin: account.selectedSkin,
      entitlements: profile.entitlements,
      ipHash,
    };
  }
  if (options.anonymousToken) {
    const anonymous = services.anonymous.verify(options.anonymousToken);
    if (anonymous) {
      return {
        actorId: anonymous.actorId,
        accountId: null,
        walletAddress: null,
        username: null,
        animal: anonymous.animal,
        skin: 'base',
        entitlements: [],
        ipHash,
      };
    }
  }
  throw new Error('anonymous_token_required');
}
