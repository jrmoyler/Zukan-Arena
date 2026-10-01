import { AudioEngine, type SfxName } from './audio/AudioEngine';
import { BattleController } from './battle/BattleController';
import { InputManager, type InputAction } from './core/Input';
import { profile, recordMatch } from './core/Profile';
import { prefersReducedMotion, resolveQuality, settings, type Settings } from './core/Settings';
import { GAUNTLET } from './data/gauntlet';
import { ROSTER } from './data/roster';
import { disposeCutoutCache, preloadCutouts } from './render/FighterSprite';
import { disposeSharedTextures } from './render/textures';
import { MenuScene } from './render/MenuScene';
import { Stage } from './render/Stage';
import type { CombatMatchSummary } from './simulation/CombatSimulation';
import type { FighterDefinition } from './types';
import { el, escapeHtml, focusFirst, moveFocus } from './ui/dom';
import { ICONS } from './ui/icons';
import { buildHowToPlay, buildPauseMenu, buildSettingsPanel } from './ui/panels';
import type { AppApi, GameMode, MatchSetup, Screen, ToastAction } from './ui/Screen';
import { GauntletScreen, gauntletSetup } from './ui/screens/GauntletScreen';
import { MainMenuScreen } from './ui/screens/MainMenuScreen';
import { ResultsScreen } from './ui/screens/ResultsScreen';
import { SelectScreen } from './ui/screens/SelectScreen';
import { TitleScreen } from './ui/screens/TitleScreen';
import { VersusScreen } from './ui/screens/VersusScreen';
import { ZukanScreen } from './ui/screens/ZukanScreen';
import { canInstall, initPwa, promptInstall } from '../pwa/register';

/**
 * The game shell. Owns the renderer, audio and input for the whole session,
 * routes between screens, runs the frame loop and turns finished matches into
 * profile progress.
 */

interface ModalEntry {
  backdrop: HTMLElement;
  dismissible: boolean;
  onClose?: () => void;
  restoreFocus: Element | null;
}

const MENU_NAV: InputAction[] = ['up', 'down', 'left', 'right'];

export class App implements AppApi {
  readonly stage: Stage;
  readonly audio: AudioEngine;
  readonly input = new InputManager();
  readonly showcase: MenuScene;

  private readonly shell: HTMLElement;
  private readonly uiRoot: HTMLElement;
  private readonly toastStack: HTMLElement;
  private readonly fpsMeter: HTMLElement;
  private screen?: Screen;
  private readonly modals: ModalEntry[] = [];
  private battle?: BattleController;
  private battleSetup?: MatchSetup;
  private paused = false;
  private closePause?: () => void;
  private frame = 0;
  private lastTime = performance.now();
  private fpsAccumulator = 0;
  private fpsFrames = 0;
  private lastHover = 0;
  private installAvailable = false;

  constructor(host: HTMLElement) {
    this.shell = el('div', 'game-shell');
    const canvas = el('canvas', 'game-canvas');
    canvas.tabIndex = -1;
    this.uiRoot = el('div', 'ui-root');
    this.toastStack = el('div', 'toast-stack');
    this.fpsMeter = el('div', 'fps-meter');
    this.shell.append(canvas, this.uiRoot, this.toastStack, this.fpsMeter);
    host.append(this.shell);

    const prefs = settings.get();
    const reduced = prefersReducedMotion(prefs);
    this.stage = new Stage(canvas, resolveQuality(prefs), reduced);
    this.showcase = new MenuScene(this.stage, this.stage.tier, reduced);
    this.audio = new AudioEngine({ master: prefs.masterVolume, music: prefs.musicVolume, sfx: prefs.sfxVolume });
    this.input.attach(canvas);
    this.input.onFirstGesture = () => void this.audio.unlock();
    this.applySettings(prefs, true);
    settings.subscribe((next) => this.applySettings(next, false));

    window.addEventListener('resize', this.stage.resize);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('blur', this.onBlur);
    this.bindUiSounds();
    this.setupPwa();
  }

  /** Streams the title lineup first, reveals the game, then warms the rest of the roster. */
  async boot(onProgress: (fraction: number, label: string) => void): Promise<void> {
    const first = ['zukan-025', 'zukan-011', 'zukan-001', 'zukan-020', 'zukan-002', profile.get().lastFighterId];
    onProgress(0.1, 'Waking the Zukan');
    await preloadCutouts([...new Set(first)], (fraction) => onProgress(0.1 + fraction * 0.8, 'Waking the Zukan'));
    onProgress(1, 'Entering the arena');
    this.goTitle();
    this.frame = requestAnimationFrame(this.loop);
    const rest = ROSTER.map(({ id }) => id).filter((id) => !first.includes(id));
    window.setTimeout(() => void preloadCutouts(rest), 1500);
  }

