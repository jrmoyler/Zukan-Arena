import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { AudioEngine } from './audio/AudioEngine';
import { PhysicsBridge } from './physics/PhysicsBridge';
import { ABILITIES, ELEMENT_ORDER } from './data/abilities';
import { ROSTER } from './data/roster';
import { ElementalVfxManager } from './render/ElementalVfx';
import { createFighterRig, disposeFighterTextureCache, type FighterRigRuntime } from './render/FighterRig';
import { LivingArena } from './render/LivingArena';
import {
  MATCH_DURATION_SECONDS,
  CombatSimulation,
  type CombatMatchSummary,
  type FighterState,
} from './simulation/CombatSimulation';
import type { ElementKind, FighterDefinition } from './types';

type Screen = 'landing' | 'select' | 'battle' | 'result';

interface BattleRig {
  runtime: FighterRigRuntime;
  state: FighterState;
  lastHp: number;
}

const ELEMENT_LABEL: Record<ElementKind, string> = {
  earth: 'Earth',
  hydro: 'Hydro',
  gale: 'Gale',
  plasma: 'Plasma',
  nature: 'Nature',
  void: 'Void',
};

const ELEMENT_COLOR: Record<ElementKind, string> = {
  earth: '#b88a50',
  hydro: '#4ccce4',
  gale: '#b8e6dd',
  plasma: '#f2c84b',
  nature: '#65bb68',
  void: '#9a73df',
};

function canUseWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: true }));
  } catch {
    return false;
  }
}

function chooseQuality(): 'high' | 'low' {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  return reducedMotion || memory <= 4 || window.innerWidth < 760 ? 'low' : 'high';
}

function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

