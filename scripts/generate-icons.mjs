#!/usr/bin/env node
/**
 * Generates the Zukan Arena PWA icon set.
 *
 *   npm run generate:icons
 *
 * The emblem is authored here as an SVG template (single source of truth) and
 * written to public/icons/icon.svg, then rasterised with headless Chromium:
 *
 *   icon-192.png            purpose "any"  (rounded square, transparent corners)
 *   icon-512.png            purpose "any"
 *   icon-maskable-512.png   purpose "maskable" (full-bleed, art inside the 80% safe zone)
 *   apple-touch-icon-180.png  full-bleed (iOS applies its own corner mask; no transparency)
 *   favicon-32.png          simplified, heavier strokes for legibility at tiny sizes
 *
 * Requires Playwright (playwright-core or playwright). It is NOT a project
 * dependency; it is resolved from the local project, then the global npm root,
 * and finally you can run:  npx -y -p playwright-core node scripts/generate-icons.mjs
 * Set CHROMIUM_PATH to force a specific Chromium binary (otherwise the newest
 * build under PLAYWRIGHT_BROWSERS_PATH, or Playwright's default, is used).
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'icons');

// ---------------------------------------------------------------------------
// Emblem
// ---------------------------------------------------------------------------

const ELEMENTS = [
  // Clockwise from the top vertex of the crest.
  { id: 'plasma', color: '#f4cf4a' },
  { id: 'hydro', color: '#4fd1e8' },
  { id: 'nature', color: '#6cc96e' },
  { id: 'earth', color: '#c99a5b' },
  { id: 'void', color: '#a07cf0' },
  { id: 'gale', color: '#bfeee4' },
];

const C = 256; // centre of the 512 artboard

/** Pointy-top hexagon points around the centre. */
function hexPoints(r, rotationDeg = -90) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = ((rotationDeg + i * 60) * Math.PI) / 180;
    return [C + r * Math.cos(a), C + r * Math.sin(a)];
  });
}
const fmt = (n) => Number(n.toFixed(2));
const poly = (pts) => pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' ');

/**
 * Bold geometric "Z" monogram with chamfered outer corners. Bars and the
 * diagonal share an optical stroke weight of ~44px.
 */
const Z_PATH = [
  'M 192 156', // top bar (chamfered top-left corner)
  'L 332 156',
  'L 344 168',
  'L 344 196',
  'L 232 316', // diagonal, upper edge
  'L 344 316', // bottom bar
  'L 344 332',
  'L 320 356', // chamfered bottom-right corner
  'L 180 356',
  'L 168 344',
  'L 168 316',
  'L 280 196', // diagonal, lower edge
  'L 168 196',
  'L 168 180',
  'Z',
].join(' ');
/** Bevel highlight along the top face of the upper bar. */
const Z_HIGHLIGHT = 'M 192 156 L 332 156 L 344 168 L 344 171 L 177 171 Z';

/**
 * @param {object} o
 * @param {boolean} [o.fullBleed]  square background with no rounded corners (maskable / iOS)
 * @param {number}  [o.scale]      scale of the crest art around the centre
 * @param {boolean} [o.simple]     simplified detail for very small sizes
 */