  // ------------------------------------------------------------ navigation

  goTitle(): void {
    this.endBattle();
    this.show(new TitleScreen(this));
  }

  goMenu(): void {
    this.endBattle();
    this.show(new MainMenuScreen(this));
  }

  goSelect(mode: GameMode): void {
    this.endBattle();
    this.show(new SelectScreen(this, mode));
  }

  goGauntlet(player: FighterDefinition): void {
    this.endBattle();
    this.show(new GauntletScreen(this, player));
  }

  goZukan(): void {
    this.show(new ZukanScreen(this));
  }

  startMatch(setup: MatchSetup): void {
    const begin = () => {
      if (setup.mode === 'training') this.launchBattle(setup);
      else this.show(new VersusScreen(this, setup, () => this.launchBattle(setup)));
    };
    if (!profile.get().tutorialSeen) {
      profile.update({ tutorialSeen: true });
      this.openHowToPlay(begin);
    } else {
      begin();
    }
  }

  // ---------------------------------------------------------------- modals

  openModal(content: HTMLElement, options: { dismissible?: boolean; onClose?: () => void } = {}): () => void {
    const backdrop = el('div', 'modal-backdrop');
    backdrop.append(content);
    const entry: ModalEntry = { backdrop, dismissible: options.dismissible ?? true, onClose: options.onClose, restoreFocus: document.activeElement };
    backdrop.addEventListener('pointerdown', (event) => {
      if (event.target === backdrop && entry.dismissible) this.closeModal(entry);
    });
    this.uiRoot.append(backdrop);
    this.modals.push(entry);
    focusFirst(content);
    return () => this.closeModal(entry);
  }

  openSettings(onClose?: () => void): void {
    let close: () => void = () => undefined;
    const panel = buildSettingsPanel(() => close(), () => {
      close();
      this.toast('Progress erased. A fresh archive awaits.');
      this.goTitle();
    });
    close = this.openModal(panel, { onClose });
  }

  openHowToPlay(onClose?: () => void): void {
    let close: () => void = () => undefined;
    close = this.openModal(buildHowToPlay(() => close()), { onClose });
  }

  toast(message: string, action?: ToastAction): void {
    const node = el('div', 'toast', `<span>${escapeHtml(message)}</span>`);
    if (action) {
      const button = el('button', 'btn btn-primary btn-sm', escapeHtml(action.label));
      button.addEventListener('click', () => {
        action.run();
        node.remove();
      });
      node.append(button);
    }
    this.toastStack.append(node);
    window.setTimeout(() => node.classList.add('is-leaving'), action ? 9000 : 3200);
    window.setTimeout(() => node.remove(), action ? 9400 : 3600);
  }

  sfx(name: SfxName): void {
    this.audio.sfx(name);
  }

  canInstall(): boolean {
    return this.installAvailable || canInstall();
  }

  install(): void {
    void promptInstall().then((outcome) => {
      if (outcome === 'accepted') this.toast('Zukan Arena installed — launch it from your home screen.');
      else if (outcome === 'unavailable') this.toast('Use your browser menu → “Install app” or “Add to Home Screen”.');
    });
  }

  // ---------------------------------------------------------------- battle

  private launchBattle(setup: MatchSetup): void {
    this.closeAllModals();
    this.showcase.hide();
    this.show(undefined);
    this.battle?.dispose();
    this.audio.setMuffle(0);
    this.shell.classList.add('in-battle');
    blurActive();
    this.battleSetup = setup;
    this.paused = false;
    this.battle = new BattleController(
      { stage: this.stage, audio: this.audio, input: this.input, uiRoot: this.uiRoot },
      {
        config: {
          signal: [setup.player, ...setup.allies],
          rift: setup.enemies,
          difficulty: setup.difficulty,
          roundsToWin: setup.roundsToWin,
          roundSeconds: setup.roundSeconds,
          seed: (Date.now() ^ (setup.player.index * 2654435761)) >>> 0,
          training: setup.mode === 'training',
          modifiers: setup.modifiers,
        },
        title: setup.title,
        onPause: () => this.pauseBattle(),
        onEnd: (summary) => this.finishBattle(summary),
      },
    );
  }

