import { Vector2 } from 'three';

/**
 * Unifies keyboard + mouse, standard-mapping gamepads and touch into one
 * polled state. Battle code reads `movement`, `aim*` and `basicHeld` every
 * frame and consumes one-shot actions; menus consume navigation actions.
 */

export type InputDevice = 'keyboard' | 'gamepad' | 'touch';
export type InputAction =
  | 'skill' | 'ultimate' | 'dash' | 'pause'
  | 'confirm' | 'back' | 'up' | 'down' | 'left' | 'right' | 'tabPrev' | 'tabNext';

const KEY_ACTIONS: Record<string, InputAction> = {
  KeyQ: 'skill',
  KeyE: 'ultimate',
  KeyR: 'ultimate',
  Space: 'dash',
  ShiftLeft: 'dash',
  ShiftRight: 'dash',
  Escape: 'pause',
  KeyP: 'pause',
};

const NAV_KEYS: Record<string, InputAction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, -1], ArrowUp: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};

const DEADZONE = 0.22;
const NAV_REPEAT_DELAY = 0.38;
const NAV_REPEAT_RATE = 0.12;

function applyDeadzone(x: number, y: number, out: Vector2): Vector2 {
  const length = Math.hypot(x, y);
  if (length < DEADZONE) return out.set(0, 0);
  const scaled = Math.min(1, (length - DEADZONE) / (1 - DEADZONE));
  return out.set((x / length) * scaled, (y / length) * scaled);
}

export class InputManager {
  device: InputDevice = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 'touch' : 'keyboard';
  /** Ground-plane movement intent: x = screen right, y = screen down (world +z). */
  readonly movement = new Vector2();
  /** Pointer position in normalised device coordinates. */
  readonly pointer = new Vector2();
  pointerActive = false;
  /** Right-stick or touch-drag aim direction (screen space, unit or zero). */
  readonly aimStick = new Vector2();
  /** Touch drag aim magnitude 0..1 while a skill button is held. */
  aimStickStrength = 0;
  basicHeld = false;
  /** Fires when the active device family changes so glyphs can update. */
  onDeviceChange?: (device: InputDevice) => void;
  /** Called on the first trusted gesture (audio unlock). */
  onFirstGesture?: () => void;

  private readonly keys = new Set<string>();
  private readonly pending = new Set<InputAction>();
  private readonly touchMove = new Vector2();
  private readonly gamepadMove = new Vector2();
  private mouseBasic = false;
  private touchBasic = false;
  private gamepadBasic = false;
  private readonly previousButtons = new Map<number, boolean[]>();
  private navHeld: InputAction | null = null;
  private navTimer = 0;
  private gestured = false;
  private canvas?: HTMLElement;

  attach(canvas: HTMLElement): void {
    this.canvas = canvas;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('pointerdown', this.onAnyGesture, { capture: true });
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('pointerdown', this.onAnyGesture, { capture: true });
    this.canvas?.removeEventListener('pointermove', this.onPointerMove);
    this.canvas?.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.canvas?.removeEventListener('contextmenu', this.onContextMenu);
  }

  /** Call once per frame before reading state. */
  poll(delta: number): void {
    this.pollGamepads(delta);
    let x = 0;
    let y = 0;
    for (const code of this.keys) {
      const move = MOVE_KEYS[code];
      if (move) {
        x += move[0];
        y += move[1];
      }
    }
    if (x !== 0 || y !== 0) this.movement.set(x, y).normalize();
    else if (this.gamepadMove.lengthSq() > 0) this.movement.copy(this.gamepadMove);
    else this.movement.copy(this.touchMove);
    this.basicHeld = this.mouseBasic || this.touchBasic || this.gamepadBasic || this.keys.has('KeyJ');
  }

  consume(action: InputAction): boolean {
    return this.pending.delete(action);
  }

  /** Drops queued one-shots (e.g. when a screen changes). */
  clear(): void {
    this.pending.clear();
    this.mouseBasic = false;
    this.touchBasic = false;
  }

  trigger(action: InputAction): void {
    this.pending.add(action);
  }

  // ------------------------------------------------------------ touch API

  setTouchMove(x: number, y: number): void {
    this.setDevice('touch');
    this.touchMove.set(x, y);
    if (this.touchMove.lengthSq() > 1) this.touchMove.normalize();
  }