function emblemSvg({ fullBleed = false, scale = 1, simple = false } = {}) {
  const outer = hexPoints(186);
  const inner = hexPoints(170);
  const dotR = simple ? 20 : 13;
  const ringW = simple ? 14 : 5;
  const bg = fullBleed
    ? `<rect width="512" height="512" fill="url(#bg)"/>`
    : `<rect x="8" y="8" width="496" height="496" rx="112" fill="url(#bg)"/>
    <rect x="9.5" y="9.5" width="493" height="493" rx="110.5" fill="none" stroke="#f6e2b0" stroke-opacity=".14" stroke-width="3"/>`;

  const dots = outer
    .map(
      ([x, y], i) =>
        `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${dotR + (simple ? 4 : 5)}" fill="#0b1020"/>
      <circle cx="${fmt(x)}" cy="${fmt(y)}" r="${dotR}" fill="${ELEMENTS[i].color}"/>${
        simple
          ? ''
          : `
      <circle cx="${fmt(x - 3.5)}" cy="${fmt(y - 4)}" r="4" fill="#fff" fill-opacity=".45"/>`
      }`,
    )
    .join('\n      ');

  // Small gold lozenges on the midpoint of each crest edge (detail layer only).
  const studs = simple
    ? ''
    : hexPoints(186 * Math.cos(Math.PI / 6), -60)
        .map(([x, y], i) => {
          const rot = -60 + i * 60 + 90;
          return `<rect x="${fmt(x - 4.5)}" y="${fmt(y - 4.5)}" width="9" height="9" transform="rotate(${rot + 45} ${fmt(x)} ${fmt(y)})" fill="#f6e2b0" stroke="#0b1020" stroke-width="2.5"/>`;
        })
        .join('');

  const art = `
    <g transform="translate(${C} ${C}) scale(${scale}) translate(${-C} ${-C})">
      <!-- soft gold halo behind the crest -->
      <circle cx="256" cy="256" r="170" fill="url(#halo)"/>
      <!-- crest -->
      <polygon points="${poly(outer)}" fill="url(#crestFill)" stroke="url(#gold)" stroke-width="${ringW}" stroke-linejoin="round"/>
      ${simple ? '' : `<polygon points="${poly(inner)}" fill="none" stroke="#e8c27a" stroke-opacity=".45" stroke-width="1.5" stroke-linejoin="round"/>`}
      ${studs}
      <!-- monogram -->
      <g filter="url(#lift)">
        <path d="${Z_PATH}" fill="url(#gold)" ${simple ? 'transform="translate(256 256) scale(1.12) translate(-256 -256)"' : ''}/>
      </g>
      ${simple ? '' : `<path d="${Z_HIGHLIGHT}" fill="#fff8e6" fill-opacity=".45"/>`}
      <!-- element dots on the crest vertices -->
      ${dots}
    </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <title>Zukan Arena</title>
  <defs>
    <radialGradient id="bg" cx="50%" cy="42%" r="70%">
      <stop offset="0" stop-color="#16213d"/>
      <stop offset="1" stop-color="#0b1020"/>
    </radialGradient>
    <linearGradient id="gold" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#e8c27a"/>
      <stop offset=".55" stop-color="#f1d595"/>
      <stop offset="1" stop-color="#f6e2b0"/>
    </linearGradient>
    <radialGradient id="crestFill" cx="50%" cy="38%" r="65%">
      <stop offset="0" stop-color="#1c2a4c"/>
      <stop offset="1" stop-color="#0e1529"/>
    </radialGradient>
    <radialGradient id="halo" cx="50%" cy="50%" r="50%">
      <stop offset=".55" stop-color="#e8c27a" stop-opacity="0"/>
      <stop offset=".9" stop-color="#e8c27a" stop-opacity=".10"/>
      <stop offset="1" stop-color="#e8c27a" stop-opacity="0"/>
    </radialGradient>
    <filter id="lift" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="6" stdDeviation="7" flood-color="#000" flood-opacity=".55"/>
    </filter>
  </defs>
  ${bg}
  ${art}
</svg>
`;
}

// ---------------------------------------------------------------------------
// Rasterisation
// ---------------------------------------------------------------------------

async function loadChromium() {
  const candidates = ['playwright-core', 'playwright'];
  const requireFrom = [createRequire(join(root, 'package.json'))];
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    requireFrom.push(createRequire(join(globalRoot, 'noop.js')));
  } catch {
    /* npm not on PATH; ignore */
  }
  for (const req of requireFrom) {
    for (const name of candidates) {
      try {
        const mod = await import(pathToFileURL(req.resolve(name)).href);
        return (mod.default ?? mod).chromium;
      } catch {
        /* try next */
      }
    }
  }
  throw new Error(
    'Playwright not found. Run: npx -y -p playwright-core node scripts/generate-icons.mjs',
  );
}

function findChromiumBinary() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !existsSync(base)) return undefined;
  const builds = readdirSync(base)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const b of builds) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
      const p = join(base, b, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const OUTPUTS = [
  { file: 'icon-192.png', size: 192, opts: {} },
  { file: 'icon-512.png', size: 512, opts: {} },
  // Maskable: art scaled so the crest (incl. dots, radius ~199) stays well within the
  // central 80% safe-zone circle (radius 204.8 at 512) after scaling.
  { file: 'icon-maskable-512.png', size: 512, opts: { fullBleed: true, scale: 0.8 } },
  { file: 'apple-touch-icon-180.png', size: 180, opts: { fullBleed: true, scale: 0.88 } },
  { file: 'favicon-32.png', size: 32, opts: { simple: true, scale: 1.12 } },
];

async function main() {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'icon.svg'), emblemSvg());
  console.log('wrote public/icons/icon.svg');

  const chromium = await loadChromium();
  const executablePath = findChromiumBinary();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    for (const { file, size, opts } of OUTPUTS) {
      const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
      const svg = emblemSvg(opts).replace('width="512" height="512"', `width="${size}" height="${size}"`);
      await page.setContent(
        `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`,
      );
      await page.screenshot({
        path: join(outDir, file),
        omitBackground: true,
        clip: { x: 0, y: 0, width: size, height: size },
      });
      await page.close();
      console.log(`wrote public/icons/${file}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
