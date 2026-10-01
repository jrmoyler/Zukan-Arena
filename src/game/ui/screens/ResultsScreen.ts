import { levelFromXp, MASTERY_TITLES, profile, type MatchRewards } from '../../core/Profile';
import { cutoutUrl } from '../../data/assets';
import { getFighterById } from '../../data/roster';
import type { CombatMatchSummary } from '../../simulation/CombatSimulation';
import { bindActions, el, escapeHtml, formatTime } from '../dom';
import { ICONS } from '../icons';
import type { AppApi, MatchSetup, Screen } from '../Screen';
import { stars } from './SelectScreen';

export interface ResultsOptions {
  summary: CombatMatchSummary;
  setup: MatchSetup;
  rewards: MatchRewards;
  xpBefore: number;
  gauntletCleared: boolean;
  hasNextStage: boolean;
  onRematch: () => void;
  onNext: () => void;
}

/** Post-match ceremony: outcome, MVP, scoreboard and animated rewards. */
export class ResultsScreen implements Screen {
  readonly root = el('section', 'screen results-screen');
  private readonly app: AppApi;
  private readonly options: ResultsOptions;
  private elapsed = 0;
  private xpShown = 0;
  private glimmerShown = 0;
  private levelShown: number;
  private readonly xpFill: HTMLElement;
  private readonly xpText: HTMLElement;
  private readonly levelText: HTMLElement;
  private readonly glimmerText: HTMLElement;

  constructor(app: AppApi, options: ResultsOptions) {
    this.app = app;
    this.options = options;
    const { summary, setup, rewards } = options;
    const won = summary.result === 'win';
    this.levelShown = levelFromXp(options.xpBefore).level;
    const mvp = getFighterById(summary.mvpId);
    const mvpStats = summary.fighters.find(({ id }) => id === summary.mvpId)?.stats;
    const rows = summary.fighters.map(({ id, team, stats }) => {
      const fighter = getFighterById(id);
      if (!fighter) return '';
      return `
        <tr class="team-${team}${id === setup.player.id ? ' is-player' : ''}">
          <td><span class="row-fighter"><img src="${cutoutUrl(id)}" alt="" />${escapeHtml(fighter.name)}${id === summary.mvpId ? '<em>MVP</em>' : ''}</span></td>
          <td>${stats.damageDealt}</td>
          <td>${stats.knockouts}</td>
          <td>${stats.healing}</td>
        </tr>`;
    }).join('');
    const discoveries = rewards.newDiscoveries.map((id) => getFighterById(id)).filter((fighter) => fighter !== undefined);
    const record = profile.get().fighters[setup.player.id];
    const title = options.gauntletCleared ? 'Gauntlet Conquered' : won ? 'Victory' : 'Defeat';

    this.root.innerHTML = `
      <div class="results-banner ${won ? 'is-win' : 'is-loss'}">
        <p class="eyebrow">${escapeHtml(setup.title)}</p>
        <h1>${title}</h1>
        <p class="results-score"><span class="team-signal">${summary.roundsWon}</span><i>—</i><span class="team-rift">${summary.roundsLost}</span><small>${formatTime(summary.durationMs / 1000)} in the arena</small></p>
      </div>
      <div class="results-layout">
        <section class="results-mvp glass">
          <p class="eyebrow">Most valuable</p>
          ${mvp ? `<img src="${cutoutUrl(mvp.id)}" alt="" /><h2>${escapeHtml(mvp.name)}</h2>` : ''}
          ${mvpStats ? `<p class="muted">${mvpStats.damageDealt} damage · ${mvpStats.knockouts} KOs</p>` : ''}
        </section>
        <section class="results-table glass">
          <table>
            <thead><tr><th>Fighter</th><th>Damage</th><th>KOs</th><th>Healing</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </section>
        <section class="results-rewards glass">
          <p class="eyebrow">Rewards</p>
          <div class="reward-level">
            <div class="level-badge"><span>Lv</span><strong data-level>${this.levelShown}</strong></div>
            <div class="level-copy">
              <div class="xp-bar"><b data-xp-fill></b></div>
              <small data-xp-text>+0 XP</small>
            </div>
          </div>
          <div class="reward-line">${ICONS.glimmer}<span>Glimmer</span><strong data-glimmer>+0</strong></div>
          <div class="reward-line">${ICONS.crown}<span>${escapeHtml(setup.player.name)} mastery</span><strong>+${rewards.masteryXp}</strong></div>
          <div class="reward-mastery"><span class="card-stars">${stars(rewards.masteryAfter)}</span>${MASTERY_TITLES[rewards.masteryAfter]}${rewards.masteryAfter > rewards.masteryBefore ? '<em>Rank up!</em>' : ''}<small>${record ? `${record.wins} wins with this Zukan` : ''}</small></div>
          ${rewards.streak > 1 ? `<div class="reward-line">${ICONS.bolt}<span>Win streak</span><strong>${rewards.streak}</strong></div>` : ''}
          ${discoveries.length ? `<div class="discoveries"><p class="eyebrow">New Zukan entries</p><div>${discoveries.map((fighter) => `<span class="discovery"><img src="${cutoutUrl(fighter.id)}" alt="" /><em>New</em><small>${escapeHtml(fighter.name)}</small></span>`).join('')}</div></div>` : ''}
        </section>
      </div>
      <div class="results-actions">
        <button class="btn btn-ghost" data-action="menu">${ICONS.home}Main menu</button>
        <button class="btn" data-action="select">Change fighter</button>
        ${options.hasNextStage ? `<button class="btn btn-primary btn-lg" data-action="next" data-autofocus>Next stage${ICONS.play}</button>` : ''}
        <button class="btn ${options.hasNextStage ? '' : 'btn-primary btn-lg'}" data-action="rematch" ${options.hasNextStage ? '' : 'data-autofocus'}>${ICONS.restart}${won ? 'Play again' : 'Rematch'}</button>
      </div>`;
    this.xpFill = this.root.querySelector('[data-xp-fill]')!;
    this.xpText = this.root.querySelector('[data-xp-text]')!;
    this.levelText = this.root.querySelector('[data-level]')!;
    this.glimmerText = this.root.querySelector('[data-glimmer]')!;
    this.renderXp(options.xpBefore);

    bindActions(this.root, {
      menu: () => app.goMenu(),
      select: () => app.goSelect(setup.mode),
      rematch: () => options.onRematch(),
      next: () => options.onNext(),
    });
  }