export class ZukanArenaGame {
  private readonly host: HTMLElement;
  private readonly shell: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ui: HTMLDivElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 90);
  private readonly clock = new THREE.Clock();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly aimPoint = new THREE.Vector3(2, 0, 0);
  private readonly aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly audio = new AudioEngine();
  private readonly quality = chooseQuality();
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly environmentTexture: THREE.Texture;
  private readonly composer?: EffectComposer;
  private readonly arena: LivingArena;
  private readonly vfx: ElementalVfxManager;
  private readonly targetReticle: THREE.Group;
  private screen: Screen = 'landing';
  private selected = ROSTER[0] as FighterDefinition;
  private previewRig?: FighterRigRuntime;
  private simulation?: CombatSimulation;
  private battleRigs = new Map<string, BattleRig>();
  private selectedElement: ElementKind = this.selected.element;
  private search = '';
  private filter: ElementKind | 'all' = 'all';
  private paused = false;
  private animationFrame = 0;
  private elapsed = 0;
  private toastUntil = 0;
  private keys = new Set<string>();
  private result?: CombatMatchSummary;
  private previewDragging = false;
  private previewPointerX = 0;
  private previewYaw = 0;
  private resultTimer?: number;
  private physics?: PhysicsBridge;
  private disposed = false;

  constructor(host: HTMLElement) {
    this.host = host;
    this.shell = document.createElement('div');
    this.shell.className = 'game-shell';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'game-canvas';
    this.canvas.tabIndex = 0;
    this.ui = document.createElement('div');
    this.ui.className = 'ui-layer';
    this.shell.append(this.canvas, Object.assign(document.createElement('div'), { className: 'grain' }), this.ui);
    this.host.append(this.shell);

    if (!canUseWebGL()) {
      this.shell.innerHTML = `
        <div class="compatibility">
          <section class="modal">
            <p class="eyebrow">Renderer check</p>
            <h2>WebGL 2 is required</h2>
            <p>This edition uses skinned meshes, physical materials, dynamic water and volumetric effects. Enable hardware acceleration or open it in a current desktop or mobile browser.</p>
          </section>
        </div>`;
      throw new Error('WebGL 2 unavailable');
    }

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.quality === 'high',
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.04;
    this.renderer.shadowMap.enabled = this.quality === 'high';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality === 'high' ? 1.8 : 1.2));
    const environment = new RoomEnvironment();
    const generator = new THREE.PMREMGenerator(this.renderer);
    this.environmentTexture = generator.fromScene(environment, 0.05).texture;
    this.scene.environment = this.environmentTexture;
    environment.dispose();
    generator.dispose();
    this.scene.background = new THREE.Color(0xdedbd0);
    this.scene.fog = new THREE.FogExp2(0xdedbd0, 0.018);

    this.arena = new LivingArena({
      quality: this.quality === 'high' ? 'high' : 'low',
      castShadows: this.quality === 'high',
    });
    this.scene.add(this.arena);
    this.vfx = new ElementalVfxManager(this.scene, {
      quality: this.quality,
      reducedMotion: this.reducedMotion,
      onImpact: (event) => this.audio.impact(event.element),
    });
    this.targetReticle = this.createTargetReticle();
    this.scene.add(this.targetReticle);

    if (this.quality === 'high') {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.23, 0.42, 1.06));
      this.composer.addPass(new OutputPass());
    }

    this.bindEvents();
    this.showLanding();
    this.resize();
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.animationFrame);
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    if (this.resultTimer !== undefined) window.clearTimeout(this.resultTimer);
    this.physics?.dispose();
    this.physics = undefined;
    this.previewRig?.dispose();
    for (const rig of this.battleRigs.values()) rig.runtime.dispose();
    this.vfx.dispose();
    this.arena.dispose();
    this.targetReticle.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.dispose();
      }
    });
    this.composer?.dispose();
    this.environmentTexture.dispose();
    this.renderer.dispose();
    void this.audio.dispose();
    void disposeFighterTextureCache();
    this.shell.remove();
  }

  private bindEvents(): void {
    window.addEventListener('resize', this.resize);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  private showLanding(): void {
    this.screen = 'landing';
    this.clearBattle();
    this.spawnPreview(this.selected, new THREE.Vector3(3.5, 0, 0), 1.25);
    this.targetReticle.visible = false;
    this.camera.position.set(6.8, 3.2, 8.7);
    this.camera.lookAt(2.7, 1.1, 0);
    this.ui.innerHTML = `
      <div class="brand"><span class="brand-mark">Z</span><span>Solana Zukan Arena</span></div>
      <main class="landing">
        <div class="landing-copy">
          <p class="eyebrow">Season 01 · Rift Skirmish</p>
          <h1>Living <span>legends.</span></h1>
          <p class="lede">Sixty-eight Zukan have stepped out of the archive and into a fully physical arena. Command a real skeletal fighter, master six elemental forces, and break the Rift.</p>
          <button class="primary-action" data-action="enter">Choose your fighter &nbsp;→</button>
        </div>
      </main>`;
    this.ui.querySelector<HTMLElement>('[data-action="enter"]')?.addEventListener('click', () => {
      void this.audio.unlock();
      this.showSelection();
    });
  }

  private showSelection(): void {
    this.screen = 'select';
    this.clearBattle();
    this.previewYaw = 0;
    this.spawnPreview(this.selected, new THREE.Vector3(0, 0, 0), 1.28);
    this.targetReticle.visible = false;
    this.camera.position.set(0, 2.75, 7.25);
    this.camera.lookAt(0, 1.15, 0);
    this.renderSelection();
  }

  private renderSelection(): void {
    const ability = ABILITIES[this.selected.element];
    this.ui.innerHTML = `
      <div class="brand"><span class="brand-mark">Z</span><span>Fighter archive</span></div>
      <main class="select-layout">
        <section class="roster-panel glass-panel">
          <div class="panel-heading"><h2>Choose a Zukan</h2><span>${ROSTER.length} discovered</span></div>
          <div class="search-row">
            <input type="search" aria-label="Search fighters" placeholder="Search the archive" value="${escapeHtml(this.search)}" />
            <div class="filters">
              ${(['all', ...ELEMENT_ORDER] as const).map((element) => `<button class="filter-chip ${this.filter === element ? 'active' : ''}" data-filter="${element}">${element}</button>`).join('')}
            </div>
          </div>
          <div class="fighter-grid" role="listbox" aria-label="Zukan roster"></div>
        </section>
        <section class="preview-stage"><p class="preview-note">Drag to orbit · wheel to zoom · skeletal runtime</p><div class="preview-actions"><button data-preview-action="idle">Idle</button><button data-preview-action="run">Move</button><button data-preview-action="cast">Cast</button></div><div class="mobile-deploy"><strong>${escapeHtml(this.selected.name)}</strong><button data-action="mobile-deploy">Deploy →</button></div></section>
        <aside class="dossier glass-panel">
          <p class="eyebrow">No. ${String(this.selected.index).padStart(3, '0')}</p>
          <h2>${escapeHtml(this.selected.name)}</h2>
          <p class="epithet">${escapeHtml(this.selected.epithet)}</p>
          <div class="identity-tags">
            <span class="identity-tag" style="border-color:${ELEMENT_COLOR[this.selected.element]}">${ELEMENT_LABEL[this.selected.element]}</span>
            <span class="identity-tag">${this.selected.role}</span>
            <span class="identity-tag">${this.selected.archetype}</span>
          </div>
          <div class="stats">
            ${this.statRow('Vitality', this.selected.maxHp, 140)}
            ${this.statRow('Mobility', this.selected.speed, 5)}
            ${this.statRow('Power', this.selected.power, 1.1)}
          </div>
          <article class="ability-card">
            <p class="eyebrow">Signature force</p>
            <h3>${ability.label}</h3>
            <p>${ability.description}</p>
            <div class="ability-meta"><span>${ability.damage} impact</span><span>${ability.energy} energy</span><span>${ability.cooldown}s</span></div>
          </article>
          <button class="deploy-button" data-action="deploy">Deploy ${escapeHtml(this.selected.name)} &nbsp;→</button>
        </aside>
      </main>`;
    this.renderFighterGrid();
    this.ui.querySelector<HTMLInputElement>('input[type="search"]')?.addEventListener('input', (event) => {
      this.search = (event.currentTarget as HTMLInputElement).value;
      this.renderFighterGrid();
    });
    this.ui.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        this.filter = (button.dataset.filter ?? 'all') as ElementKind | 'all';
        this.renderSelection();
      });
    });
    this.ui.querySelector<HTMLElement>('[data-action="deploy"]')?.addEventListener('click', () => this.startBattle());
    this.ui.querySelector<HTMLElement>('[data-action="mobile-deploy"]')?.addEventListener('click', () => this.startBattle());
    this.ui.querySelectorAll<HTMLButtonElement>('[data-preview-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.previewAction;
        if (action === 'idle' || action === 'run') this.previewRig?.play(action, false);
        if (action === 'cast') this.previewRig?.play('cast', true);
      });
    });
  }

  private renderFighterGrid(): void {
    const grid = this.ui.querySelector<HTMLDivElement>('.fighter-grid');
    if (!grid) return;
    const query = this.search.trim().toLowerCase();
    const filtered = ROSTER.filter((fighter) => {
      const matchesFilter = this.filter === 'all' || fighter.element === this.filter;
      const matchesSearch = !query || `${fighter.name} ${fighter.epithet} ${fighter.role}`.toLowerCase().includes(query);
      return matchesFilter && matchesSearch;
    });
    grid.innerHTML = filtered.map((fighter) => `
      <button class="fighter-card ${fighter.id === this.selected.id ? 'selected' : ''}" role="option" aria-selected="${fighter.id === this.selected.id}" data-fighter="${fighter.id}">
        <img src="${fighter.portrait}" alt="" loading="lazy" />
        <span class="fighter-card-copy"><strong>${escapeHtml(fighter.name)}</strong><span>${fighter.element} · ${fighter.role}</span></span>
      </button>`).join('');
    grid.querySelectorAll<HTMLButtonElement>('[data-fighter]').forEach((button) => {
      button.addEventListener('click', () => {
        const fighter = ROSTER.find(({ id }) => id === button.dataset.fighter);
        if (!fighter || fighter.id === this.selected.id) return;
        this.selected = fighter;
        this.selectedElement = fighter.element;
        this.spawnPreview(fighter, new THREE.Vector3(0, 0, 0), 1.28);
        this.renderSelection();
      });
    });
  }

  private statRow(label: string, value: number, max: number): string {
    return `<div class="stat"><span>${label}</span><div class="stat-track"><div class="stat-fill" style="width:${Math.min(100, value / max * 100)}%"></div></div><strong>${value.toFixed(value < 10 ? 1 : 0)}</strong></div>`;
  }

  private startBattle(): void {
    this.screen = 'battle';
    this.result = undefined;
    this.paused = false;
    this.previewRig?.root.removeFromParent();
    this.previewRig?.dispose();
    this.previewRig = undefined;
    this.vfx.clear();
    const selectedIndex = ROSTER.findIndex(({ id }) => id === this.selected.id);
    const allyOne = ROSTER[(selectedIndex + 9) % ROSTER.length] as FighterDefinition;
    const allyTwo = ROSTER[(selectedIndex + 21) % ROSTER.length] as FighterDefinition;
    const enemies = [5, 17, 33, 49].map((offset) => ROSTER[(selectedIndex + offset) % ROSTER.length] as FighterDefinition);
    this.simulation = new CombatSimulation(this.selected, [allyOne, allyTwo], enemies, {
      onCast: (event) => {
        const visualOrigin = event.origin.clone();
        const socket = this.battleRigs.get(event.casterId)?.runtime.sockets.get('ability');
        socket?.getWorldPosition(visualOrigin);
        this.vfx.emit({ ...event, origin: visualOrigin });
        this.audio.cast(event.element);
        this.battleRigs.get(event.casterId)?.runtime.play('cast');
      },
      onDamage: ({ targetId }) => this.battleRigs.get(targetId)?.runtime.play('hit'),
      onKnockout: ({ targetId }) => this.battleRigs.get(targetId)?.runtime.play('ko'),
      onMatchEnd: (summary) => {
        this.result = summary;
        this.resultTimer = window.setTimeout(() => this.showResult(summary), 650);
      },
    }, Date.now() & 0xffff_ffff);
    this.spawnBattleRigs();
    const activeSimulation = this.simulation;
    void PhysicsBridge.create(activeSimulation.snapshot()).then((physics) => {
      if (this.disposed || this.simulation !== activeSimulation) return physics.dispose();
      this.physics?.dispose();
      this.physics = physics;
    }).catch((error: unknown) => console.warn('[Zukan Arena] Physics fallback active', error));
    this.selectedElement = this.selected.element;
    const playerPosition = this.simulation.player.position;
    this.aimPoint.copy(playerPosition).add(new THREE.Vector3(3.5, 0, 0));
    this.targetReticle.position.set(this.aimPoint.x, 0.035, this.aimPoint.z);
    this.targetReticle.visible = true;
    this.camera.position.set(0, 11.8, 13.7);
    this.camera.lookAt(0, 0, 0);
    this.renderBattleHud();
  }

  private spawnBattleRigs(): void {
    for (const battleRig of this.battleRigs.values()) {
      battleRig.runtime.root.removeFromParent();
      battleRig.runtime.dispose();
    }
    this.battleRigs.clear();
    if (!this.simulation) return;
    for (const state of this.simulation.snapshot()) {
      const runtime = createFighterRig(state.definition, this.quality);
      runtime.setTeam(state.team);
      runtime.root.position.copy(state.position);
      runtime.root.scale.setScalar(state.id === this.simulation.playerId ? 0.9 : 0.82);
      this.scene.add(runtime.root);
      this.battleRigs.set(state.id, { runtime, state, lastHp: state.hp });
    }
  }

  private renderBattleHud(): void {
    if (!this.simulation) return;
    this.ui.innerHTML = `
      <div class="battle-hud">
        <div class="scoreboard">
          <span class="team-score"><i class="score-dot"></i>Signal <b data-signal>3</b></span>
          <time class="match-time" data-time>2:00</time>
          <span class="team-score rift"><b data-rift>4</b> Rift<i class="score-dot"></i></span>
        </div>
        <button class="pause-button" data-action="pause">Pause</button>
        <p class="controls-hint">WASD / arrows to move<br>Pointer to aim · click to cast<br>1—6 change force · Esc pauses</p>
        <div class="player-hud">
          <img class="hud-portrait" src="${this.selected.portrait}" alt="${escapeHtml(this.selected.name)}" />
          <div><strong class="hud-name">${escapeHtml(this.selected.name)}</strong><div class="hud-bars"><div class="hud-bar hp"><span data-hp></span></div><div class="hud-bar energy"><span data-energy></span></div></div></div>
          <div class="ability-deck">
            ${ELEMENT_ORDER.map((element, index) => `<button class="ability-button ${element === this.selectedElement ? 'active' : ''}" data-element="${element}"><span class="ability-index">${index + 1}</span><strong>${ABILITIES[element].label}</strong><small>${ABILITIES[element].energy} EN</small><i class="cooldown-mask" data-cooldown="${element}"></i></button>`).join('')}
          </div>
        </div>
        <div class="touch-stick" aria-label="Touch movement controls">
          <button data-move="up">↑</button><button data-move="left">←</button><button data-move="down">↓</button><button data-move="right">→</button>
        </div>
      </div>`;
    this.ui.querySelector<HTMLElement>('[data-action="pause"]')?.addEventListener('click', () => this.togglePause());
    this.ui.querySelectorAll<HTMLButtonElement>('[data-element]').forEach((button) => {
      button.addEventListener('click', () => {
        const element = button.dataset.element as ElementKind;
        this.selectedElement = element;
        this.cast(element);
      });
    });
    this.ui.querySelectorAll<HTMLButtonElement>('[data-move]').forEach((button) => {
      const key = button.dataset.move ?? '';
      const start = (event: PointerEvent) => { event.preventDefault(); this.keys.add(key); };
      const stop = () => this.keys.delete(key);
      button.addEventListener('pointerdown', start);
      button.addEventListener('pointerup', stop);
      button.addEventListener('pointercancel', stop);
      button.addEventListener('pointerleave', stop);
    });
    this.updateBattleHud();
  }

  private updateBattleHud(): void {
    if (!this.simulation || this.screen !== 'battle') return;
    const player = this.simulation.player;
    const timeLeft = Math.max(0, MATCH_DURATION_SECONDS - this.simulation.elapsed);
    const minutes = Math.floor(timeLeft / 60);
    const seconds = Math.floor(timeLeft % 60).toString().padStart(2, '0');
    const time = this.ui.querySelector<HTMLElement>('[data-time]');
    if (time) time.textContent = `${minutes}:${seconds}`;
    const hp = this.ui.querySelector<HTMLElement>('[data-hp]');
    const energy = this.ui.querySelector<HTMLElement>('[data-energy]');
    if (hp) hp.style.width = `${player.hp / player.definition.maxHp * 100}%`;
    if (energy) energy.style.width = `${player.energy}%`;
    const signalAlive = this.simulation.snapshot().filter(({ team, alive }) => team === 'signal' && alive).length;
    const riftAlive = this.simulation.snapshot().filter(({ team, alive }) => team === 'rift' && alive).length;
    const signal = this.ui.querySelector<HTMLElement>('[data-signal]');
    const rift = this.ui.querySelector<HTMLElement>('[data-rift]');
    if (signal) signal.textContent = String(signalAlive);
    if (rift) rift.textContent = String(riftAlive);
    for (const element of ELEMENT_ORDER) {
      const cooldown = player.cooldowns[element];
      const button = this.ui.querySelector<HTMLElement>(`[data-element="${element}"]`);
      button?.classList.toggle('active', element === this.selectedElement);
      button?.classList.toggle('unavailable', cooldown > 0 || player.energy < ABILITIES[element].energy);
      const mask = this.ui.querySelector<HTMLElement>(`[data-cooldown="${element}"]`);
      if (mask) mask.style.height = `${cooldown / ABILITIES[element].cooldown * 100}%`;
    }
  }

  private showResult(summary: CombatMatchSummary): void {
    if (this.result !== summary) return;
    this.screen = 'result';
    this.targetReticle.visible = false;
    const title = summary.result === 'win' ? 'Rift sealed.' : 'Signal broken.';
    this.ui.innerHTML = `
      <div class="modal-backdrop">
        <section class="modal">
          <p class="eyebrow">Match complete</p>
          <h2>${title}</h2>
          <p>${summary.knockouts} knockouts · ${summary.xp} archive XP · ${summary.glb} GLB<br>${Math.round(summary.durationMs / 1000)} seconds in the arena</p>
          <button class="primary-action" data-action="again">Return to archive</button>
        </section>
      </div>`;
    this.ui.querySelector<HTMLElement>('[data-action="again"]')?.addEventListener('click', () => this.showSelection());
  }

  private togglePause(): void {
    if (this.screen !== 'battle') return;
    this.paused = !this.paused;
    if (!this.paused) {
      this.clock.getDelta();
      this.renderBattleHud();
      return;
    }
    this.ui.insertAdjacentHTML('beforeend', `
      <div class="modal-backdrop" data-pause-modal>
        <section class="modal"><p class="eyebrow">Simulation paused</p><h2>Catch your signal.</h2><p>The arena is frozen. Your cooldowns and timer will resume with you.</p><button class="primary-action" data-action="resume">Resume match</button></section>
      </div>`);
    this.ui.querySelector<HTMLElement>('[data-action="resume"]')?.addEventListener('click', () => this.togglePause());
  }

  private cast(element: ElementKind): void {
    if (!this.simulation || this.paused) return;
    this.selectedElement = element;
    const offset = this.aimPoint.clone().sub(this.simulation.player.position);
    const range = ABILITIES[element].range;
    if (offset.length() > range) this.aimPoint.copy(this.simulation.player.position).add(offset.setLength(range));
    this.targetReticle.position.set(this.aimPoint.x, 0.035, this.aimPoint.z);
    if (!this.simulation.tryCast(this.simulation.playerId, element, this.aimPoint)) {
      this.showToast('Force unavailable · check energy and cooldown');
    }
  }

  private showToast(message: string): void {
    this.ui.querySelector('.toast')?.remove();
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    this.ui.append(toast);
    this.toastUntil = this.elapsed + 1.8;
  }

  private spawnPreview(fighter: FighterDefinition, position: THREE.Vector3, scale: number): void {
    this.previewRig?.root.removeFromParent();
    this.previewRig?.dispose();
    this.previewRig = createFighterRig(fighter, this.quality);
    this.previewRig.root.position.copy(position);
    this.previewRig.root.scale.setScalar(scale);
    this.previewRig.setTeam('signal');
    this.scene.add(this.previewRig.root);
  }

  private clearBattle(): void {
    this.simulation = undefined;
    this.physics?.dispose();
    this.physics = undefined;
    for (const { runtime } of this.battleRigs.values()) {
      runtime.root.removeFromParent();
      runtime.dispose();
    }
    this.battleRigs.clear();
    this.vfx.clear();
  }

  private createTargetReticle(): THREE.Group {
    const group = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color: 0xf4f0d7, transparent: true, opacity: 0.75, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.39, 32), material);
    ring.rotation.x = -Math.PI / 2;
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.045, 16), material.clone());
    dot.rotation.x = -Math.PI / 2;
    dot.position.y = 0.005;
    group.add(ring, dot);
    group.position.y = 0.035;
    return group;
  }

  private updateAim(event: PointerEvent): void {
    const bounds = this.canvas.getBoundingClientRect();
    this.pointer.set(
      (event.clientX - bounds.left) / bounds.width * 2 - 1,
      -(event.clientY - bounds.top) / bounds.height * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.aimPlane, this.aimPoint);
    if (hit) {
      this.aimPoint.x = THREE.MathUtils.clamp(this.aimPoint.x, -9.2, 9.2);
      this.aimPoint.z = THREE.MathUtils.clamp(this.aimPoint.z, -5.6, 5.6);
      const player = this.simulation?.player;
      if (player) {
        const offset = this.aimPoint.clone().sub(player.position);
        const range = ABILITIES[this.selectedElement].range;
        if (offset.length() > range) this.aimPoint.copy(player.position).add(offset.setLength(range));
      }
      this.targetReticle.position.set(this.aimPoint.x, 0.035, this.aimPoint.z);
    }
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.screen === 'battle') this.updateAim(event);
    if ((this.screen === 'landing' || this.screen === 'select') && this.previewDragging) {
      const deltaX = event.clientX - this.previewPointerX;
      this.previewPointerX = event.clientX;
      this.previewYaw += deltaX * 0.012;
    }
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    void this.audio.unlock();
    if (this.screen === 'battle' && !this.paused) {
      this.updateAim(event);
      this.cast(this.selectedElement);
      return;
    }
    if (this.screen === 'landing' || this.screen === 'select') {
      this.previewDragging = true;
      this.previewPointerX = event.clientX;
      this.canvas.setPointerCapture(event.pointerId);
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.previewDragging = false;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (this.screen !== 'select') return;
    event.preventDefault();
    this.camera.position.z = THREE.MathUtils.clamp(this.camera.position.z + event.deltaY * 0.004, 5.3, 9.2);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return;
    if (event.repeat && !['w', 'a', 's', 'd'].includes(event.key.toLowerCase())) return;
    const key = event.key.toLowerCase();
    this.keys.add(key);
    if (this.screen === 'battle' && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(event.key)) event.preventDefault();
    if (event.key === 'Escape') this.togglePause();
    const element = ELEMENT_ORDER[Number(event.key) - 1];
    if (element && this.screen === 'battle') {
      this.selectedElement = element;
      this.cast(element);
    }
    if (event.code === 'Space' && this.screen === 'battle') {
      event.preventDefault();
      this.cast(this.selectedElement);
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.key.toLowerCase());
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
    if (this.screen === 'battle' && !this.paused) this.togglePause();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') this.onBlur();
  };

  private updateSimulation(delta: number): void {
    if (!this.simulation || this.paused || this.simulation.ended) return;
    const horizontal = Number(this.keys.has('d') || this.keys.has('arrowright') || this.keys.has('right'))
      - Number(this.keys.has('a') || this.keys.has('arrowleft') || this.keys.has('left'));
    const vertical = Number(this.keys.has('s') || this.keys.has('arrowdown') || this.keys.has('down'))
      - Number(this.keys.has('w') || this.keys.has('arrowup') || this.keys.has('up'));
    this.simulation.input.movement.set(horizontal, vertical);
    this.simulation.input.aim.copy(this.aimPoint);
    this.simulation.update(delta);
    this.physics?.sync(this.simulation.snapshot());
    for (const battleRig of this.battleRigs.values()) {
      const { runtime, state } = battleRig;
      runtime.root.position.lerp(state.position, Math.min(1, delta * 16));
      if (state.velocity.lengthSq() > 0.03 && state.alive) {
        runtime.root.rotation.y = Math.atan2(state.velocity.x, state.velocity.z);
        runtime.play('run', false);
      } else if (state.alive) {
        runtime.play('idle', false);
      }
      runtime.update(delta);
      battleRig.lastHp = state.hp;
    }
    const player = this.simulation.player;
    const cameraTarget = new THREE.Vector3(player.position.x * 0.13, 0, player.position.z * 0.1);
    const cameraPosition = new THREE.Vector3(cameraTarget.x, 11.8, 13.7 + cameraTarget.z);
    this.camera.position.lerp(cameraPosition, Math.min(1, delta * 2.2));
    this.camera.lookAt(cameraTarget);
    this.updateBattleHud();
  }

  private readonly animate = (): void => {
    this.animationFrame = requestAnimationFrame(this.animate);
    const delta = Math.min(this.clock.getDelta(), 0.05);
    if (!this.paused) this.elapsed += delta;
    if (!this.paused && !this.reducedMotion) this.arena.update(delta, this.elapsed);
    if (!this.paused) this.vfx.update(delta);
    if (this.screen === 'landing' || this.screen === 'select') {
      this.previewRig?.update(delta);
      if (this.previewRig) {
        const autoYaw = this.reducedMotion || this.previewDragging ? 0 : Math.sin(this.elapsed * 0.32) * 0.13;
        this.previewRig.root.rotation.y = this.previewYaw + autoYaw;
      }
    }
    if (this.screen === 'battle') this.updateSimulation(delta);
    if (this.elapsed > this.toastUntil) this.ui.querySelector('.toast')?.remove();
    if (!this.paused) this.targetReticle.rotation.y += delta * 0.65;
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  };

  private readonly resize = (): void => {
    const width = this.shell.clientWidth;
    const height = this.shell.clientHeight;
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.composer?.setSize(width, height);
  };
}
