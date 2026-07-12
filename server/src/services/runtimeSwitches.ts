import {
  MARKET_ROOM_MAX_CLIENTS,
  PROTOCOL_VERSION,
  type RuntimeCapabilities,
  type RuntimeKillSwitches,
} from '@tickerworld/shared';

export interface CapabilityReadiness {
  marketRelayAvailable: boolean;
  newsAvailable: boolean;
}

/** Single-process launch switchboard. Updates are atomic in the Node event loop. */
export class RuntimeSwitchboard {
  private switches: RuntimeKillSwitches;
  private updatedAt: number;

  constructor(initial: RuntimeKillSwitches, private readonly maxProcessConnections: number) {
    this.switches = { ...initial };
    this.updatedAt = Date.now();
  }

  enabled<K extends keyof RuntimeKillSwitches>(key: K): boolean {
    return this.switches[key];
  }

  update(patch: Partial<RuntimeKillSwitches>, now = Date.now()): RuntimeKillSwitches {
    this.switches = { ...this.switches, ...patch };
    this.updatedAt = now;
    return this.snapshot();
  }

  snapshot(): RuntimeKillSwitches {
    return { ...this.switches };
  }

  capabilities(readiness: CapabilityReadiness, now = Date.now()): RuntimeCapabilities {
    return {
      protocolVersion: PROTOCOL_VERSION,
      updatedAt: this.updatedAt,
      switches: this.snapshot(),
      multiplayerAvailable: this.switches.admissions,
      marketRelayAvailable: readiness.marketRelayAvailable,
      newsAvailable: readiness.newsAvailable,
      maxPlayersPerShard: MARKET_ROOM_MAX_CLIENTS,
      maxProcessConnections: this.maxProcessConnections,
    };
  }
}
