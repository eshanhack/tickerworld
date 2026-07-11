const BLOCK_STORAGE_KEY = 'tickerworld:v2:blocks';
const MAX_STORED_BLOCKS = 500;

function safeActorId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128;
}

export function accountBlockMerge(
  local: ReadonlySet<string>,
  account: readonly string[],
): { readonly union: ReadonlySet<string>; readonly localOnly: readonly string[] } {
  const accountSet = new Set(account.filter(safeActorId));
  return {
    union: new Set([...local, ...accountSet]),
    localOnly: [...local].filter((actorId) => !accountSet.has(actorId)),
  };
}

export class BlockStore {
  private readonly values = new Set<string>();

  constructor(private readonly storage: Storage | null = safeStorage()) {
    try {
      const parsed = JSON.parse(this.storage?.getItem(BLOCK_STORAGE_KEY) ?? '[]') as unknown;
      if (Array.isArray(parsed)) {
        for (const actorId of parsed.slice(0, MAX_STORED_BLOCKS)) {
          if (safeActorId(actorId)) this.values.add(actorId);
        }
      }
    } catch {
      // Blocking still works for the current page when storage is unavailable.
    }
  }

  get snapshot(): ReadonlySet<string> {
    return new Set(this.values);
  }

  has(actorId: string): boolean {
    return this.values.has(actorId);
  }

  block(actorId: string): boolean {
    if (!safeActorId(actorId) || this.values.size >= MAX_STORED_BLOCKS) return false;
    const changed = !this.values.has(actorId);
    this.values.add(actorId);
    if (changed) this.persist();
    return changed;
  }

  unblock(actorId: string): boolean {
    const changed = this.values.delete(actorId);
    if (changed) this.persist();
    return changed;
  }

  merge(actorIds: readonly string[]): boolean {
    let changed = false;
    for (const actorId of actorIds) {
      if (this.values.size >= MAX_STORED_BLOCKS) break;
      if (safeActorId(actorId) && !this.values.has(actorId)) {
        this.values.add(actorId);
        changed = true;
      }
    }
    if (changed) this.persist();
    return changed;
  }

  private persist(): void {
    try {
      this.storage?.setItem(BLOCK_STORAGE_KEY, JSON.stringify([...this.values]));
    } catch {
      // Storage is optional and never blocks the immediate local safety action.
    }
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
