import type { InputDevice, InputManager } from '../core/Input';
import { cutoutUrl } from '../data/assets';
import { ELEMENT_LABEL } from '../data/kits';
import { MAX_ENERGY, type CombatSimulation, type FighterState } from '../simulation/CombatSimulation';
import type { FighterDefinition, TeamKind } from '../types';
import { el, escapeHtml, formatTime } from './dom';
import { elementIcon, ICONS } from './icons';

/** In-battle heads-up display, including on-screen touch controls. */

type Slot = 'basic' | 'skill' | 'dash' | 'ultimate';

const GLYPHS: Record<InputDevice, Record<Slot, string>> = {
  keyboard: { basic: 'LMB', skill: 'Q', dash: 'Space', ultimate: 'E' },
  gamepad: { basic: 'RT', skill: 'X', dash: 'A', ultimate: 'Y' },
  touch: { basic: '', skill: '', dash: '', ultimate: '' },
};

export interface HudOptions {
  sim: CombatSimulation;
  input: InputManager;
  training: boolean;
  title: string;
  onPause: () => void;
}

interface Chip {
  root: HTMLElement;
  ring: HTMLElement;
  id: string;
}

export class Hud {
  readonly root: HTMLDivElement;
  private readonly sim: CombatSimulation;
  private readonly input: InputManager;
  private readonly training: boolean;
  private readonly chips: Chip[] = [];
  private readonly announcer: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly time: HTMLElement;
  private readonly roundLabel: HTMLElement;
  private readonly hpFill?: HTMLElement;
  private readonly hpText?: HTMLElement;
  private readonly energyFill?: HTMLElement;
  private readonly slots = new Map<Slot, HTMLElement>();
  private announceTimer?: number;
  private toastTimer?: number;
  private dpsWindow: { t: number; amount: number }[] = [];
  private clock = 0;
  private stickPointer: number | null = null;
  private readonly stickOrigin = { x: 0, y: 0 };
  private aimPointer: number | null = null;
  private aimSlot: 'skill' | 'ultimate' | null = null;
  private readonly aimOrigin = { x: 0, y: 0 };

  constructor(parent: HTMLElement, options: HudOptions) {
    this.sim = options.sim;
    this.input = options.input;
    this.training = options.training;
    const player = options.sim.player;
    this.root = el('div', `hud device-${options.input.device}`);
    const pips = (team: TeamKind) => Array.from({ length: options.sim.config.roundsToWin }, () => `<i class="pip pip-${team}"></i>`).join('');

    this.root.innerHTML = `
      <div class="hud-top">
        <div class="team-strip team-signal" data-team="signal"></div>
        <div class="round-clock">
          <div class="pips" data-pips="signal">${this.training ? '' : pips('signal')}</div>
          <div class="clock-core">
            <time data-time>${this.training ? '∞' : formatTime(options.sim.config.roundSeconds)}</time>
            <span data-round>${escapeHtml(options.title)}</span>
          </div>
          <div class="pips" data-pips="rift">${this.training ? '' : pips('rift')}</div>
        </div>
        <div class="team-strip team-rift" data-team="rift"></div>
      </div>
      <button class="hud-pause icon-button" data-hud="pause" aria-label="Pause">${ICONS.pause}</button>
      <div class="killfeed" aria-live="polite"></div>
      <div class="announcer" aria-live="assertive"></div>
      <div class="hud-toast" role="status"></div>
      ${this.training ? '<div class="dps-meter"><span>Damage / sec</span><strong data-dps>0</strong><small>Dummies reset after 2.4s</small></div>' : ''}
      ${player ? this.playerMarkup(player) : ''}
      <div class="touch-layer">
        <div class="touch-stick-zone" data-touch="stick"><div class="touch-stick"><i></i></div></div>
        <div class="touch-buttons">
          <button class="touch-btn touch-ultimate" data-touch-slot="ultimate" aria-label="Ultimate">${ICONS.ultimate}<i class="touch-charge"></i></button>
          <button class="touch-btn touch-skill" data-touch-slot="skill" aria-label="Signature">${player ? elementIcon(player.definition.element) : ''}<i class="touch-cd"></i></button>
          <button class="touch-btn touch-dash" data-touch-slot="dash" aria-label="Dash">${ICONS.dash}<i class="touch-cd"></i></button>
          <button class="touch-btn touch-basic" data-touch-slot="basic" aria-label="Attack">${ICONS.basic}</button>
        </div>
      </div>`;
    parent.append(this.root);

    this.announcer = this.root.querySelector('.announcer')!;
    this.feed = this.root.querySelector('.killfeed')!;
    this.time = this.root.querySelector('[data-time]')!;
    this.roundLabel = this.root.querySelector('[data-round]')!;
    this.hpFill = this.root.querySelector<HTMLElement>('[data-hp]') ?? undefined;
    this.hpText = this.root.querySelector<HTMLElement>('[data-hp-text]') ?? undefined;
    this.energyFill = this.root.querySelector<HTMLElement>('[data-energy]') ?? undefined;
    for (const slot of ['basic', 'skill', 'dash', 'ultimate'] as const) {
      const node = this.root.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
      if (node) this.slots.set(slot, node);
    }

    for (const team of ['signal', 'rift'] as const) {
      const strip = this.root.querySelector<HTMLElement>(`[data-team="${team}"]`)!;
      for (const fighter of options.sim.team(team)) {
        const chip = el('div', `team-chip${fighter.id === options.sim.playerId ? ' is-player' : ''}${fighter.boss ? ' is-boss' : ''}`);
        chip.innerHTML = `<i class="chip-ring"></i><img src="${cutoutUrl(fighter.id)}" alt="" draggable="false" /><span class="chip-element el-${fighter.definition.element}">${elementIcon(fighter.definition.element)}</span>`;
        chip.title = fighter.definition.name;
        strip.append(chip);
        this.chips.push({ root: chip, ring: chip.querySelector('.chip-ring')!, id: fighter.id });
      }
    }

    this.root.querySelector<HTMLElement>('[data-hud="pause"]')?.addEventListener('click', (event) => {
      (event.currentTarget as HTMLElement).blur();
      options.onPause();
    });
    this.bindTouch();
    this.setDevice(options.input.device);
  }

