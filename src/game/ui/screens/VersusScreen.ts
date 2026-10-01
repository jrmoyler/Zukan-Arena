import { cutoutUrl } from '../../data/assets';
import { ELEMENT_LABEL } from '../../data/kits';
import type { FighterDefinition } from '../../types';
import { el, escapeHtml } from '../dom';
import { elementIcon } from '../icons';
import type { AppApi, MatchSetup, Screen } from '../Screen';

const DURATION = 3.2;

/** Pre-match face-off: both squads slide in over the arena, then the battle begins. */
export class VersusScreen implements Screen {
  readonly root = el('section', 'screen versus-screen');
  private readonly app: AppApi;
  private readonly setup: MatchSetup;
  private readonly onDone: () => void;
  private time = 0;
  private done = false;

  constructor(app: AppApi, setup: MatchSetup, onDone: () => void) {
    this.app = app;
    this.setup = setup;
    this.onDone = onDone;
    const card = (fighter: FighterDefinition, index: number, team: 'signal' | 'rift') => `
      <div class="vs-card team-${team} el-${fighter.element}" style="--i:${index}">
        <img src="${cutoutUrl(fighter.id)}" alt="" />
        <div class="vs-card-copy"><strong>${escapeHtml(fighter.name)}</strong><span>${elementIcon(fighter.element)}${ELEMENT_LABEL[fighter.element]} · ${fighter.role}</span></div>
      </div>`;
    const signal = [setup.player, ...setup.allies];
    this.root.innerHTML = `
      <div class="vs-side vs-signal">${signal.map((fighter, index) => card(fighter, index, 'signal')).join('')}</div>
      <div class="vs-center">
        <span class="vs-emblem">VS</span>
        <p class="eyebrow">${escapeHtml(setup.title)}</p>
      </div>
      <div class="vs-side vs-rift">${setup.enemies.map((fighter, index) => card(fighter, index, 'rift')).join('')}</div>
      <p class="vs-skip">${app.input.device === 'touch' ? 'Tap' : 'Press any key'} to skip</p>`;
    this.root.addEventListener('pointerdown', () => this.finish());
  }

  enter(): void {
    this.app.showcase.show('versus', [this.setup.player, ...this.setup.allies], { rift: this.setup.enemies });
    this.app.stage.setPreset('versus');
    this.app.audio.stinger('roundStart');
    window.addEventListener('keydown', this.onKey);
  }

  leave(): void {
    window.removeEventListener('keydown', this.onKey);
  }

  update(delta: number): void {
    this.time += delta;
    if (this.app.input.consume('confirm') || this.time >= DURATION) this.finish();
  }

  back(): boolean {
    this.finish();
    return true;
  }

  private readonly onKey = (): void => this.finish();

  private finish(): void {
    if (this.done || this.time < 0.6) return;
    this.done = true;
    this.onDone();
  }
}
