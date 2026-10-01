/**
 * Progressive Web App runtime: service worker registration, update hand-off
 * and install prompt. This module has no UI; callers render their own.
 *
 *   initPwa({
 *     onUpdateReady: (apply) => showUpdateToast(apply),
 *     onOfflineReady: () => showToast('Ready to play offline'),
 *     onInstallAvailable: (available) => installButton.hidden = !available,
 *   });
 */

export interface PwaCallbacks {
  /** A new service worker is waiting. Calling `apply()` activates it and reloads the page once. */
  onUpdateReady?: (apply: () => void) => void;
  /** The first service worker finished installing: the app now works offline. */
  onOfflineReady?: () => void;
  /** `true` when an install prompt was captured; `false` once installed (or unavailable). */
  onInstallAvailable?: (available: boolean) => void;
}

/** Chromium's `beforeinstallprompt` event (not in lib.dom). */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: readonly string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

/** iOS Safari exposes `navigator.standalone` when launched from the home screen. */
interface NavigatorStandalone {
  readonly standalone?: boolean;
}

const UPDATE_INTERVAL_MS = 30 * 60 * 1000;

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let callbacks: PwaCallbacks = {};
let initialized = false;

export function initPwa(cbs: PwaCallbacks = {}): void {
  callbacks = cbs;
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  // Install prompt capture works independently of the service worker.
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); // keep the mini-infobar from showing; the app decides when to prompt
    deferredPrompt = event as BeforeInstallPromptEvent;
    callbacks.onInstallAvailable?.(true);
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    callbacks.onInstallAvailable?.(false);
  });

  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

  if (document.readyState === 'complete') {
    void register();
  } else {
    window.addEventListener('load', () => void register(), { once: true });
  }
}

async function register(): Promise<void> {
  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
      scope: import.meta.env.BASE_URL,
      updateViaCache: 'none',
    });
  } catch (error) {
    console.warn('[pwa] service worker registration failed', error);
    return;
  }

  // An update may already be waiting from a previous visit.
  if (registration.waiting && navigator.serviceWorker.controller) {
    notifyUpdate(registration.waiting);
  }

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state !== 'installed') return;
      if (navigator.serviceWorker.controller) {
        // A previous worker controls this page: this is an update.
        notifyUpdate(installing);
      } else {
        // First install: everything is precached.
        callbacks.onOfflineReady?.();
      }
    });
  });

  const checkForUpdate = (): void => {
    if (registration.installing || !navigator.onLine) return;
    registration.update().catch(() => undefined);
  };
  window.setInterval(checkForUpdate, UPDATE_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
}

function notifyUpdate(worker: ServiceWorker): void {
  let applied = false;
  callbacks.onUpdateReady?.(() => {
    if (applied) return;
    applied = true;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });
    worker.postMessage({ type: 'SKIP_WAITING' });
  });
}

/** Whether a native install prompt is available right now (always false on iOS). */
export function canInstall(): boolean {
  return deferredPrompt !== null && !isStandalone();
}

/**
 * Show the native install prompt. Resolves `'unavailable'` when no prompt was
 * captured (e.g. iOS Safari, already installed, or the browser declined).
 * On iOS, guide users to Share → "Add to Home Screen" instead.
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const prompt = deferredPrompt;
  if (!prompt) return 'unavailable';
  deferredPrompt = null; // a captured prompt can only be used once
  try {
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === 'dismissed') callbacks.onInstallAvailable?.(false);
    return outcome;
  } catch {
    callbacks.onInstallAvailable?.(false);
    return 'unavailable';
  }
}

/** True when running as an installed app (standalone/fullscreen display, or iOS home-screen). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const displayModes = ['standalone', 'fullscreen'] as const;
  if (displayModes.some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches)) return true;
  return (window.navigator as Navigator & NavigatorStandalone).standalone === true;
}