  private pauseBattle(): void {
    if (!this.battle || this.paused || this.battle.isEnded) return;
    this.paused = true;
    this.battle.setPaused(true);
    this.audio.setMuffle(0.85);
    this.input.clear();
    const training = this.battleSetup?.mode === 'training';
    this.closePause = this.openModal(buildPauseMenu({
      training,
      resume: () => this.resumeBattle(),
      restart: () => {
        const setup = this.battleSetup;
        this.closeAllModals();
        if (setup) this.launchBattle(setup);
      },
      settings: () => this.openSettings(),
      howTo: () => this.openHowToPlay(),
      quit: () => {
        const mode = this.battleSetup?.mode ?? 'skirmish';
        this.closeAllModals();
        this.goSelect(mode);
      },
    }), { dismissible: true, onClose: () => this.resumeBattle() });
  }

  private resumeBattle(): void {
    if (!this.paused) return;
    this.paused = false;
    const close = this.closePause;
    this.closePause = undefined;
    close?.();
    this.closeAllModals();
    this.battle?.setPaused(false);
    this.audio.setMuffle(0);
    this.input.clear();
    // Space dashes in battle; never let it re-activate a focused menu button.
    blurActive();
  }

  private finishBattle(summary: CombatMatchSummary): void {
    const setup = this.battleSetup;
    if (!setup) return;
    const xpBefore = profile.get().xp;
    let bonus = 0;
    let gauntletCleared = false;
    let hasNextStage = false;
    if (setup.mode === 'gauntlet' && setup.stageIndex !== undefined && summary.result === 'win') {
      const stage = GAUNTLET[setup.stageIndex]!;
      bonus = stage.reward;
      const best = Math.max(profile.get().gauntletBest, stage.index);
      gauntletCleared = stage.index === GAUNTLET.length - 1;
      hasNextStage = !gauntletCleared;
      profile.update((current) => ({
        gauntletBest: gauntletCleared ? -1 : best,
        gauntletClears: current.gauntletClears + (gauntletCleared ? 1 : 0),
      }));
    }
    const rewards = recordMatch(summary, setup.player.id, setup.difficulty, bonus);
    this.endBattle();
    this.show(new ResultsScreen(this, {
      summary,
      setup,
      rewards,
      xpBefore,
      gauntletCleared,
      hasNextStage,
      onRematch: () => {
        if (setup.mode === 'gauntlet' && setup.stageIndex !== undefined) this.startMatch(gauntletSetup(setup.player, GAUNTLET[setup.stageIndex]!));
        else this.startMatch(setup);
      },
      onNext: () => {
        const next = GAUNTLET[(setup.stageIndex ?? 0) + 1];
        if (next) this.startMatch(gauntletSetup(setup.player, next));
      },
    }));
  }

  private endBattle(): void {
    if (!this.battle) return;
    this.battle.dispose();
    this.battle = undefined;
    this.paused = false;
    this.shell.classList.remove('in-battle');
    this.audio.setMuffle(0);
    this.stage.setGrade({ damage: 0, desaturate: 0 });
  }

  // ------------------------------------------------------------- internals

  private show(next: Screen | undefined): void {
    const previous = this.screen;
    if (previous) {
      previous.leave?.();
      previous.root.classList.add('is-leaving');
      window.setTimeout(() => previous.root.remove(), 300);
    }
    this.screen = next;
    this.input.clear();
    if (!next) return;
    this.uiRoot.append(next.root);
    next.enter?.();
    if (this.input.device !== 'touch') window.setTimeout(() => focusFirst(next.root), 60);
  }

  private closeModal(entry: ModalEntry): void {
    const index = this.modals.indexOf(entry);
    if (index < 0) return;
    this.modals.splice(index, 1);
    entry.backdrop.classList.add('is-leaving');
    entry.backdrop.remove();
    if (entry.restoreFocus instanceof HTMLElement) entry.restoreFocus.focus({ preventScroll: true });
    entry.onClose?.();
  }

  private closeAllModals(): void {
    while (this.modals.length) {
      const entry = this.modals.pop()!;
      entry.backdrop.remove();
    }
    this.closePause = undefined;
  }

  private readonly loop = (time: number): void => {
    this.frame = requestAnimationFrame(this.loop);
    const delta = Math.min(0.1, Math.max(0, (time - this.lastTime) / 1000));
    this.lastTime = time;

    this.input.poll(delta);
    if (this.battle && !this.paused) {
      this.battle.update(delta);
    } else {
      this.handleMenuInput();
      this.battle?.update(delta);
      this.screen?.update?.(delta);
    }
    this.showcase.update(delta);
    this.stage.updateArena(delta);
    this.stage.animateProps(delta);
    this.stage.render(delta);
    this.trackFps(delta);
  };

