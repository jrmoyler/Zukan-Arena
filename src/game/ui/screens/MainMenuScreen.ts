import { levelFromXp, profile } from '../../core/Profile';
import { GAUNTLET } from '../../data/gauntlet';
import { getFighterById, ROSTER } from '../../data/roster';
import { bindActions, el, escapeHtml } from '../dom';
import { ICONS } from '../icons';
import type { AppApi, Screen } from '../Screen';

/** Hub: modes, collection, settings and the player's progression at a glance. */
export class MainMenuScreen implements Screen {
  readonly root = el('section', 'screen menu-screen');
  private readonly app: AppApi;
  private readonly featured: string;
  private readonly companions: string[];

  constructor(app: AppApi) {
    this.app = app;
    const data = profile.get();
    const { level, into, needed } = levelFromXp(data.xp);
    const featured = getFighterById(data.lastFighterId) ?? ROSTER[0]!;
    const discovered = new Set(data.discovered).size;
    const gauntletNext = Math.min(GAUNTLET.length, data.gauntletBest + 2);
    const winRate = data.matches ? Math.round((data.wins / data.matches) * 100) : 0;

    this.root.innerHTML = `
      <header class="screen-header">
        <div class="brand-mark"><img src="${import.meta.env.BASE_URL}icons/icon.svg" alt="" /><span>Zukan Arena</span></div>
        <div class="spacer"></div>
        <span class="currency" title="Glimmer">${ICONS.glimmer}${data.glimmer.toLocaleString()}</span>
        <button class="icon-button" data-action="settings" aria-label="Settings">${ICONS.gear}</button>
      </header>
      <div class="menu-layout">
        <nav class="menu-nav" aria-label="Main menu">
          <p class="eyebrow">Welcome back, Archivist</p>
          <button class="menu-item menu-item-hero" data-action="skirmish" data-autofocus>
            <span class="menu-icon">${ICONS.swords}</span>
            <span class="menu-copy"><strong>Battle</strong><small>Best-of-three skirmish · choose your squad and difficulty</small></span>
            <span class="menu-arrow">${ICONS.play}</span>
          </button>
          <button class="menu-item" data-action="gauntlet">
            <span class="menu-icon">${ICONS.ladder}</span>
            <span class="menu-copy"><strong>Rift Gauntlet</strong><small>${data.gauntletClears > 0 ? `Cleared ${data.gauntletClears}× · ` : ''}Stage ${gauntletNext} of ${GAUNTLET.length}</small></span>
          </button>
          <button class="menu-item" data-action="training">
            <span class="menu-icon">${ICONS.target}</span>
            <span class="menu-copy"><strong>Training Grounds</strong><small>Test any kit on regenerating dummies</small></span>
          </button>
          <button class="menu-item" data-action="zukan">
            <span class="menu-icon">${ICONS.book}</span>
            <span class="menu-copy"><strong>Zukan</strong><small>${discovered} of ${ROSTER.length} discovered</small></span>
          </button>
          <div class="menu-row">
            <button class="btn btn-ghost btn-sm" data-action="how">${ICONS.question}How to play</button>
            ${app.canInstall() ? `<button class="btn btn-ghost btn-sm" data-action="install">${ICONS.install}Install app</button>` : ''}
          </div>
        </nav>
        <aside class="profile-card glass">
          <div class="profile-level">
            <div class="level-badge"><span>Lv</span><strong>${level}</strong></div>
            <div class="level-copy">
              <p class="eyebrow">Archivist rank</p>
              <div class="xp-bar"><b style="width:${Math.round((into / needed) * 100)}%"></b></div>
              <small>${into} / ${needed} XP</small>
            </div>
          </div>
          <dl class="profile-stats">
            <div><dt>Matches</dt><dd>${data.matches}</dd></div>
            <div><dt>Win rate</dt><dd>${winRate}%</dd></div>
            <div><dt>Knockouts</dt><dd>${data.knockouts}</dd></div>
            <div><dt>Best streak</dt><dd>${data.bestStreak}</dd></div>
          </dl>
          <div class="featured">
            <p class="eyebrow">Last deployed</p>
            <strong>${escapeHtml(featured.name)}</strong>
            <span class="muted">${escapeHtml(featured.epithet)}</span>
          </div>
        </aside>
      </div>`;

    bindActions(this.root, {
      skirmish: () => app.goSelect('skirmish'),
      gauntlet: () => app.goSelect('gauntlet'),
      training: () => app.goSelect('training'),
      zukan: () => app.goZukan(),
      settings: () => app.openSettings(),
      how: () => app.openHowToPlay(),
      install: () => app.install(),
    });
    this.featured = featured.id;
    this.companions = [ROSTER[(featured.index + 16) % ROSTER.length]!.id, ROSTER[(featured.index + 40) % ROSTER.length]!.id];
  }

  enter(): void {
    const lineup = [this.featured, ...this.companions].map((id) => getFighterById(id)).filter((fighter) => fighter !== undefined);
    this.app.showcase.show('menu', lineup);
    this.app.stage.setPreset('menu');
    this.app.audio.playMusic('menu');
  }

  back(): boolean {
    this.app.goTitle();
    return true;
  }
}
