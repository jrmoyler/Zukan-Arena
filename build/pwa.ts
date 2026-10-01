/// <reference path="./node-shims.d.ts" />
/**
 * Zukan Arena PWA plugin — a small, dependency-free alternative to workbox /
 * vite-plugin-pwa.
 *
 * On `vite build`, once the bundle (and the copied `public/` directory) has been
 * written to the output directory, this plugin:
 *
 *   1. collects every output file matching `include` (minus `exclude`),
 *   2. hashes their paths + contents into a single cache version string, and
 *   3. writes `<outDir>/sw.js`, a plain ES2020 service worker that precaches
 *      those files and serves the app offline.
 *
 * It does nothing during `vite serve` (no service worker in dev).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

export interface PwaPluginOptions {
  /**
   * Globs (relative to the build output directory, `/`-separated) of files to
   * precache. Files from `public/` are matched at their copied location, e.g.
   * `public/characters/cutout/a.webp` → `characters/cutout/a.webp`.
   */
  include?: string[];
  /** Globs excluded from precaching, even when matched by `include`. */
  exclude?: string[];
  /** Output file name of the service worker. Default `sw.js`. */
  swFileName?: string;
  /** Prefix for every cache this worker owns. Default `zukan-arena-`. */
  cachePrefix?: string;
  /** Max entries in the runtime (non-precached) cache. Default 60. */
  runtimeMaxEntries?: number;
  /** Navigation network timeout before falling back to the cached shell (ms). Default 4000. */
  navigationTimeoutMs?: number;
}

export const DEFAULT_PRECACHE_INCLUDE: readonly string[] = [
  '**/*.{js,mjs,css,html}',
  'manifest.webmanifest',
  'icons/**/*',
  'characters/cutout/**/*',
];

export const DEFAULT_PRECACHE_EXCLUDE: readonly string[] = [
  'sw.js',
  'textures/**',
  'docs/**',
  '**/*.map',
  '**/.DS_Store',
];

interface PrecacheEntry {
  /** Path relative to the output dir / SW scope, URL-encoded per segment. */
  url: string;
  /** Short content hash, used to reuse unchanged files across SW versions. */
  rev: string;
  size: number;
}

/** Convert a small glob dialect (`**`, `*`, `?`, `{a,b}`) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let inGroup = false;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === '*') {
      if (glob.charAt(i + 1) === '*') {
        const followedBySlash = glob.charAt(i + 2) === '/';
        re += followedBySlash ? '(?:.*/)?' : '.*';
        i += followedBySlash ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '{') {
      inGroup = true;
      re += '(?:';
    } else if (ch === '}' && inGroup) {
      inGroup = false;
      re += ')';
    } else if (ch === ',' && inGroup) {
      re += '|';
    } else {
      re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

function walk(dir: string, root: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, root, out);
    else if (entry.isFile()) out.push(relative(root, abs).replace(/\\/g, '/'));
  }
}

function shortHash(data: string | Uint8Array, length = 12): string {
  return createHash('sha256').update(data).digest('hex').slice(0, length);
}

export function pwaPlugin(options: PwaPluginOptions = {}): Plugin {
  const include = (options.include ?? DEFAULT_PRECACHE_INCLUDE).map(globToRegExp);
  const exclude = (options.exclude ?? DEFAULT_PRECACHE_EXCLUDE).map(globToRegExp);
  const swFileName = options.swFileName ?? 'sw.js';
  const cachePrefix = options.cachePrefix ?? 'zukan-arena-';
  const runtimeMaxEntries = options.runtimeMaxEntries ?? 60;
  const navigationTimeoutMs = options.navigationTimeoutMs ?? 4000;
  let config: ResolvedConfig | undefined;

  return {
    name: 'zukan-arena:pwa',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    writeBundle: {
      order: 'post',
      sequential: true,
      handler(outputOptions) {
        if (!config || config.build.ssr) return;
        const outDir = outputOptions.dir ?? resolve(config.root, config.build.outDir);
        if (!existsSync(outDir)) return;

        const files: string[] = [];
        walk(outDir, outDir, files);
        const selected = files
          .filter((f) => f !== swFileName)
          .filter((f) => include.some((re) => re.test(f)) && !exclude.some((re) => re.test(f)))
          .sort();

        const version = createHash('sha256');
        const entries: PrecacheEntry[] = selected.map((file) => {
          const bytes = readFileSync(join(outDir, file));
          version.update(file).update('\0').update(bytes).update('\0');
          return {
            url: file.split('/').map(encodeURIComponent).join('/'),
            rev: shortHash(bytes, 10),
            size: bytes.byteLength,
          };
        });
        const versionId = version.digest('hex').slice(0, 12);

        writeFileSync(
          join(outDir, swFileName),
          renderServiceWorker({ version: versionId, entries, cachePrefix, runtimeMaxEntries, navigationTimeoutMs }),
        );

        const totalMb = entries.reduce((sum, e) => sum + e.size, 0) / (1024 * 1024);
        config.logger.info(
          `\x1b[36m[pwa]\x1b[0m ${swFileName} v${versionId}: precaching ${entries.length} files (${totalMb.toFixed(2)} MB)`,
        );
        if (!entries.some((e) => e.url === 'index.html')) {
          config.logger.warn('[pwa] index.html is not precached; offline navigation fallback will not work.');
        }
      },
    },
  };
}