  enter(): void {
    const { summary, setup } = this.options;
    const roster = [setup.player, ...setup.allies];
    this.app.showcase.show('results', roster, { winners: summary.result === 'win' ? 'signal' : 'rift' });
    this.app.stage.setPreset('results');
    this.app.stage.setGrade({ desaturate: 0 });
    this.app.audio.playMusic('menu');
    this.app.audio.setMuffle(0);
  }

  update(delta: number): void {
    this.elapsed += delta;
    if (this.elapsed < 0.9) return;
    const { rewards, xpBefore } = this.options;
    const t = Math.min(1, (this.elapsed - 0.9) / 1.6);
    const eased = 1 - Math.pow(1 - t, 3);
    const xp = Math.round(rewards.xp * eased);
    const glimmer = Math.round(rewards.glimmer * eased);
    if (xp !== this.xpShown) {
      this.xpShown = xp;
      this.renderXp(xpBefore + xp);
      this.xpText.textContent = `+${xp} XP`;
    }
    if (glimmer !== this.glimmerShown) {
      this.glimmerShown = glimmer;
      this.glimmerText.textContent = `+${glimmer}`;
      if (glimmer % 7 === 0) this.app.sfx('uiHover');
    }
  }

  back(): boolean {
    this.app.goMenu();
    return true;
  }

  private renderXp(total: number): void {
    const { level, into, needed } = levelFromXp(total);
    this.xpFill.style.width = `${(into / needed) * 100}%`;
    if (level !== this.levelShown) {
      this.levelShown = level;
      this.levelText.textContent = String(level);
      this.levelText.parentElement?.classList.add('is-levelup');
      this.app.sfx('levelUp');
      this.app.toast(`Archivist rank ${level} reached`);
    }
  }
}
