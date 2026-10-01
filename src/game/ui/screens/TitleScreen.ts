import { profile } from '../../core/Profile';
import { getFighterById, ROSTER } from '../../data/roster';
import { el } from '../dom';
import type { AppApi, Screen } from '../Screen';

const TITLE_LINEUP = ['zukan-025', 'zukan-011', 'zukan-001', 'zukan-020', 'zukan-002'];

/** Attract screen: logo over a living lineup, waits for any input. */
export class TitleScreen implements Screen {
  readonly root = el('section', 'screen title-screen');
  private readonly app: AppApi;
  private armed = false;

  constructor(app: AppApi) {
    this.app = app;
    const touch = app.input.device === 'touch';
    this.root.innerHTML = `
      <div class="title-sky"></div>
      <div class="title-lockup">
        <p class="eyebrow">Season II · The Resonance</p>
        <h1 class="logo"><span class="logo-small">Zukan</span><span class="logo-large">Arena</span></h1>
        <p class="title-tagline">Sixty-eight living legends. Six elemental forces. One arena.</p>
      </div>
      <button class="press-start" data-autofocus>${touch ? 'Tap to begin' : 'Press any key'}</button>
      <footer class="title-footer"><span>v3.0 · ${ROSTER.length} Zukan</span><span>Installable · plays offline</span></footer>`;
  }

  enter(): void {
    const lineup = TITLE_LINEUP.map((id) => getFighterById(id)).filter((fighter) => fighter !== undefined);
    const last = getFighterById(profile.get().lastFighterId);
    if (last && !lineup.some(({ id }) => id === last.id)) lineup[2] = last;
    this.app.showcase.show('title', lineup);
    this.app.stage.setPreset('title');
    this.app.audio.playMusic('menu');
    window.setTimeout(() => {
      this.armed = true;
      window.addEventListener('keydown', this.onAny);
      window.addEventListener('pointerdown', this.onAny);
    }, 350);
  }

  leave(): void {
    window.removeEventListener('keydown', this.onAny);
    window.removeEventListener('pointerdown', this.onAny);
  }

  update(): void {
    if (this.armed && (this.app.input.consume('confirm') || this.app.input.consume('pause'))) this.start();
  }

  private readonly onAny = (event: Event): void => {
    if (event instanceof KeyboardEvent && (event.metaKey || event.ctrlKey || event.altKey)) return;
    this.start();
  };

  private start(): void {
    if (!this.armed) return;
    this.armed = false;
    void this.app.audio.unlock();
    this.app.sfx('uiConfirm');
    this.app.goMenu();
  }
}