  setTouchBasic(held: boolean): void {
    this.setDevice('touch');
    this.touchBasic = held;
  }

  setTouchAim(x: number, y: number, strength: number): void {
    this.aimStick.set(x, y);
    this.aimStickStrength = strength;
  }

  // ------------------------------------------------------------- internals

  private setDevice(device: InputDevice): void {
    if (this.device === device) return;
    this.device = device;
    this.onDeviceChange?.(device);
  }

  private readonly onAnyGesture = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') this.setDevice('touch');
    if (!this.gestured) {
      this.gestured = true;
      this.onFirstGesture?.();
    }
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target;
    // Form controls keep their native keys; Escape releases focus from them.
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) {
      if (event.code === 'Escape') target.blur();
      return;
    }
    if (!this.gestured) {
      this.gestured = true;
      this.onFirstGesture?.();
    }
    this.setDevice('keyboard');
    if (MOVE_KEYS[event.code] || event.code === 'Space') event.preventDefault();
    if (event.repeat) return;
    this.keys.add(event.code);
    const action = KEY_ACTIONS[event.code];
    if (action) this.pending.add(action);
    const nav = NAV_KEYS[event.code];
    if (nav) this.pending.add(nav);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
    this.mouseBasic = false;
    this.touchBasic = false;
    this.gamepadBasic = false;
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    this.setDevice('keyboard');
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    this.pointerActive = true;
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    this.onPointerMove(event);
    if (event.button === 0) this.mouseBasic = true;
    if (event.button === 2) this.pending.add('skill');
    if (event.button === 1) {
      event.preventDefault();
      this.pending.add('ultimate');
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.button === 0) this.mouseBasic = false;
  };

  private readonly onContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  private pollGamepads(delta: number): void {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    let active: Gamepad | null = null;
    for (const pad of pads) {
      if (pad?.connected && pad.mapping === 'standard') {
        active = pad;
        break;
      }
    }
    if (!active) {
      this.gamepadMove.set(0, 0);
      this.gamepadBasic = false;
      return;
    }
    const axes = active.axes;
    applyDeadzone(axes[0] ?? 0, axes[1] ?? 0, this.gamepadMove);
    const aim = applyDeadzone(axes[2] ?? 0, axes[3] ?? 0, new Vector2());
    const buttons = active.buttons.map((button) => button.pressed);
    const previous = this.previousButtons.get(active.index) ?? [];
    const pressed = (index: number) => Boolean(buttons[index]) && !previous[index];
    const anyInput = this.gamepadMove.lengthSq() > 0 || aim.lengthSq() > 0 || buttons.some(Boolean);
    if (anyInput) {
      this.setDevice('gamepad');
      if (!this.gestured) {
        this.gestured = true;
        this.onFirstGesture?.();
      }
    }
    if (this.device === 'gamepad') {
      this.aimStick.copy(aim);
      this.aimStickStrength = aim.length();
    }
    this.gamepadBasic = Boolean(buttons[7]);
    if (pressed(0)) this.pending.add('confirm');
    if (pressed(1)) this.pending.add('back');
    if (pressed(0) || pressed(6)) this.pending.add('dash');
    if (pressed(2) || pressed(4)) this.pending.add('skill');
    if (pressed(3) || pressed(5)) this.pending.add('ultimate');
    if (pressed(9) || pressed(8)) this.pending.add('pause');
    if (pressed(4)) this.pending.add('tabPrev');
    if (pressed(5)) this.pending.add('tabNext');

    // Menu navigation with auto-repeat from the d-pad or left stick.
    let nav: InputAction | null = null;
    const stickX = axes[0] ?? 0;
    const stickY = axes[1] ?? 0;
    if (buttons[12] || stickY < -0.6) nav = 'up';
    else if (buttons[13] || stickY > 0.6) nav = 'down';
    else if (buttons[14] || stickX < -0.6) nav = 'left';
    else if (buttons[15] || stickX > 0.6) nav = 'right';
    if (nav !== this.navHeld) {
      this.navHeld = nav;
      this.navTimer = NAV_REPEAT_DELAY;
      if (nav) this.pending.add(nav);
    } else if (nav) {
      this.navTimer -= delta;
      if (this.navTimer <= 0) {
        this.navTimer = NAV_REPEAT_RATE;
        this.pending.add(nav);
      }
    }
    this.previousButtons.set(active.index, buttons);
  }
}