  private playerMarkup(player: FighterState): string {
    const { definition, kit } = player;
    const slot = (name: Slot, icon: string, label: string, cost = '') => `
      <div class="ability ability-${name}" data-slot="${name}">
        <div class="ability-face">${icon}<i class="ability-sweep"></i><span class="ability-timer"></span></div>
        <span class="ability-key" data-glyph="${name}"></span>
        ${cost ? `<span class="ability-cost">${cost}</span>` : ''}
        <span class="ability-name">${escapeHtml(label)}</span>
      </div>`;
    return `
      <div class="player-card">
        <div class="player-portrait el-${definition.element}"><img src="${cutoutUrl(definition.id)}" alt="" draggable="false" /></div>
        <div class="player-meta">
          <div class="player-name"><strong>${escapeHtml(definition.name)}</strong><span class="element-tag el-${definition.element}">${elementIcon(definition.element)}${ELEMENT_LABEL[definition.element]}</span></div>
          <div class="bar bar-hp"><b class="bar-fill" data-hp></b><span data-hp-text></span></div>
          <div class="bar bar-energy"><b class="bar-fill" data-energy></b></div>
        </div>
      </div>
      <div class="ability-bar">
        ${slot('basic', ICONS.basic, kit.basic.label)}
        ${slot('skill', elementIcon(definition.element), kit.skill.label, String(kit.skill.energy))}
        ${slot('dash', ICONS.dash, 'Dash')}
        ${slot('ultimate', ICONS.ultimate, kit.ultimate.label)}
      </div>`;
  }

  setDevice(device: InputDevice): void {
    this.root.classList.remove('device-keyboard', 'device-gamepad', 'device-touch');
    this.root.classList.add(`device-${device}`);
    for (const node of this.root.querySelectorAll<HTMLElement>('[data-glyph]')) {
      node.textContent = GLYPHS[device][node.dataset.glyph as Slot];
    }
  }

