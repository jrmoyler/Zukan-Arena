/** localStorage access that never throws (private mode, quota, disabled storage). */

const PREFIX = 'zukan-arena:';

export function readJson<T>(key: string): T | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Persistence is a convenience; the game keeps running from memory.
  }
}

export function removeKey(key: string): void {
  try {
    globalThis.localStorage?.removeItem(PREFIX + key);
  } catch {
    // Ignore unavailable storage.
  }
}

/** Minimal observable store used for settings and the player profile. */
export class Store<T extends object> {
  private value: T;
  private readonly listeners = new Set<(value: Readonly<T>) => void>();

  constructor(
    private readonly key: string,
    defaults: T,
    migrate: (stored: Partial<T>) => Partial<T> = (stored) => stored,
  ) {
    const stored = readJson<Partial<T>>(key);
    this.value = { ...defaults, ...(stored ? migrate(stored) : {}) };
  }

  get(): Readonly<T> {
    return this.value;
  }

  update(patch: Partial<T> | ((current: Readonly<T>) => Partial<T>)): void {
    const next = typeof patch === 'function' ? patch(this.value) : patch;
    this.value = { ...this.value, ...next };
    writeJson(this.key, this.value);
    for (const listener of this.listeners) listener(this.value);
  }

  subscribe(listener: (value: Readonly<T>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(defaults: T): void {
    this.value = { ...defaults };
    removeKey(this.key);
    for (const listener of this.listeners) listener(this.value);
  }
}
