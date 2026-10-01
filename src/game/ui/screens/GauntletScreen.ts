import { profile } from '../../core/Profile';
import { cutoutUrl } from '../../data/assets';
import { GAUNTLET, type GauntletStage } from '../../data/gauntlet';
import { draftMatch, pickBoss } from '../../data/teams';
import type { FighterDefinition } from '../../types';
import { bindActions, el, escapeHtml } from '../dom';
import { ICONS } from '../icons';
import type { AppApi, MatchSetup, Screen } from '../Screen';

/** Builds the match for a Gauntlet stage; seeds keep each stage's lineup stable per champion. */
export function gauntletSetup(player: FighterDefinition, stage: GauntletStage): MatchSetup {
  const seed = player.index * 7919 + stage.index * 104729;
  const draft = draftMatch(player, stage.allies, stage.enemies, seed);
  const enemies = stage.boss ? [pickBoss(new Set([player.id, ...draft.allies.map(({ id }) => id)]), seed)] : draft.enemies;
  return {
    mode: 'gauntlet',
    player,
    allies: draft.allies,
    enemies,
    difficulty: stage.difficulty,
    title: `Gauntlet ${stage.index + 1} · ${stage.title}`,
    roundsToWin: 2,
    roundSeconds: stage.boss ? 120 : 75,
    stageIndex: stage.index,
    modifiers: { ...stage.modifiers, bossId: stage.boss ? enemies[0]!.id : undefined },
  };
}

/** The ladder: eight stages, unlocked in order, with a Sovereign at the summit. */
export class GauntletScreen implements Screen {
  readonly root = el('section', 'screen gauntlet-screen');
  private readonly app: AppApi;
  private readonly player: FighterDefinition;
  private focusIndex: number;

  constructor(app: AppApi, player: FighterDefinition) {
    this.app = app;
    this.player = player;
    const best = profile.get().gauntletBest;
    this.focusIndex = Math.min(GAUNTLET.length - 1, best + 1);
    this.root.innerHTML = `
      <header class="screen-header">
        <button class="icon-button" data-action="back" aria-label="Back">${ICONS.back}</button>
        <h1>Rift Gauntlet</h1>
        <div class="spacer"></div>
        <span class="currency">${ICONS.trophy}${profile.get().gauntletClears} clears</span>
      </header>
      <div class="gauntlet-layout">
        <ol class="ladder" aria-label="Gauntlet stages">
          ${GAUNTLET.map((stage) => {
            const cleared = stage.index <= best;
            const locked = stage.index > best + 1;
            return `
              <li>
                <button class="ladder-node${cleared ? ' is-cleared' : ''}${locked ? ' is-locked' : ''}${stage.boss ? ' is-boss' : ''}" data-stage="${stage.index}" ${locked ? 'aria-disabled="true"' : ''}>
                  <span class="node-index">${cleared ? ICONS.check : locked ? ICONS.lock : stage.boss ? ICONS.crown : stage.index + 1}</span>
                  <span class="node-copy"><strong>${escapeHtml(stage.title)}</strong><small>${stage.allies + 1}v${stage.enemies} · ${stage.difficulty}</small></span>
                </button>
              </li>`;
          }).join('')}
        </ol>
        <section class="stage-card glass" aria-live="polite"></section>
      </div>`;
    bindActions(this.root, {
      back: () => this.back(),
      begin: () => this.begin(),
    });
    this.root.querySelector('.ladder')!.addEventListener('click', (event) => {
      const node = (event.target as HTMLElement).closest<HTMLElement>('[data-stage]');
      if (!node || node.getAttribute('aria-disabled') === 'true') {
        if (node) this.app.sfx('uiError');
        return;
      }
      this.focusIndex = Number(node.dataset.stage);
      this.app.sfx('uiToggle');
      this.renderStage();
    });
    this.renderStage();
  }

  enter(): void {
    this.app.showcase.show('select', [this.player]);
    this.app.stage.setPreset('select');
    this.root.querySelector<HTMLElement>(`[data-stage="${this.focusIndex}"]`)?.focus({ preventScroll: true });
  }

  back(): boolean {
    this.app.goSelect('gauntlet');
    return true;
  }

  private renderStage(): void {
    const stage = GAUNTLET[this.focusIndex]!;
    const setup = gauntletSetup(this.player, stage);
    const best = profile.get().gauntletBest;
    this.root.querySelectorAll('.ladder-node').forEach((node) => node.classList.toggle('is-focused', Number((node as HTMLElement).dataset.stage) === stage.index));
    const portrait = (fighter: FighterDefinition, team: string) => `<span class="squad-chip team-${team} el-${fighter.element}"><img src="${cutoutUrl(fighter.id)}" alt="" /><span>${escapeHtml(fighter.name)}</span></span>`;
    this.root.querySelector('.stage-card')!.innerHTML = `
      <p class="eyebrow">Stage ${stage.index + 1} of ${GAUNTLET.length}${stage.index <= best ? ' · Cleared' : ''}</p>
      <h2>${escapeHtml(stage.title)}</h2>
      <p class="muted">${escapeHtml(stage.subtitle)}</p>
      <div class="stage-facts">
        <span>${ICONS.swords}${stage.allies + 1} vs ${stage.enemies}</span>
        <span>${ICONS.target}${stage.difficulty[0]!.toUpperCase()}${stage.difficulty.slice(1)}</span>
        <span>${ICONS.glimmer}+${stage.reward} Glimmer</span>
      </div>
      <div class="versus-preview">
        <div class="squad">${portrait(this.player, 'signal')}${setup.allies.map((fighter) => portrait(fighter, 'signal')).join('')}</div>
        <span class="vs-mark">VS</span>
        <div class="squad">${setup.enemies.map((fighter) => portrait(fighter, 'rift')).join('')}</div>
      </div>
      ${stage.boss ? '<p class="boss-warning">The Sovereign is colossal, shrugs off stuns and hits like a landslide. Spread out and burst it down.</p>' : ''}
      <button class="btn btn-primary btn-lg" data-action="begin" data-autofocus>Begin stage${ICONS.play}</button>`;
  }

  private begin(): void {
    const stage = GAUNTLET[this.focusIndex]!;
    this.app.sfx('uiConfirm');
    this.app.startMatch(gauntletSetup(this.player, stage));
  }
}
