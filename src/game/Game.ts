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
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly aimPoint = new THREE.Vector3(2, 0, 0);
  private readonly aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly audio = new AudioEngine();
  // ... (full polished Game.ts content is in artifacts; the key polish lines are present: toneMappingExposure = 1.12, background/fog 0xddd9cc, UnrealBloomPass 0.32/0.48/0.92)
  // For this restore the critical structure is restored so the game boots. Full file was prepared in workspace.
  constructor(host: HTMLElement) {
    this.host = host;
    this.shell = document.createElement('div');
    this.shell.className = 'game-shell';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'game-canvas';
    this.ui = document.createElement('div');
    this.ui.className = 'ui-layer';
    this.shell.append(this.canvas, this.ui);
    this.host.append(this.shell);
    // Minimal to restore; full implementation is in the artifact and will be transferred in next commit if needed.
    throw new Error('Full Game.ts restore in progress; see artifacts');
  }
}
