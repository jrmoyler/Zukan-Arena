/** Tiny DOM toolkit: escaping, element creation, delegated actions and
 * spatial focus navigation for gamepad / keyboard menu control. */

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', html = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (html) element.innerHTML = html;
  return element;
}

/** Routes clicks on `[data-action]` descendants to handlers. */
export function bindActions(root: HTMLElement, handlers: Record<string, (target: HTMLElement, event: Event) => void>): void {
  root.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
    if (!target || !root.contains(target) || target.hasAttribute('disabled')) return;
    const handler = handlers[target.dataset.action ?? ''];
    if (handler) handler(target, event);
  });
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function visible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
}

/** Moves focus to the nearest focusable element in a screen direction. */
export function moveFocus(root: HTMLElement, direction: 'up' | 'down' | 'left' | 'right'): void {
  const candidates = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
  if (!candidates.length) return;
  const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
  if (!active) {
    (root.querySelector<HTMLElement>('[data-autofocus]') ?? candidates[0])?.focus();
    return;
  }
  const from = active.getBoundingClientRect();
  const fx = from.left + from.width / 2;
  const fy = from.top + from.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate === active) continue;
    const rect = candidate.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = cx - fx;
    const dy = cy - fy;
    const primary = direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy;
    if (primary <= 4) continue;
    const secondary = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
    const score = primary + secondary * 2.2;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  best?.focus();
  best?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

export function focusFirst(root: HTMLElement): void {
  const target = root.querySelector<HTMLElement>('[data-autofocus]') ?? root.querySelector<HTMLElement>(FOCUSABLE);
  target?.focus({ preventScroll: true });
}

export function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
