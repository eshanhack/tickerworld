export type OnboardingAction =
  | 'identity'
  | 'move'
  | 'jump'
  | 'glide'
  | 'emote'
  | 'portal'
  | 'share';

export type OnboardingStepId =
  | 'identity'
  | 'move-jump'
  | 'glide'
  | 'emote'
  | 'portal-share';

export interface OnboardingSnapshot {
  readonly currentStep: OnboardingStepId | null;
  readonly completedActions: ReadonlySet<OnboardingAction>;
  readonly completed: boolean;
  /** UI-only dismissal; deliberately lives in memory and resets on page reload. */
  readonly dismissed: boolean;
  readonly progress: number;
}

interface StepDefinition {
  readonly id: OnboardingStepId;
  readonly actions: readonly OnboardingAction[];
  readonly mode: 'all' | 'any';
}

const STEPS: readonly StepDefinition[] = [
  { id: 'identity', actions: ['identity'], mode: 'all' },
  { id: 'move-jump', actions: ['move', 'jump'], mode: 'all' },
  { id: 'glide', actions: ['glide'], mode: 'all' },
  { id: 'emote', actions: ['emote'], mode: 'all' },
  { id: 'portal-share', actions: ['portal', 'share'], mode: 'any' },
];

export type OnboardingListener = (snapshot: OnboardingSnapshot) => void;

function stepComplete(step: StepDefinition, actions: ReadonlySet<OnboardingAction>): boolean {
  return step.mode === 'all'
    ? step.actions.every((action) => actions.has(action))
    : step.actions.some((action) => actions.has(action));
}

export class OnboardingJourney {
  private readonly actions = new Set<OnboardingAction>();
  private readonly listeners = new Set<OnboardingListener>();
  private dismissed = false;

  public get snapshot(): OnboardingSnapshot {
    const currentIndex = STEPS.findIndex((step) => !stepComplete(step, this.actions));
    const completedSteps = currentIndex < 0 ? STEPS.length : currentIndex;
    return {
      currentStep: currentIndex < 0 ? null : STEPS[currentIndex]!.id,
      completedActions: new Set(this.actions),
      completed: currentIndex < 0,
      dismissed: this.dismissed,
      progress: completedSteps / STEPS.length,
    };
  }

  /** Hides the journey for this in-memory game session without changing progress. */
  public dismiss(): boolean {
    if (this.dismissed) return false;
    this.dismissed = true;
    this.emit();
    return true;
  }

  public record(action: OnboardingAction): boolean {
    if (this.actions.has(action)) return false;
    const current = STEPS.find((step) => !stepComplete(step, this.actions));
    // Future actions do not pre-complete later hints. Each lesson must be
    // performed while it is actually being taught.
    if (!current?.actions.includes(action)) return false;
    this.actions.add(action);
    this.emit();
    return true;
  }

  public has(action: OnboardingAction): boolean {
    return this.actions.has(action);
  }

  public subscribe(listener: OnboardingListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}
