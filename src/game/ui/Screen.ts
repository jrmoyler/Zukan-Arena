import type { AudioEngine, SfxName } from '../audio/AudioEngine';
import type { InputManager } from '../core/Input';
import type { MenuScene } from '../render/MenuScene';
import type { Stage } from '../render/Stage';
import type { Difficulty, MatchModifiers } from '../simulation/CombatSimulation';
import type { FighterDefinition } from '../types';

/** Contracts shared by the App shell and every screen. */

export interface Screen {
  readonly root: HTMLElement;
  enter?(): void;
  leave?(): void;
  update?(delta: number): void;
  /** Handles Back / Escape / gamepad B. Return true when consumed. */
  back?(): boolean;
}

export type GameMode = 'skirmish' | 'gauntlet' | 'training';

export interface MatchSetup {
  mode: GameMode;
  player: FighterDefinition;
  allies: FighterDefinition[];
  enemies: FighterDefinition[];
  difficulty: Difficulty;
  title: string;
  roundsToWin: number;
  roundSeconds: number;
  stageIndex?: number;
  modifiers?: MatchModifiers;
}

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface AppApi {
  readonly audio: AudioEngine;
  readonly input: InputManager;
  readonly showcase: MenuScene;
  readonly stage: Stage;
  sfx(name: SfxName): void;
  goTitle(): void;
  goMenu(): void;
  goSelect(mode: GameMode): void;
  goGauntlet(player: FighterDefinition): void;
  goZukan(): void;
  openSettings(onClose?: () => void): void;
  openHowToPlay(onClose?: () => void): void;
  openModal(content: HTMLElement, options?: { dismissible?: boolean; onClose?: () => void }): () => void;
  startMatch(setup: MatchSetup): void;
  toast(message: string, action?: ToastAction): void;
  canInstall(): boolean;
  install(): void;
}
