import type { ElementKind } from '../types';

/** Inline SVG icon set (24px grid, currentColor) so the UI needs no icon font. */

const svg = (body: string, extra = '') =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" ${extra}>${body}</svg>`;

const ELEMENT_PATHS: Record<ElementKind, string> = {
  earth: '<path d="M2.5 20 9.5 7l3.6 6.2L15.4 10 21.5 20Z" fill="currentColor"/><path d="m9.5 7 1.4 5.2 2.2 1" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="1.2"/>',
  hydro: '<path d="M12 2.8s-6.6 7.6-6.6 12a6.6 6.6 0 0 0 13.2 0c0-4.4-6.6-12-6.6-12Z" fill="currentColor"/><path d="M9 15.5a3 3 0 0 0 3 3" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.6" stroke-linecap="round"/>',
  gale: '<path d="M3 8.5h10.5a3 3 0 1 0-3-3M3 15.5h14a3 3 0 1 1-3 3M3 12h7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  plasma: '<path d="M13.6 2 4.5 13.6h6.6L10 22l9.4-12h-6.8Z" fill="currentColor"/>',
  nature: '<path d="M4.5 19.5C4.5 10 11 4.5 20 4.5c0 9-6 15-15.5 15Z" fill="currentColor"/><path d="M4.5 19.5 13 11" fill="none" stroke="rgba(0,0,0,.28)" stroke-width="1.6" stroke-linecap="round"/>',
  void: '<path d="M12.2 3.2a8.8 8.8 0 1 0 8.6 10.6A7 7 0 0 1 12.2 3.2Z" fill="currentColor"/><circle cx="17.2" cy="6.6" r="1.6" fill="currentColor"/>',
};

export function elementIcon(element: ElementKind): string {
  return svg(ELEMENT_PATHS[element], `data-element="${element}"`);
}

export const ICONS = {
  basic: svg('<circle cx="12" cy="12" r="4.2" fill="currentColor"/><path d="M12 2.5v3.2M12 18.3v3.2M2.5 12h3.2M18.3 12h3.2M5.3 5.3l2.2 2.2M16.5 16.5l2.2 2.2M5.3 18.7l2.2-2.2M16.5 7.5l2.2-2.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
  dash: svg('<path d="M4 6l6 6-6 6M11 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M19.5 6v12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'),
  ultimate: svg('<path d="m12 2 2.6 6.4L21.5 9l-5.2 4.5 1.6 6.9L12 16.8l-5.9 3.6 1.6-6.9L2.5 9l6.9-.6Z" fill="currentColor"/>'),
  play: svg('<path d="M7 4.5v15l12.5-7.5Z" fill="currentColor"/>'),
  swords: svg('<path d="M4 3.5 13 12.5M20 3.5 11 12.5M6.5 14.5l3 3M17.5 14.5l-3 3M3.5 20.5l3-3M20.5 20.5l-3-3" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M4 3.5h3l9.5 9.5M20 3.5h-3L7.5 13" fill="none" stroke="currentColor" stroke-width="1.4"/>'),
  ladder: svg('<path d="M5 21V3M19 21V3M5 7h14M5 12h14M5 17h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="3.5" r="1.8" fill="currentColor"/>'),
  target: svg('<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>'),
  book: svg('<path d="M4 4.5h6a2.5 2.5 0 0 1 2 1 2.5 2.5 0 0 1 2-1h6v15h-6a2 2 0 0 0-2 1.2 2 2 0 0 0-2-1.2H4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 5.5v15" stroke="currentColor" stroke-width="1.6"/>'),
  gear: svg('<path d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M19.4 13.5a7.7 7.7 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.6 7.6 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.7 7.7 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 2.6-1.5l2.4 1 2-3.4Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'),
  back: svg('<path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'),
  pause: svg('<rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor"/>'),
  shuffle: svg('<path d="M3 7h3.5c4 0 6 10 10 10H21M3 17h3.5c1.6 0 2.8-1.6 3.9-3.6M21 7h-4.5c-1.6 0-2.8 1.6-3.9 3.6M18 4l3 3-3 3M18 14l3 3-3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'),
  install: svg('<path d="M12 3v12M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 17v2.5h16V17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  trophy: svg('<path d="M7 3.5h10v5a5 5 0 0 1-10 0Z" fill="currentColor"/><path d="M7 5H3.5a3.5 3.5 0 0 0 3.8 4.2M17 5h3.5a3.5 3.5 0 0 1-3.8 4.2M12 13.5V17M8 20.5h8M9.5 17h5v3.5h-5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
  lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="2.2"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  heart: svg('<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z" fill="currentColor"/>'),
  bolt: svg('<path d="M13.6 2 4.5 13.6h6.6L10 22l9.4-12h-6.8Z" fill="currentColor"/>'),
  crown: svg('<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5Z" fill="currentColor"/>'),
  glimmer: svg('<path d="M12 2.5 14 10l7.5 2-7.5 2-2 7.5-2-7.5-7.5-2 7.5-2Z" fill="currentColor"/>'),
  question: svg('<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9.3 9.3a2.8 2.8 0 1 1 3.9 2.6c-.8.4-1.2 1-1.2 1.9v.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17.3" r="1.2" fill="currentColor"/>'),
  restart: svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5M4.5 4v4h4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'),
  home: svg('<path d="M3.5 11 12 4l8.5 7M6 9.5V20h4.5v-5h3v5H18V9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>'),
} as const;