  update(delta: number): void {
    this.clock += delta;
    const sim = this.sim;
    if (!this.training) {
      this.time.textContent = formatTime(sim.roundTimeLeft);
      this.time.classList.toggle('is-urgent', sim.phase === 'fight' && sim.roundTimeLeft <= 10);
    }
    for (const team of ['signal', 'rift'] as const) {
      this.root.querySelectorAll<HTMLElement>(`[data-pips="${team}"] .pip`).forEach((pip, index) => pip.classList.toggle('is-won', index < sim.score[team]));
    }
    for (const chip of this.chips) {
      const fighter = sim.fighters.get(chip.id);
      if (!fighter) continue;
      chip.ring.style.setProperty('--hp', String(fighter.hp / fighter.maxHp));
      chip.root.classList.toggle('is-down', !fighter.alive);
    }

    const player = sim.player;
    if (!player) return;
    const hp = player.hp / player.maxHp;
    if (this.hpFill) this.hpFill.style.transform = `scaleX(${hp})`;
    if (this.hpText) this.hpText.textContent = `${Math.ceil(player.hp)} / ${player.maxHp}`;
    this.hpFill?.parentElement?.classList.toggle('is-low', hp < 0.3);
    if (this.energyFill) this.energyFill.style.transform = `scaleX(${player.energy / MAX_ENERGY})`;

    const { kit } = player;
    this.setCooldown('basic', player.cooldowns.basic, kit.basic.cooldown, false);
    this.setCooldown('skill', player.cooldowns.skill, kit.skill.cooldown, player.energy < kit.skill.energy);
    this.setCooldown('dash', player.cooldowns.dash, kit.dash.cooldown, false);
    const charge = Math.min(1, player.ult / kit.ultimate.charge);
    const ult = this.slots.get('ultimate');
    if (ult) {
      ult.style.setProperty('--charge', String(charge));
      ult.classList.toggle('is-ready', charge >= 1);
      const timer = ult.querySelector('.ability-timer');
      if (timer) timer.textContent = charge >= 1 ? '' : `${Math.floor(charge * 100)}%`;
    }
    const touchUlt = this.root.querySelector<HTMLElement>('.touch-ultimate');
    touchUlt?.style.setProperty('--charge', String(charge));
    touchUlt?.classList.toggle('is-ready', charge >= 1);

    if (this.training) {
      const now = this.clock;
      this.dpsWindow = this.dpsWindow.filter(({ t }) => now - t < 5);
      const total = this.dpsWindow.reduce((sum, entry) => sum + entry.amount, 0);
      const dps = this.root.querySelector('[data-dps]');
      if (dps) dps.textContent = (total / 5).toFixed(1);
    }
  }

  private setCooldown(slot: Slot, remaining: number, total: number, starved: boolean): void {
    const node = this.slots.get(slot);
    const fraction = total > 0 ? Math.min(1, remaining / total) : 0;
    if (node) {
      node.style.setProperty('--cd', String(fraction));
      node.classList.toggle('is-cooling', fraction > 0);
      node.classList.toggle('is-starved', starved && fraction <= 0);
      const timer = node.querySelector('.ability-timer');
      if (timer) timer.textContent = remaining > 0.95 ? String(Math.ceil(remaining)) : '';
    }
    const touch = this.root.querySelector<HTMLElement>(`.touch-${slot}`);
    touch?.style.setProperty('--cd', String(fraction));
    touch?.classList.toggle('is-starved', starved && fraction <= 0);
  }

  recordPlayerDamage(amount: number): void {
    this.dpsWindow.push({ t: this.clock, amount });
  }

  setRoundLabel(text: string): void {
    this.roundLabel.textContent = text;
  }

  announce(text: string, sub = '', tone: 'neutral' | 'win' | 'lose' | 'gold' | 'fight' = 'neutral', duration = 1.4): void {
    window.clearTimeout(this.announceTimer);
    this.announcer.innerHTML = `<div class="announce announce-${tone}"><strong>${escapeHtml(text)}</strong>${sub ? `<span>${escapeHtml(sub)}</span>` : ''}</div>`;
    this.announceTimer = window.setTimeout(() => {
      this.announcer.firstElementChild?.classList.add('is-leaving');
      this.announceTimer = window.setTimeout(() => (this.announcer.innerHTML = ''), 380);
    }, duration * 1000);
  }

  pulseSlot(slot: Slot): void {
    const node = this.slots.get(slot);
    if (!node) return;
    node.classList.remove('is-pulse');
    void node.offsetWidth;
    node.classList.add('is-pulse');
  }

  denySlot(slot: Slot): void {
    const node = this.slots.get(slot);
    if (!node) return;
    node.classList.remove('is-denied');
    void node.offsetWidth;
    node.classList.add('is-denied');
  }

  killfeed(killer: FighterDefinition, killerTeam: TeamKind, victim: FighterDefinition, victimTeam: TeamKind): void {
    const entry = el('div', 'feed-entry');
    entry.innerHTML = `<span class="team-${killerTeam}">${escapeHtml(killer.name)}</span>${ICONS.swords}<span class="team-${victimTeam}">${escapeHtml(victim.name)}</span>`;
    this.feed.prepend(entry);
    while (this.feed.children.length > 4) this.feed.lastElementChild?.remove();
    window.setTimeout(() => entry.classList.add('is-leaving'), 4200);
    window.setTimeout(() => entry.remove(), 4700);
  }

  /** Fighting-game style ultimate cut-in banner. */
  cutIn(fighter: FighterDefinition, label: string, team: TeamKind): void {
    const banner = el('div', `cut-in team-${team} el-${fighter.element}`);
    banner.innerHTML = `<div class="cut-in-band"></div><img src="${cutoutUrl(fighter.id)}" alt="" /><div class="cut-in-copy"><span>${escapeHtml(fighter.name)}</span><strong>${escapeHtml(label)}</strong></div>`;
    this.root.append(banner);
    window.setTimeout(() => banner.remove(), 1500);
  }

