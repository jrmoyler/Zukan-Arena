import { MASTERY_THRESHOLDS, MASTERY_TITLES, masteryRank, profile } from '../../core/Profile';
import { settings } from '../../core/Settings';
import { ELEMENT_ORDER } from '../../data/abilities';
import { cutoutUrl } from '../../data/assets';
import { ELEMENT_ADVANTAGE, ELEMENT_LABEL, kitFor, ROLE_SUMMARY, weakAgainst } from '../../data/kits';
import { getFighterById, ROSTER } from '../../data/roster';
import { draftMatch } from '../../data/teams';
import type { Difficulty } from '../../simulation/CombatSimulation';
import type { ElementKind, FighterDefinition } from '../../types';
import { bindActions, el, escapeHtml } from '../dom';
import { elementIcon, ICONS } from '../icons';
import type { AppApi, GameMode, Screen } from '../Screen';

type SortKey = 'index' | 'name' | 'element' | 'mastery';

const MODE_COPY: Record<GameMode, { title: string; cta: string }> = {
  skirmish: { title: 'Choose your Zukan', cta: 'Assemble squad' },
  gauntlet: { title: 'Gauntlet champion', cta: 'Enter the Gauntlet' },
  training: { title: 'Training Grounds', cta: 'Start training' },
};

const DIFFICULTY_COPY: Record<Difficulty, string> = {
  novice: 'Relaxed rivals who rarely dodge. Great for learning kits.',
  adept: 'Disciplined squads that respect telegraphs and focus fire.',
  master: 'Ruthless tacticians with sharp aim and near-perfect dodges.',
};

export function stars(rank: number): string {
  return Array.from({ length: 4 }, (_, index) => `<i class="star${index < rank ? ' is-on' : ''}">${ICONS.glimmer}</i>`).join('');
}

export class SelectScreen implements Screen {
  readonly root = el('section', 'screen select-screen');
  private readonly app: AppApi;
  private readonly mode: GameMode;
  private selected: FighterDefinition;
  private search = '';
  private filter: ElementKind | 'all' = 'all';
  private sort: SortKey = 'index';
  private readonly grid: HTMLElement;
  private readonly dossier: HTMLElement;

