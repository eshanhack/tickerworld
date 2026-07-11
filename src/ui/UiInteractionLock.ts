export type UiInteractionOwner = 'chat' | 'player' | 'economy' | 'news' | 'portal';

export type UiInteractionListener = (
  locked: boolean,
  owners: ReadonlySet<UiInteractionOwner>,
) => void;

/**
 * Small shared arbiter for DOM interactions layered over the game canvas.
 * Owners are idempotent so repeated focus/pointer events cannot strand input
 * in a locked state.
 */
export class UiInteractionLock {
  private readonly owners = new Set<UiInteractionOwner>();
  private readonly listeners = new Set<UiInteractionListener>();
  private readonly generations = new Map<UiInteractionOwner, number>();

  public get locked(): boolean {
    return this.owners.size > 0;
  }

  public has(owner: UiInteractionOwner): boolean {
    return this.owners.has(owner);
  }

  public set(owner: UiInteractionOwner, active: boolean): void {
    // An explicit state change supersedes any outstanding lease for this owner.
    this.generations.set(owner, (this.generations.get(owner) ?? 0) + 1);
    this.setOwner(owner, active);
  }

  /**
   * Acquires an owner until the returned lease is released. A newer lease for
   * the same owner supersedes older ones, so stale async work cannot unlock a
   * newer operation.
   */
  public acquire(owner: UiInteractionOwner): () => void {
    const generation = (this.generations.get(owner) ?? 0) + 1;
    this.generations.set(owner, generation);
    this.setOwner(owner, true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.generations.get(owner) !== generation) return;
      this.setOwner(owner, false);
    };
  }

  private setOwner(owner: UiInteractionOwner, active: boolean): void {
    const changed = active ? !this.owners.has(owner) : this.owners.has(owner);
    if (!changed) return;
    if (active) this.owners.add(owner);
    else this.owners.delete(owner);
    this.emit();
  }

  public subscribe(listener: UiInteractionListener): () => void {
    this.listeners.add(listener);
    listener(this.locked, new Set(this.owners));
    return () => this.listeners.delete(listener);
  }

  public clear(): void {
    for (const owner of this.owners) {
      this.generations.set(owner, (this.generations.get(owner) ?? 0) + 1);
    }
    if (this.owners.size === 0) return;
    this.owners.clear();
    this.emit();
  }

  private emit(): void {
    const snapshot = new Set(this.owners);
    for (const listener of this.listeners) listener(this.locked, snapshot);
  }
}
