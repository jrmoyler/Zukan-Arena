import './styles/base.css';
import './styles/hud.css';
import './styles/screens.css';
import { App, renderCompatibilityNotice } from './game/App';

const host = document.querySelector<HTMLElement>('#app');
const boot = document.getElementById('boot');
const bootFill = boot?.querySelector<HTMLElement>('[data-boot-fill]');
const bootLabel = boot?.querySelector<HTMLElement>('[data-boot-label]');

function supportsWebGL2(): boolean {
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    return false;
  }
}

function finishBoot(): void {
  boot?.classList.add('is-done');
  window.setTimeout(() => boot?.remove(), 700);
}

if (!host) throw new Error('Missing #app host');

if (!supportsWebGL2()) {
  renderCompatibilityNotice(host);
  finishBoot();
} else {
  const app = new App(host);
  if (import.meta.env.DEV) (window as Window & { zukan?: App }).zukan = app;
  void app
    .boot((fraction, label) => {
      if (bootFill) bootFill.style.width = `${Math.round(fraction * 100)}%`;
      if (bootLabel) bootLabel.textContent = label;
    })
    .catch((error: unknown) => console.error('[Zukan Arena] Boot failed', error))
    .finally(finishBoot);
}