  constructor(app: AppApi, mode: GameMode) {
    this.app = app;
    this.mode = mode;
    this.selected = getFighterById(profile.get().lastFighterId) ?? ROSTER[0]!;
    const copy = MODE_COPY[mode];
    this.root.innerHTML = `
      <header class="screen-header">
        <button class="icon-button" data-action="back" aria-label="Back">${ICONS.back}</button>
        <h1>${copy.title}</h1>
        <div class="spacer"></div>
        <span class="currency">${ICONS.glimmer}${profile.get().glimmer.toLocaleString()}</span>
      </header>
      <div class="select-layout">
        <section class="roster glass" aria-label="Roster">
          <div class="roster-tools">
            <label class="search-field">${ICONS.target}<input type="search" placeholder="Search ${ROSTER.length} Zukan" aria-label="Search fighters" /></label>
            <select class="sort-select" aria-label="Sort fighters">
              <option value="index">No.</option>
              <option value="name">Name</option>
              <option value="element">Element</option>
              <option value="mastery">Mastery</option>
            </select>
          </div>
          <div class="filter-row" role="toolbar" aria-label="Filter by element">
            <button class="chip-toggle is-active" data-filter="all">All</button>
            ${ELEMENT_ORDER.map((element) => `<button class="chip-toggle el-${element}" data-filter="${element}">${elementIcon(element)}${ELEMENT_LABEL[element]}</button>`).join('')}
          </div>
          <div class="fighter-grid" role="listbox" aria-label="Zukan roster"></div>
        </section>
        <div class="select-stage">
          <button class="btn btn-ghost btn-sm preview-cast" data-action="flourish">${ICONS.ultimate}Preview signature</button>
        </div>
        <aside class="dossier glass" aria-live="polite"></aside>
      </div>`;
    this.grid = this.root.querySelector('.fighter-grid')!;
    this.dossier = this.root.querySelector('.dossier')!;

    const searchInput = this.root.querySelector<HTMLInputElement>('input[type="search"]')!;
    searchInput.addEventListener('input', () => {
      this.search = searchInput.value;
      this.renderGrid();
    });
    const sortSelect = this.root.querySelector<HTMLSelectElement>('.sort-select')!;
    sortSelect.addEventListener('change', () => {
      this.sort = sortSelect.value as SortKey;
      this.renderGrid();
    });
    bindActions(this.root, {
      back: () => this.back(),
      flourish: () => this.app.showcase.flourish(this.selected.id),
      continue: () => this.continue(),
    });
    this.root.querySelector('.filter-row')!.addEventListener('click', (event) => {
      const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-filter]');
      if (!chip) return;
      this.filter = chip.dataset.filter as ElementKind | 'all';
      this.root.querySelectorAll('[data-filter]').forEach((node) => node.classList.toggle('is-active', node === chip));
      this.renderGrid();
    });
    this.grid.addEventListener('click', (event) => {
      const card = (event.target as HTMLElement).closest<HTMLElement>('[data-fighter]');
      if (card) this.select(card.dataset.fighter!);
    });
    this.grid.addEventListener('dblclick', (event) => {
      if ((event.target as HTMLElement).closest('[data-fighter]')) this.continue();
    });
    this.grid.addEventListener('focusin', (event) => {
      const card = (event.target as HTMLElement).closest<HTMLElement>('[data-fighter]');
      if (card && this.app.input.device !== 'touch') this.select(card.dataset.fighter!);
    });
    this.renderGrid();
    this.renderDossier();
  }

  enter(): void {
    this.app.showcase.show('select', [this.selected]);
    this.app.stage.setPreset('select');
    this.app.audio.playMusic('menu');
    this.grid.querySelector<HTMLElement>(`[data-fighter="${this.selected.id}"]`)?.scrollIntoView({ block: 'center' });
  }

  back(): boolean {
    this.app.goMenu();
    return true;
  }

  private filtered(): FighterDefinition[] {
    const query = this.search.trim().toLowerCase();
    const records = profile.get().fighters;
    const list = ROSTER.filter((fighter) => {
      if (this.filter !== 'all' && fighter.element !== this.filter) return false;
      return !query || `${fighter.name} ${fighter.epithet} ${fighter.role} ${fighter.element}`.toLowerCase().includes(query);
    });
    const order = ELEMENT_ORDER as readonly string[];
    return list.sort((a, b) => {
      switch (this.sort) {
        case 'name': return a.name.localeCompare(b.name);
        case 'element': return order.indexOf(a.element) - order.indexOf(b.element) || a.index - b.index;
        case 'mastery': return (records[b.id]?.masteryXp ?? 0) - (records[a.id]?.masteryXp ?? 0) || a.index - b.index;
        default: return a.index - b.index;
      }
    });
  }

  private renderGrid(): void {
    const records = profile.get().fighters;
    const fighters = this.filtered();
    this.grid.innerHTML = fighters.length
      ? fighters.map((fighter) => {
        const rank = masteryRank(records[fighter.id]?.masteryXp ?? 0);
        const active = fighter.id === this.selected.id;
        return `
          <button class="fighter-card el-${fighter.element}${active ? ' is-selected' : ''}" role="option" aria-selected="${active}" data-fighter="${fighter.id}" title="${escapeHtml(fighter.name)}">
            <span class="card-art"><img src="${cutoutUrl(fighter.id)}" alt="" loading="lazy" draggable="false" /></span>
            <span class="card-no">${String(fighter.index).padStart(3, '0')}</span>
            <span class="card-element">${elementIcon(fighter.element)}</span>
            <span class="card-name">${escapeHtml(fighter.name)}</span>
            ${rank > 0 ? `<span class="card-stars">${stars(rank)}</span>` : ''}
          </button>`;
      }).join('')
      : '<p class="empty-state">No Zukan match that search.</p>';
  }

  private select(id: string): void {
    if (id === this.selected.id) return;
    const fighter = getFighterById(id);
    if (!fighter) return;
    this.selected = fighter;
    this.app.sfx('uiToggle');
    this.grid.querySelectorAll<HTMLElement>('[data-fighter]').forEach((card) => {
      const active = card.dataset.fighter === id;
      card.classList.toggle('is-selected', active);
      card.setAttribute('aria-selected', String(active));
    });
    this.app.showcase.show('select', [fighter]);
    this.renderDossier();
  }

  private renderDossier(): void {
    const fighter = this.selected;
    const kit = kitFor(fighter);
    const record = profile.get().fighters[fighter.id];
    const masteryXp = record?.masteryXp ?? 0;
    const rank = masteryRank(masteryXp);
    const next = MASTERY_THRESHOLDS[rank + 1];
    const stat = (label: string, value: number, min: number, max: number, text: string) => `
      <div class="stat-row"><span>${label}</span><div class="stat-track"><b style="width:${Math.round(((value - min) / (max - min)) * 100)}%"></b></div><strong>${text}</strong></div>`;
    const strong = ELEMENT_ADVANTAGE[fighter.element];
    const weak = weakAgainst(fighter.element);
    this.dossier.className = `dossier glass el-${fighter.element}`;
    this.dossier.innerHTML = `
      <div class="dossier-head">
        <p class="eyebrow">No. ${String(fighter.index).padStart(3, '0')} · ${fighter.archetype}</p>
        <h2>${escapeHtml(fighter.name)}</h2>
        <p class="epithet">${escapeHtml(fighter.epithet)}</p>
        <div class="tag-row">
          <span class="element-tag el-${fighter.element}">${elementIcon(fighter.element)}${ELEMENT_LABEL[fighter.element]}</span>
          <span class="role-tag">${fighter.role}</span>
        </div>
      </div>
      <p class="role-summary">${ROLE_SUMMARY[fighter.role]}</p>
      <div class="stat-block">
        ${stat('Vitality', fighter.maxHp, 95, 140, String(fighter.maxHp))}
        ${stat('Mobility', fighter.speed, 3.4, 5, fighter.speed.toFixed(2))}
        ${stat('Power', fighter.power, 0.85, 1.1, `${Math.round(fighter.power * 100)}%`)}
      </div>
      <ul class="kit-list">
        <li><span class="kit-icon">${ICONS.basic}</span><div><strong>${kit.basic.label}</strong><small>${kit.basic.damage} dmg · ${kit.basic.cooldown}s${kit.basic.pierce ? ' · pierces' : ''}</small></div></li>
        <li><span class="kit-icon el-${fighter.element}">${elementIcon(fighter.element)}</span><div><strong>${kit.skill.label}</strong><small>${escapeHtml(kit.skill.description)}</small></div></li>
        <li><span class="kit-icon">${ICONS.dash}</span><div><strong>Dash</strong><small>${kit.dash.distance}m burst with brief invulnerability · ${kit.dash.cooldown}s</small></div></li>
        <li><span class="kit-icon kit-ult">${ICONS.ultimate}</span><div><strong>${kit.ultimate.label}</strong><small>${escapeHtml(kit.ultimate.description)}</small></div></li>
      </ul>
      <div class="resonance">
        <span class="res-chip res-strong el-${strong}">${elementIcon(strong)}Strong vs ${ELEMENT_LABEL[strong]}</span>
        <span class="res-chip res-weak el-${weak}">${elementIcon(weak)}Weak to ${ELEMENT_LABEL[weak]}</span>
      </div>
      <div class="mastery">
        <div><span class="card-stars">${stars(rank)}</span><strong>${MASTERY_TITLES[rank]}</strong></div>
        <small>${record ? `${record.wins} wins · ${record.knockouts} KOs` : 'Not yet deployed'}${next ? ` · ${next - masteryXp} XP to ${MASTERY_TITLES[rank + 1]}` : ' · Max mastery'}</small>
      </div>
      <button class="btn btn-primary btn-lg deploy" data-action="continue">${MODE_COPY[this.mode].cta}${ICONS.play}</button>`;
  }

  private continue(): void {
    const fighter = this.selected;
    profile.update({ lastFighterId: fighter.id });
    this.app.sfx('uiConfirm');
    if (this.mode === 'gauntlet') {
      this.app.goGauntlet(fighter);
    } else if (this.mode === 'training') {
      const dummies = draftMatch(fighter, 0, 3, fighter.index * 977).enemies;
      this.app.startMatch({
        mode: 'training',
        player: fighter,
        allies: [],
        enemies: dummies,
        difficulty: 'novice',
        title: 'Training',
        roundsToWin: 1,
        roundSeconds: 60 * 60,
      });
    } else {
      this.openSetup();
    }
  }

  private openSetup(): void {
    const player = this.selected;
    let difficulty = settings.get().difficulty;
    let size = 3;
    let seed = Date.now() & 0xffff;
    let draft = draftMatch(player, size - 1, size, seed);
    const panel = el('div', 'modal glass setup-modal');
    const render = () => {
      const chip = (fighter: FighterDefinition, team: 'signal' | 'rift') => `
        <span class="squad-chip team-${team} el-${fighter.element}"><img src="${cutoutUrl(fighter.id)}" alt="" /><span>${escapeHtml(fighter.name)}</span><i>${elementIcon(fighter.element)}</i></span>`;
      panel.innerHTML = `
        <p class="eyebrow">Skirmish · best of three</p>
        <h2>Assemble your squad</h2>
        <div class="setup-row">
          <span class="setup-label">Format</span>
          <div class="segmented" data-group="size">
            ${[1, 2, 3].map((value) => `<button class="${value === size ? 'is-active' : ''}" data-size="${value}">${value}v${value}</button>`).join('')}
          </div>
        </div>
        <div class="setup-row">
          <span class="setup-label">Difficulty</span>
          <div class="segmented" data-group="difficulty">
            ${(['novice', 'adept', 'master'] as const).map((value) => `<button class="${value === difficulty ? 'is-active' : ''}" data-difficulty="${value}">${value[0]!.toUpperCase()}${value.slice(1)}</button>`).join('')}
          </div>
        </div>
        <p class="setup-hint">${DIFFICULTY_COPY[difficulty]}</p>
        <div class="versus-preview">
          <div class="squad">${chip(player, 'signal')}${draft.allies.map((fighter) => chip(fighter, 'signal')).join('')}</div>
          <span class="vs-mark">VS</span>
          <div class="squad">${draft.enemies.map((fighter) => chip(fighter, 'rift')).join('')}</div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-action="shuffle">${ICONS.shuffle}Redraft</button>
          <span class="spacer"></span>
          <button class="btn btn-ghost" data-action="cancel">Cancel</button>
          <button class="btn btn-primary" data-action="begin" data-autofocus>Begin match${ICONS.play}</button>
        </div>`;
    };
    render();
    const close = this.app.openModal(panel);
    panel.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('button');
      if (!target) return;
      if (target.dataset.size) {
        size = Number(target.dataset.size);
        draft = draftMatch(player, size - 1, size, seed);
        render();
      } else if (target.dataset.difficulty) {
        difficulty = target.dataset.difficulty as Difficulty;
        settings.update({ difficulty });
        render();
      } else if (target.dataset.action === 'shuffle') {
        seed = (seed * 48271 + 11) & 0xffffff;
        draft = draftMatch(player, size - 1, size, seed);
        render();
      } else if (target.dataset.action === 'cancel') {
        close();
      } else if (target.dataset.action === 'begin') {
        close();
        this.app.startMatch({
          mode: 'skirmish',
          player,
          allies: draft.allies,
          enemies: draft.enemies,
          difficulty,
          title: `Skirmish · ${difficulty[0]!.toUpperCase()}${difficulty.slice(1)}`,
          roundsToWin: 2,
          roundSeconds: 75,
        });
      }
    });
  }
}
