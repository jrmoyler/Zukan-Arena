import * as THREE from 'three';

import type { Effectiveness } from '../data/kits';
import type { TeamKind } from '../types';
import { el, escapeHtml } from './dom';
import { elementIcon } from './icons';
import type { ElementKind } from '../types';

/**
 * DOM layer pinned to world positions: fighter nameplates (health with a
 * trailing "ghost" bar, status chips) and pooled floating combat text.
 * DOM keeps text crisp at any resolution and is cheap at these counts.
 */

export interface PlateState {
  hp: number;
  maxHp: number;
  alive: boolean;
  statuses: string[];
  ultReady: boolean;
}

interface Plate {
  root: HTMLDivElement;
  fill: HTMLElement;
  ghost: HTMLElement;
  status: HTMLElement;
  ghostValue: number;
  statusKey: string;
}

interface FloatingText {
  node: HTMLDivElement;
  world: THREE.Vector3;
  age: number;
  life: number;
  drift: number;
  active: boolean;
}

export type FloatingKind = 'damage' | 'crit' | 'heal' | 'player-hit' | 'info';

export class WorldOverlay {
  readonly root: HTMLDivElement;
  private readonly plates = new Map<string, Plate>();
  private readonly texts: FloatingText[] = [];
  private readonly screen = new THREE.Vector2();
  enabledNumbers = true;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'world-overlay');
    parent.append(this.root);
  }

  addPlate(id: string, name: string, element: ElementKind, team: TeamKind, isPlayer: boolean, boss: boolean): void {
    const root = el('div', `plate team-${team}${isPlayer ? ' is-player' : ''}${boss ? ' is-boss' : ''}`);
    root.innerHTML = `
      <div class="plate-name"><span class="plate-element el-${element}">${elementIcon(element)}</span><span>${escapeHtml(isPlayer ? 'You' : name)}</span></div>
      <div class="plate-bar"><b class="plate-ghost"></b><b class="plate-fill"></b></div>
      <div class="plate-status"></div>`;
    this.root.append(root);
    this.plates.set(id, {
      root,
      fill: root.querySelector('.plate-fill')!,
      ghost: root.querySelector('.plate-ghost')!,
      status: root.querySelector('.plate-status')!,
      ghostValue: 1,
      statusKey: '',
    });
  }

  updatePlate(id: string, world: THREE.Vector3, project: (world: THREE.Vector3, out: THREE.Vector2) => boolean, state: PlateState, delta: number): void {
    const plate = this.plates.get(id);
    if (!plate) return;
    const onScreen = project(world, this.screen);
    plate.root.classList.toggle('is-down', !state.alive);
    plate.root.style.visibility = onScreen && state.alive ? 'visible' : 'hidden';
    plate.root.style.transform = `translate3d(${this.screen.x.toFixed(1)}px, ${this.screen.y.toFixed(1)}px, 0)`;
    const fraction = Math.max(0, state.hp / state.maxHp);
    plate.fill.style.transform = `scaleX(${fraction})`;
    plate.ghostValue = fraction > plate.ghostValue ? fraction : Math.max(fraction, plate.ghostValue - delta * 0.6);
    plate.ghost.style.transform = `scaleX(${plate.ghostValue})`;
    plate.root.classList.toggle('is-low', fraction < 0.3 && state.alive);
    plate.root.classList.toggle('ult-ready', state.ultReady && state.alive);
    const key = state.statuses.join('|');
    if (key !== plate.statusKey) {
      plate.statusKey = key;
      plate.status.innerHTML = state.statuses.map((status) => `<i class="chip chip-${status.toLowerCase()}">${status}</i>`).join('');
    }
  }

  /** Spawns floating combat text at a world position. */
  pop(world: THREE.Vector3, text: string, kind: FloatingKind, effectiveness: Effectiveness = 'neutral'): void {
    if (!this.enabledNumbers && kind !== 'info') return;
    let entry = this.texts.find(({ active }) => !active);
    if (!entry) {
      if (this.texts.length >= 48) entry = this.texts.reduce((oldest, current) => (current.age > oldest.age ? current : oldest));
      else {
        entry = { node: el('div', 'float-text'), world: new THREE.Vector3(), age: 0, life: 1, drift: 0, active: false };
        this.root.append(entry.node);
        this.texts.push(entry);
      }
    }
    entry.world.copy(world);
    entry.age = 0;
    entry.life = kind === 'info' ? 1.4 : kind === 'crit' ? 1.1 : 0.9;
    entry.drift = (Math.random() - 0.5) * 34;
    entry.active = true;
    const node = entry.node;
    node.className = `float-text ft-${kind} ft-${effectiveness}`;
    node.innerHTML = effectiveness === 'neutral' || kind === 'heal' || kind === 'info'
      ? escapeHtml(text)
      : `${escapeHtml(text)}<small>${effectiveness === 'resonant' ? 'Resonant' : 'Resisted'}</small>`;
    // Restart the CSS pop animation.
    node.style.animation = 'none';
    void node.offsetWidth;
    node.style.animation = '';
  }

  updateTexts(delta: number, project: (world: THREE.Vector3, out: THREE.Vector2) => boolean): void {
    for (const entry of this.texts) {
      if (!entry.active) continue;
      entry.age += delta;
      if (entry.age >= entry.life) {
        entry.active = false;
        entry.node.style.opacity = '0';
        continue;
      }
      project(entry.world, this.screen);
      const t = entry.age / entry.life;
      const rise = 18 + (1 - Math.pow(1 - t, 3)) * 46;
      entry.node.style.opacity = '';
      entry.node.style.transform = `translate3d(${(this.screen.x + entry.drift * t).toFixed(1)}px, ${(this.screen.y - rise).toFixed(1)}px, 0)`;
    }
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  dispose(): void {
    this.root.remove();
  }
}
