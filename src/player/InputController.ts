export interface PlayerInputState {
  /** Horizontal intent, where -1 is left and +1 is right. */
  readonly moveX: number;
  /** Forward intent, where -1 is backward and +1 is forward. */
  readonly moveForward: number;
  readonly sprint: boolean;
}

export interface PlayerInputControllerOptions {
  /** Pass null to keep the controller detached (useful for tests or AI control). */
  readonly target?: Window | null;
  /** Pass null alongside target to keep visibility listeners detached. */
  readonly document?: Document | null;
}

const MOVEMENT_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowLeft',
  'ArrowDown',
  'ArrowRight',
  'ShiftLeft',
  'ShiftRight',
]);

function clampAxis(value: number): number {
  return Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target.hasAttribute('contenteditable');
}

/**
 * Combines keyboard and virtual-stick input into one normalized movement state.
 * It owns its listeners and clears held keys whenever focus is lost so movement
 * cannot get stuck after tab switching.
 */
export class PlayerInputController {
  private readonly pressed = new Set<string>();
  private readonly target: Window | null;
  private readonly ownerDocument: Document | null;
  private virtualX = 0;
  private virtualForward = 0;
  private virtualSprint = false;
  private enabled = true;

  public constructor(options: PlayerInputControllerOptions = {}) {
    this.target = options.target === undefined
      ? (typeof window === 'undefined' ? null : window)
      : options.target;
    this.ownerDocument = options.document === undefined
      ? (typeof document === 'undefined' ? null : document)
      : options.document;

    this.target?.addEventListener('keydown', this.onKeyDown);
    this.target?.addEventListener('keyup', this.onKeyUp);
    this.target?.addEventListener('blur', this.clear);
    this.ownerDocument?.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  public get state(): PlayerInputState {
    if (!this.enabled) {
      return { moveX: 0, moveForward: 0, sprint: false };
    }

    const keyboardX = Number(this.isDown('KeyD', 'ArrowRight')) - Number(this.isDown('KeyA', 'ArrowLeft'));
    const keyboardForward = Number(this.isDown('KeyW', 'ArrowUp')) - Number(this.isDown('KeyS', 'ArrowDown'));
    let moveX = clampAxis(keyboardX + this.virtualX);
    let moveForward = clampAxis(keyboardForward + this.virtualForward);
    const magnitude = Math.hypot(moveX, moveForward);

    if (magnitude > 1) {
      moveX /= magnitude;
      moveForward /= magnitude;
    }

    return {
      moveX,
      moveForward,
      sprint: this.virtualSprint || this.pressed.has('ShiftLeft') || this.pressed.has('ShiftRight'),
    };
  }

  /** Feed a normalized virtual joystick into the same path as keyboard input. */
  public setVirtualInput(moveX: number, moveForward: number, sprint = false): void {
    this.virtualX = clampAxis(moveX);
    this.virtualForward = clampAxis(moveForward);
    this.virtualSprint = sprint;
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clear();
  }

  public clear = (): void => {
    this.pressed.clear();
    this.virtualX = 0;
    this.virtualForward = 0;
    this.virtualSprint = false;
  };

  public dispose(): void {
    this.clear();
    this.target?.removeEventListener('keydown', this.onKeyDown);
    this.target?.removeEventListener('keyup', this.onKeyUp);
    this.target?.removeEventListener('blur', this.clear);
    this.ownerDocument?.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  private isDown(primary: string, alternate: string): boolean {
    return this.pressed.has(primary) || this.pressed.has(alternate);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!MOVEMENT_KEYS.has(event.code) || isEditableTarget(event.target)) return;
    this.pressed.add(event.code);
    if (event.code.startsWith('Arrow')) event.preventDefault();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (!MOVEMENT_KEYS.has(event.code)) return;
    this.pressed.delete(event.code);
  };

  private readonly onVisibilityChange = (): void => {
    if (this.ownerDocument?.hidden) this.clear();
  };
}