  private handleMenuInput(): void {
    const top = this.modals[this.modals.length - 1];
    const scope = top?.backdrop ?? this.screen?.root;
    if (!scope) return;
    for (const action of MENU_NAV) {
      if (this.input.consume(action)) {
        moveFocus(scope, action as 'up' | 'down' | 'left' | 'right');
        this.sfx('uiHover');
      }
    }
    if (this.input.consume('confirm') && this.input.device === 'gamepad') {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && scope.contains(focused)) focused.click();
    }
    if (this.input.consume('back') || this.input.consume('pause')) {
      if (top) {
        if (top.dismissible) {
          this.sfx('uiBack');
          this.closeModal(top);
        }
      } else if (this.screen?.back?.()) {
        this.sfx('uiBack');
      }
    }
  }

  private bindUiSounds(): void {
    this.uiRoot.addEventListener('pointerover', (event) => {
      const target = (event.target as HTMLElement).closest('button, .fighter-card, .zukan-card');
      if (!target || (event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) return;
      const now = performance.now();
      if (now - this.lastHover < 70) return;
      this.lastHover = now;
      this.audio.sfx('uiHover', { volume: 0.6 });
    });
    this.uiRoot.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('button');
      if (!target || target.closest('.hud')) return;
      if (target.classList.contains('btn-primary')) this.audio.sfx('uiConfirm');
      else if (target.dataset.action === 'back' || target.hasAttribute('data-close')) this.audio.sfx('uiBack');
      else this.audio.sfx('uiClick');
    });
  }

  private applySettings(next: Readonly<Settings>, initial: boolean): void {
    this.audio.setMix({ master: next.masterVolume, music: next.musicVolume, sfx: next.sfxVolume });
    const reduced = prefersReducedMotion(next);
    document.body.classList.toggle('reduced-motion', reduced);
    document.body.classList.toggle('color-safe', next.colorSafeTeams);
    document.documentElement.style.setProperty('--hud-scale', String(next.hudScale));
    this.fpsMeter.hidden = !next.showFps;
    this.stage.setReducedMotion(reduced);
    this.stage.shakeScale = next.screenShake;
    if (initial) return;
    const tier = resolveQuality(next);
    if (tier !== this.stage.tier) {
      this.stage.applyQuality(tier);
      this.showcase.setQuality(tier, reduced);
      this.screen?.enter?.();
    }
  }

  private trackFps(delta: number): void {
    if (this.fpsMeter.hidden) return;
    this.fpsAccumulator += delta;
    this.fpsFrames += 1;
    if (this.fpsAccumulator >= 0.5) {
      this.fpsMeter.textContent = `${Math.round(this.fpsFrames / this.fpsAccumulator)} fps · ${this.stage.tier}`;
      this.fpsAccumulator = 0;
      this.fpsFrames = 0;
    }
  }

  private readonly onVisibility = (): void => {
    const hidden = document.visibilityState === 'hidden';
    this.audio.setPaused(hidden);
    if (hidden) this.pauseBattle();
  };

  private readonly onBlur = (): void => {
    if (this.battle && this.battleSetup?.mode !== 'training') this.pauseBattle();
  };

  private setupPwa(): void {
    initPwa({
      onUpdateReady: (apply) => this.toast('A new version of Zukan Arena is ready.', { label: 'Update', run: apply }),
      onOfflineReady: () => this.toast('Zukan Arena is ready to play offline.'),
      onInstallAvailable: (available) => {
        this.installAvailable = available;
      },
    });
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.endBattle();
    this.showcase.dispose();
    this.input.detach();
    window.removeEventListener('resize', this.stage.resize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('blur', this.onBlur);
    this.stage.dispose();
    disposeCutoutCache();
    disposeSharedTextures();
    void this.audio.dispose();
    this.shell.remove();
  }
}

function blurActive(): void {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

export function renderCompatibilityNotice(host: HTMLElement): void {
  host.innerHTML = `
    <div class="game-shell compat">
      <section class="modal glass">
        <p class="eyebrow">Renderer check</p>
        <h2>WebGL 2 is required</h2>
        <p>Zukan Arena renders a real-time 3D arena. Enable hardware acceleration in your browser settings, or open the game in a current version of Chrome, Edge, Firefox or Safari.</p>
        <span class="compat-icon">${ICONS.gear}</span>
      </section>
    </div>`;
}