  toast(text: string, duration = 2.2): void {
    const node = this.root.querySelector<HTMLElement>('.hud-toast');
    if (!node) return;
    window.clearTimeout(this.toastTimer);
    node.textContent = text;
    node.classList.add('is-visible');
    this.toastTimer = window.setTimeout(() => node.classList.remove('is-visible'), duration * 1000);
  }

  flashHurt(): void {
    this.root.classList.remove('is-hurt');
    void this.root.offsetWidth;
    this.root.classList.add('is-hurt');
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('is-hidden', !visible);
  }

  dispose(): void {
    window.clearTimeout(this.announceTimer);
    window.clearTimeout(this.toastTimer);
    this.input.setTouchMove(0, 0);
    this.input.setTouchBasic(false);
    this.root.remove();
  }

  // ----------------------------------------------------------------- touch

  private bindTouch(): void {
    const zone = this.root.querySelector<HTMLElement>('[data-touch="stick"]');
    const stick = this.root.querySelector<HTMLElement>('.touch-stick');
    const knob = stick?.querySelector<HTMLElement>('i');
    if (zone && stick && knob) {
      zone.addEventListener('pointerdown', (event) => {
        if (this.stickPointer !== null) return;
        this.stickPointer = event.pointerId;
        zone.setPointerCapture(event.pointerId);
        const bounds = zone.getBoundingClientRect();
        this.stickOrigin.x = event.clientX;
        this.stickOrigin.y = event.clientY;
        stick.style.left = `${event.clientX - bounds.left}px`;
        stick.style.top = `${event.clientY - bounds.top}px`;
        stick.classList.add('is-active');
      });
      zone.addEventListener('pointermove', (event) => {
        if (event.pointerId !== this.stickPointer) return;
        const radius = 56;
        const dx = event.clientX - this.stickOrigin.x;
        const dy = event.clientY - this.stickOrigin.y;
        const length = Math.hypot(dx, dy);
        const clamped = Math.min(radius, length);
        const nx = length > 0 ? dx / length : 0;
        const ny = length > 0 ? dy / length : 0;
        knob.style.transform = `translate(${nx * clamped}px, ${ny * clamped}px)`;
        const strength = clamped / radius;
        this.input.setTouchMove(nx * (strength > 0.18 ? strength : 0), ny * (strength > 0.18 ? strength : 0));
      });
      const release = (event: PointerEvent) => {
        if (event.pointerId !== this.stickPointer) return;
        this.stickPointer = null;
        knob.style.transform = '';
        stick.classList.remove('is-active');
        this.input.setTouchMove(0, 0);
      };
      zone.addEventListener('pointerup', release);
      zone.addEventListener('pointercancel', release);
    }

    for (const button of this.root.querySelectorAll<HTMLElement>('[data-touch-slot]')) {
      const slot = button.dataset.touchSlot as Slot;
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        button.setPointerCapture(event.pointerId);
        button.classList.add('is-pressed');
        if (slot === 'basic') this.input.setTouchBasic(true);
        else if (slot === 'dash') this.input.trigger('dash');
        else {
          this.aimPointer = event.pointerId;
          this.aimSlot = slot === 'skill' ? 'skill' : 'ultimate';
          this.aimOrigin.x = event.clientX;
          this.aimOrigin.y = event.clientY;
          this.input.setTouchAim(0, 0, 0);
        }
      });
      button.addEventListener('pointermove', (event) => {
        if (event.pointerId !== this.aimPointer) return;
        const dx = event.clientX - this.aimOrigin.x;
        const dy = event.clientY - this.aimOrigin.y;
        const length = Math.hypot(dx, dy);
        if (length < 14) {
          this.input.setTouchAim(0, 0, 0);
          return;
        }
        this.input.setTouchAim(dx / length, dy / length, Math.min(1, length / 110));
      });
      const release = (event: PointerEvent) => {
        button.classList.remove('is-pressed');
        if (slot === 'basic') this.input.setTouchBasic(false);
        if (event.pointerId === this.aimPointer && this.aimSlot) {
          this.input.trigger(this.aimSlot);
          this.aimPointer = null;
          this.aimSlot = null;
          // Aim is read on the same frame the action is consumed, then cleared.
          window.setTimeout(() => this.input.setTouchAim(0, 0, 0), 50);
        }
      };
      button.addEventListener('pointerup', release);
      button.addEventListener('pointercancel', release);
    }
  }
}