interface RenderOptions {
  version: string;
  entries: PrecacheEntry[];
  cachePrefix: string;
  runtimeMaxEntries: number;
  navigationTimeoutMs: number;
}

function renderServiceWorker(o: RenderOptions): string {
  const manifest = o.entries.map((e) => '  ' + JSON.stringify([e.url, e.rev])).join(',\n');
  return `/*
 * Zukan Arena service worker.
 * Generated by build/pwa.ts at build time. Do not edit by hand.
 *
 * Strategies:
 *   - navigations          network-first (with timeout) -> cached index.html (offline / SPA shell)
 *   - precached assets     cache-first
 *   - other same-origin    stale-while-revalidate into a capped runtime cache
 *   - cross-origin static  stale-while-revalidate (fonts may be cached even when opaque)
 */
'use strict';

const VERSION = ${JSON.stringify(o.version)};
const CACHE_PREFIX = ${JSON.stringify(o.cachePrefix)};
const PRECACHE_NAME = CACHE_PREFIX + VERSION;
const RUNTIME_NAME = CACHE_PREFIX + 'runtime';
const RUNTIME_MAX_ENTRIES = ${o.runtimeMaxEntries};
const NAVIGATION_TIMEOUT_MS = ${o.navigationTimeoutMs};
const REV_HEADER = 'x-zukan-precache-rev';
const INSTALL_CONCURRENCY = 6;

/** [path relative to the SW scope, content revision] */
const PRECACHE_MANIFEST = [
${manifest}
];

// Resolve every path against the registration scope so the worker respects
// Vite's \`base\` (e.g. https://host/game/ when built with base: '/game/').
const SCOPE = self.registration.scope;
const toUrl = (path) => new URL(path, SCOPE).href;
const PRECACHE = PRECACHE_MANIFEST.map(([path, rev]) => ({ url: toUrl(path), rev }));
const PRECACHE_URLS = new Set(PRECACHE.map((entry) => entry.url));
const SHELL_URL = toUrl('index.html');

// ---------------------------------------------------------------------------
// Install: fill the versioned precache. Unchanged files (same revision) are
// copied from a previous version's cache instead of being downloaded again.
// The new worker then waits until the page asks it to take over.
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(precacheAll());
});

async function precacheAll() {
  const cache = await caches.open(PRECACHE_NAME);
  const previous = await previousPrecaches();
  const queue = PRECACHE.slice();

  async function worker() {
    while (queue.length > 0) {
      const entry = queue.shift();
      if (await cache.match(entry.url)) continue;

      const reused = await findReusable(previous, entry);
      if (reused) {
        await cache.put(entry.url, reused);
        continue;
      }
      // cache: 'reload' bypasses the HTTP cache so we never precache stale bytes.
      const response = await fetch(new Request(entry.url, { cache: 'reload', credentials: 'same-origin' }));
      if (!response.ok) {
        throw new Error('[sw] precache failed for ' + entry.url + ' (' + response.status + ')');
      }
      await cache.put(entry.url, await withRevision(response, entry.rev));
    }
  }

  await Promise.all(Array.from({ length: INSTALL_CONCURRENCY }, worker));
}

async function previousPrecaches() {
  const names = await caches.keys();
  return Promise.all(
    names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== PRECACHE_NAME && name !== RUNTIME_NAME)
      .map((name) => caches.open(name)),
  );
}

async function findReusable(previousCaches, entry) {
  for (const old of previousCaches) {
    const match = await old.match(entry.url);
    if (match && match.headers.get(REV_HEADER) === entry.rev) return match;
  }
  return undefined;
}

/** Re-wrap a response so it carries its content revision as a header. */
async function withRevision(response, rev) {
  const headers = new Headers(response.headers);
  headers.set(REV_HEADER, rev);
  return new Response(await response.blob(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Update hand-off: the page posts { type: 'SKIP_WAITING' } when the user
// accepts the update; we never skip waiting on our own.
// ---------------------------------------------------------------------------

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ---------------------------------------------------------------------------
// Activate: drop caches from previous versions and take control of open pages.
// ---------------------------------------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== PRECACHE_NAME && name !== RUNTIME_NAME)
          .map((name) => caches.delete(name)),
      );
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })(),
  );
});

// ---------------------------------------------------------------------------
// Fetch routing
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Never touch non-GET requests or partial-content (Range) requests.
  if (request.method !== 'GET' || request.headers.has('range')) return;

  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  if (url.origin === self.location.origin) {
    if (PRECACHE_URLS.has(url.href)) {
      event.respondWith(cacheFirst(request, url.href));
    } else {
      event.respondWith(staleWhileRevalidate(event, request));
    }
    return;
  }

  // Cross-origin: only static resource types (fonts, stylesheets, images,
  // scripts). API calls and other fetches go straight to the network.
  if (isCrossOriginStatic(request, url)) {
    event.respondWith(staleWhileRevalidate(event, request));
  }
});

/** Network-first for page loads, falling back to the precached app shell. */
async function handleNavigation(event) {
  const cache = await caches.open(PRECACHE_NAME);
  const shell = await cache.match(SHELL_URL);

  const network = (async () => {
    const preloaded = await event.preloadResponse;
    return preloaded || fetch(event.request);
  })();
  network.catch(() => undefined); // avoid an unhandled rejection if the timeout wins

  // Keep the worker alive until the preload settles (avoids "preload cancelled" warnings).
  event.waitUntil(network.then(() => undefined, () => undefined));

  try {
    if (!shell) return await network;
    // With a shell available, don't let a stalled connection hang the launch.
    return await Promise.race([network, timeout(NAVIGATION_TIMEOUT_MS)]);
  } catch (error) {
    if (shell) return shell;
    throw error;
  }
}

/** Cache-first for precached URLs; repairs the entry from the network if it went missing. */
async function cacheFirst(request, key) {
  const cache = await caches.open(PRECACHE_NAME);
  const cached = await cache.match(key);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    await cache.put(key, response.clone());
  }
  return response;
}

/** Serve from the runtime cache immediately (if present) and refresh it in the background. */
async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(RUNTIME_NAME);
  const cached = await cache.match(request);

  const refresh = fetch(request)
    .then(async (response) => {
      if (isCacheable(request, response)) {
        await cache.delete(request); // re-insert so key order approximates recency
        await cache.put(request, response.clone());
        await trimCache(cache, RUNTIME_MAX_ENTRIES);
      }
      return response;
    });

  if (cached) {
    event.waitUntil(refresh.catch(() => undefined));
    return cached;
  }
  return refresh;
}

function isCacheable(request, response) {
  if (!response) return false;
  if (response.type === 'opaque') return isFontRequest(request); // opaque: status unknown, fonts only
  return response.status === 200 && (response.type === 'basic' || response.type === 'cors');
}

function isFontRequest(request) {
  if (request.destination === 'font') return true;
  const host = new URL(request.url).hostname;
  return host === 'fonts.googleapis.com' || host === 'fonts.gstatic.com';
}

function isCrossOriginStatic(request, url) {
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return true;
  return ['font', 'style', 'image', 'script'].includes(request.destination);
}

/** Evict the oldest entries (Cache keys are returned in insertion order). */
async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - maxEntries; i++) {
    await cache.delete(keys[i]);
  }
}

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}
`;
}

export default pwaPlugin;
