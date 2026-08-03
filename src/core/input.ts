// Pointer-lock mouse look + key state. Consumers read action state each frame;
// look deltas accumulate between reads so no motion is lost at low frame rates.

export interface LookDelta {
  dx: number;
  dy: number;
}

const KEY_ACTIONS: Record<string, string> = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  Space: 'jump',
  ShiftLeft: 'sprint',
  ControlLeft: 'crouch',
  KeyC: 'crouch',
  KeyR: 'reload',
  KeyF: 'interact',
  KeyQ: 'leanLeft',
  KeyE: 'leanRight',
  Tab: 'inventory',
  KeyM: 'map',
};

export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private look: LookDelta = { dx: 0, dy: 0 };
  private locked = false;
  mouseDown = [false, false, false];
  private mousePressed = [false, false, false];

  constructor(private element: HTMLElement, autoLock = true) {
    window.addEventListener('keydown', (e) => {
      const action = KEY_ACTIONS[e.code];
      if (action) {
        if (!this.down.has(action)) this.pressed.add(action);
        this.down.add(action);
        if (e.code === 'Tab') e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      const action = KEY_ACTIONS[e.code];
      if (action) this.down.delete(action);
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.look.dx += e.movementX;
      this.look.dy += e.movementY;
    });
    window.addEventListener('mousedown', (e) => {
      if (e.button < 3) {
        if (!this.mouseDown[e.button]) this.mousePressed[e.button] = true;
        this.mouseDown[e.button] = true;
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button < 3) this.mouseDown[e.button] = false;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.element;
    });
    if (autoLock) {
      this.element.addEventListener('click', () => {
        if (!this.locked) this.element.requestPointerLock();
      });
    }
  }

  get isLocked(): boolean {
    return this.locked;
  }

  isDown(action: string): boolean {
    return this.down.has(action);
  }

  /** Consume-on-read edge trigger: true once per physical key press. */
  wasPressed(action: string): boolean {
    if (this.pressed.has(action)) {
      this.pressed.delete(action);
      return true;
    }
    return false;
  }

  wasMousePressed(button: number): boolean {
    if (this.mousePressed[button]) {
      this.mousePressed[button] = false;
      return true;
    }
    return false;
  }

  /** Returns and clears accumulated mouse look deltas. */
  consumeLook(): LookDelta {
    const d = { ...this.look };
    this.look.dx = 0;
    this.look.dy = 0;
    return d;
  }

  /** Call once at the end of each frame. */
  endFrame(): void {
    this.pressed.clear();
    this.mousePressed[0] = this.mousePressed[1] = this.mousePressed[2] = false;
  }
}
