export interface PlayerInputState {
  /** Horizontal intent, where -1 is left and +1 is right. */
  readonly moveX: number;
  /** Forward intent, where -1 is backward and +1 is forward. */
  readonly moveForward: number;
  readonly sprint: boolean;
  /** True while Space or the touch glide control is being held. */
  readonly jumpHeld: boolean;
}

export interface PlayerInputControllerOptions {
  /** Pass null to keep the controller detached (useful for tests or AI control). */
  readonly target?: Window | null;
  /** Pass null alongside target to keep visibility listeners detached. */
  readonly document?: Document | null;
  /** Override browser gamepad discovery in deterministic tests. */
  readonly gamepads?: (() => readonly (Gamepad | null)[]) | null;
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
  'Space',
]);

function clampAxis(value: number): number {
  return Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined') return false;
  if (!(target instanceof Element)) return false;
  return target.closest(
    'input, textarea, select, button, a, [contenteditable], [role="button"], [role="link"]',
  ) !== null;
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
  private readonly readGamepads: (() => readonly (Gamepad | null)[]) | null;
  private virtualX = 0;
  private virtualForward = 0;
  private virtualSprint = false;
  private virtualGlide = false;
  private jumpQueued = false;
  private gamepadX = 0;
  private gamepadForward = 0;
  private gamepadSprint = false;
  private gamepadJumpHeld = false;
  private gamepadJumpWasHeld = false;
  private enabled = true;

  public constructor(options: PlayerInputControllerOptions = {}) {
    this.target = options.target === undefined
      ? (typeof window === 'undefined' ? null : window)
      : options.target;
    this.ownerDocument = options.document === undefined
      ? (typeof document === 'undefined' ? null : document)
      : options.document;
    this.readGamepads = options.gamepads === undefined
      ? (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function'
          ? () => navigator.getGamepads()
          : null)
      : options.gamepads;

    this.target?.addEventListener('keydown', this.onKeyDown);
    this.target?.addEventListener('keyup', this.onKeyUp);
    this.target?.addEventListener('blur', this.clear);
    this.ownerDocument?.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  public get state(): PlayerInputState {
    if (!this.enabled) {
      return { moveX: 0, moveForward: 0, sprint: false, jumpHeld: false };
    }

    const keyboardX = Number(this.isDown('KeyD', 'ArrowRight')) - Number(this.isDown('KeyA', 'ArrowLeft'));
    const keyboardForward = Number(this.isDown('KeyW', 'ArrowUp')) - Number(this.isDown('KeyS', 'ArrowDown'));
    let moveX = clampAxis(keyboardX + this.virtualX + this.gamepadX);
    let moveForward = clampAxis(keyboardForward + this.virtualForward + this.gamepadForward);
    const magnitude = Math.hypot(moveX, moveForward);

    if (magnitude > 1) {
      moveX /= magnitude;
      moveForward /= magnitude;
    }

    return {
      moveX,
      moveForward,
      sprint: this.virtualSprint
        || this.gamepadSprint
        || this.pressed.has('ShiftLeft')
        || this.pressed.has('ShiftRight'),
      jumpHeld: this.virtualGlide || this.gamepadJumpHeld || this.pressed.has('Space'),
    };
  }

  /** Poll once per rendered frame so gamepad edges share the keyboard buffer. */
  public pollGamepad(): void {
    if (!this.enabled || !this.readGamepads) return;
    let pad: Gamepad | null = null;
    try {
      const pads = this.readGamepads();
      for (let index = 0; index < pads.length; index += 1) {
        const candidate = pads[index];
        if (candidate?.connected) {
          pad = candidate;
          break;
        }
      }
    } catch {
      pad = null;
    }
    if (!pad) {
      this.gamepadX = 0;
      this.gamepadForward = 0;
      this.gamepadSprint = false;
      this.gamepadJumpHeld = false;
      this.gamepadJumpWasHeld = false;
      return;
    }
    const deadzone = 0.14;
    const axis = (value: number | undefined): number => {
      const safe = clampAxis(value ?? 0);
      if (Math.abs(safe) <= deadzone) return 0;
      return Math.sign(safe) * (Math.abs(safe) - deadzone) / (1 - deadzone);
    };
    this.gamepadX = axis(pad.axes[0]);
    this.gamepadForward = -axis(pad.axes[1]);
    this.gamepadSprint = Boolean(
      Math.hypot(this.gamepadX, this.gamepadForward) >= 0.82
      || pad.buttons[1]?.pressed
      || (pad.buttons[7]?.value ?? 0) > 0.45,
    );
    this.gamepadJumpHeld = Boolean(pad.buttons[0]?.pressed);
    if (this.gamepadJumpHeld && !this.gamepadJumpWasHeld) this.requestJump();
    this.gamepadJumpWasHeld = this.gamepadJumpHeld;
  }

  /** Feed a normalized virtual joystick into the same path as keyboard input. */
  public setVirtualInput(moveX: number, moveForward: number, sprint = false): void {
    this.virtualX = clampAxis(moveX);
    this.virtualForward = clampAxis(moveForward);
    this.virtualSprint = sprint;
  }

  /** Queue one jump edge for the next player update (keyboard and touch share this path). */
  public requestJump(): void {
    if (this.enabled) this.jumpQueued = true;
  }

  /** Mirrors a held touch/pointer jump control without creating another jump edge. */
  public setVirtualGlide(held: boolean): void {
    this.virtualGlide = this.enabled && held;
  }

  /** Returns a queued jump once, preventing key-repeat from creating extra jumps. */
  public consumeJump(): boolean {
    if (!this.enabled || !this.jumpQueued) return false;
    this.jumpQueued = false;
    return true;
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
    this.virtualGlide = false;
    this.gamepadX = 0;
    this.gamepadForward = 0;
    this.gamepadSprint = false;
    this.gamepadJumpHeld = false;
    this.gamepadJumpWasHeld = false;
    this.jumpQueued = false;
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
    const wasPressed = this.pressed.has(event.code);
    this.pressed.add(event.code);
    if (event.code === 'Space' && !wasPressed && !event.repeat) this.requestJump();
    if (event.code.startsWith('Arrow') || event.code === 'Space') event.preventDefault();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (!MOVEMENT_KEYS.has(event.code)) return;
    this.pressed.delete(event.code);
  };

  private readonly onVisibilityChange = (): void => {
    if (this.ownerDocument?.hidden) this.clear();
  };
}
