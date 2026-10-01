import { MASTERY_TITLES, masteryRank, profile } from '../../core/Profile';
import { ELEMENT_ORDER } from '../../data/abilities';
import { cutoutUrl } from '../../data/assets';
import { ELEMENT_LABEL, kitFor } from '../../data/kits';
import { getFighterById, ROSTER } from '../../data/roster';
import type { ElementKind, FighterDefinition } from '../../types';
import { bindActions, el, escapeHtml } from '../dom';
import { elementIcon, ICONS } from '../icons';
import type { AppApi, Screen } from '../Screen';
import { stars } from './SelectScreen';

const HABITAT: Record<ElementKind, string> = {
  earth: 'Its footfalls register on the seismographs buried beneath the colosseum.',
  hydro: 'Archivists find tide-marks on the stone wherever it has rested.',
  gale: 'It is rarely seen standing still; most sightings are the ribbon of wind it leaves.',
  plasma: 'Lanterns flicker and compasses spin whenever it passes the archive halls.',
  nature: 'Seeds dropped in its shadow sprout overnight, even on polished porcelain.',
  void: 'Light bends faintly around it, as though the air remembers somewhere else.',
};

const TEMPERAMENT: Record<FighterDefinition['role'], string> = {
  Builder: 'Steadfast and protective, it anchors any squad it joins.',
  Creator: 'Restless and inventive, it improvises new angles of attack mid-battle.',
  Strategist: 'Patient and precise, it reads the arena several moves ahead.',
};

/** The encyclopedia: every Zukan, with entries unlocked by fielding or facing them. */
export class ZukanScreen implements Screen {
  readonly root = el('section', 'screen zukan-screen');
  private readonly app: AppApi;
  private selected: FighterDefinition;
  private filter: ElementKind | 'all' = 'all';
  private readonly discovered: Set<string>;

  constructor(app: AppApi) {
    this.app = app;
    this.discovered = new Set(profile.get().discovered);
    this.selected = ROSTER.find(({ id }) => this.discovered.has(id)) ?? ROSTER[0]!;
    const percent = Math.round((this.discovered.size / ROSTER.length) * 100);
    this.root.innerHTML = `
      <header class="screen-header">
        <button class="icon-button" data-action="back" aria-label="Back">${ICONS.back}</button>
        <h1>Zukan</h1>
        <div class="completion"><div class="xp-bar"><b style="width:${percent}%"></b></div><span>${this.discovered.size} / ${ROSTER.length} recorded</span></div>
        <div class="spacer"></div>
      </header>
      <div class="zukan-layout">
        <section class="zukan-index glass">
          <div class="filter-row">
            <button class="chip-toggle is-active" data-filter="all">All</button>
            ${ELEMENT_ORDER.map((element) => `<button class="chip-toggle el-${element}" data-filter="${element}">${elementIcon(element)}${ELEMENT_LABEL[element]}</button>`).join('')}
          </div>
          <div class="zukan-grid"></div>
        </section>
        <article class="zukan-entry glass"></article>
      </div>`;
    bindActions(this.root, { back: () => this.back() });
    this.root.querySelector('.filter-row')!.addEventListener('click', (event) => {
      const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-filter]');
      if (!chip) return;
      this.filter = chip.dataset.filter as ElementKind | 'all';
      this.root.querySelectorAll('[data-filter]').forEach((node) => node.classList.toggle('is-active', node === chip));
      this.renderGrid();
    });
    const grid = this.root.querySelector<HTMLElement>('.zukan-grid')!;
    const pick = (event: Event) => {
      const card = (event.target as HTMLElement).closest<HTMLElement>('[data-entry]');
      const fighter = card ? getFighterById(card.dataset.entry!) : undefined;
      if (!fighter || fighter.id === this.selected.id) return;
      this.selected = fighter;
      this.app.sfx('uiToggle');
      grid.querySelectorAll('[data-entry]').forEach((node) => node.classList.toggle('is-selected', node === card));
      this.renderEntry();
    };
    grid.addEventListener('click', pick);
    grid.addEventListener('focusin', pick);
    this.renderGrid();
    this.renderEntry();
  }

  enter(): void {
    this.app.showcase.hide();
    this.app.stage.setPreset('menu');
  }

  back(): boolean {
    this.app.goMenu();
    return true;
  }

  private renderGrid(): void {
    const grid = this.root.querySelector<HTMLElement>('.zukan-grid')!;
    grid.innerHTML = ROSTER.filter((fighter) => this.filter === 'all' || fighter.element === this.filter).map((fighter) => {
      const known = this.discovered.has(fighter.id);
      return `
        <button class="zukan-card el-${fighter.element}${known ? '' : ' is-unknown'}${fighter.id === this.selected.id ? ' is-selected' : ''}" data-entry="${fighter.id}" aria-label="${known ? escapeHtml(fighter.name) : 'Unrecorded entry'}">
          <span class="card-no">${String(fighter.index).padStart(3, '0')}</span>
          <img src="${cutoutUrl(fighter.id)}" alt="" loading="lazy" draggable="false" />
          <span class="card-name">${known ? escapeHtml(fighter.name) : '???'}</span>
        </button>`;
    }).join('');
  }

  private renderEntry(): void {
    const fighter = this.selected;
    const known = this.discovered.has(fighter.id);
    const entry = this.root.querySelector<HTMLElement>('.zukan-entry')!;
    entry.className = `zukan-entry glass el-${fighter.element}${known ? '' : ' is-unknown'}`;
    if (!known) {
      entry.innerHTML = `
        <div class="entry-art"><img src="${cutoutUrl(fighter.id)}" alt="" /></div>
        <p class="eyebrow">No. ${String(fighter.index).padStart(3, '0')}</p>
        <h2>Unrecorded</h2>
        <p class="muted">Field this Zukan or face it in battle to record its entry. Element: ${ELEMENT_LABEL[fighter.element]}.</p>`;
      return;
    }
    const kit = kitFor(fighter);
    const record = profile.get().fighters[fighter.id];
    const rank = masteryRank(record?.masteryXp ?? 0);
    entry.innerHTML = `
      <div class="entry-art"><img src="${cutoutUrl(fighter.id)}" alt="" /></div>
      <p class="eyebrow">No. ${String(fighter.index).padStart(3, '0')} · ${fighter.archetype}</p>
      <h2>${escapeHtml(fighter.name)}</h2>
      <p class="epithet">${escapeHtml(fighter.epithet)}</p>
      <div class="tag-row">
        <span class="element-tag el-${fighter.element}">${elementIcon(fighter.element)}${ELEMENT_LABEL[fighter.element]}</span>
        <span class="role-tag">${fighter.role}</span>
      </div>
      <p class="field-notes">${HABITAT[fighter.element]} ${TEMPERAMENT[fighter.role]}</p>
      <dl class="entry-facts">
        <div><dt>Vitality</dt><dd>${fighter.maxHp}</dd></div>
        <div><dt>Mobility</dt><dd>${fighter.speed.toFixed(2)}</dd></div>
        <div><dt>Power</dt><dd>${Math.round(fighter.power * 100)}%</dd></div>
        <div><dt>Signature</dt><dd>${kit.skill.label}</dd></div>
        <div><dt>Ultimate</dt><dd>${kit.ultimate.label}</dd></div>
        <div><dt>Record</dt><dd>${record ? `${record.wins}W · ${record.played - record.wins}L` : 'Faced in battle'}</dd></div>
      </dl>
      <div class="mastery"><div><span class="card-stars">${stars(rank)}</span><strong>${MASTERY_TITLES[rank]}</strong></div></div>`;
  }
}
