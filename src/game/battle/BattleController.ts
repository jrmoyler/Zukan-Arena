import * as THREE from 'three';

import type { AudioEngine } from '../audio/AudioEngine';
import type { InputManager } from '../core/Input';
import { prefersReducedMotion, settings } from '../core/Settings';
import { ELEMENT_HEX } from '../data/kits';
import { teamColor } from '../data/palette';
import { BattleEffects } from '../render/BattleEffects';
import { ElementalVfxManager, type ElementalVfxEvent } from '../render/ElementalVfx';
import { FighterSprite } from '../render/FighterSprite';
import { FLOOR_Y, type Stage } from '../render/Stage';
import { ABILITIES } from '../data/abilities';
import {
  COUNTDOWN_SECONDS,
  CombatSimulation,
  type CombatEvent,
  type CombatMatchSummary,
  type MatchConfig,
} from '../simulation/CombatSimulation';
import { Hud } from '../ui/Hud';
import { WorldOverlay } from '../ui/WorldOverlay';

/**
 * Runs one match: steps the simulation on a fixed clock, mirrors state into
 * sprites / effects / audio, and layers game feel (hit-stop, slow motion,
 * camera trauma, cut-ins) on top. Owns every battle-scoped resource.
 */

const FIXED_STEP = 1 / 60;

export interface BattleContext {
  stage: Stage;
  audio: AudioEngine;
  input: InputManager;
  uiRoot: HTMLElement;
}

export interface BattleOptions {
  config: MatchConfig;
  title: string;
  onPause: () => void;
  onEnd: (summary: CombatMatchSummary) => void;
}

export class BattleController {
  readonly sim: CombatSimulation;
  private readonly context: BattleContext;
  private readonly options: BattleOptions;
  private readonly sprites = new Map<string, FighterSprite>();
  private readonly effects: BattleEffects;
  private readonly vfx: ElementalVfxManager;
  private readonly overlay: WorldOverlay;
  private readonly hud: Hud;
  private readonly world = new THREE.Group();
  private readonly scratch = new THREE.Vector3();
  private readonly scratch2 = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly lookAhead = new THREE.Vector3();
  private readonly pendingVfx: { at: number; event: ElementalVfxEvent }[] = [];
  private accumulator = 0;
  private hitStop = 0;
  private slowMotion = 0;
  private slowScale = 1;
  private clock = 0;
  private heartbeat = 0;
  private lastCountdown = -1;
  private ended = false;
  private endTimer = 0;
  private summary?: CombatMatchSummary;
  private paused = false;
  private readonly reducedMotion: boolean;
  private readonly colorSafe: boolean;

  constructor(context: BattleContext, options: BattleOptions) {
    this.context = context;
    this.options = options;
    this.sim = new CombatSimulation(options.config);
    const prefs = settings.get();
    this.reducedMotion = prefersReducedMotion(prefs);
    this.colorSafe = prefs.colorSafeTeams;
    const { stage } = context;
    stage.shakeScale = prefs.screenShake;
    this.world.name = 'battle-world';
    this.world.position.y = FLOOR_Y;
    stage.scene.add(this.world);

    this.effects = new BattleEffects(stage.tier);
    this.world.add(this.effects.group);
    this.vfx = new ElementalVfxManager(stage.scene, {
      quality: stage.tier === 'low' ? 'low' : 'high',
      reducedMotion: this.reducedMotion,
    });

    this.overlay = new WorldOverlay(context.uiRoot);
    this.overlay.enabledNumbers = prefs.damageNumbers;
    for (const fighter of this.sim.snapshot()) {
      const isPlayer = fighter.id === this.sim.playerId;
      const sprite = new FighterSprite(fighter.definition, {
        quality: stage.tier,
        team: fighter.team,
        isPlayer,
        scale: fighter.scale,
        colorSafe: this.colorSafe,
        reducedMotion: this.reducedMotion,
      });
      sprite.root.position.copy(fighter.position);
      this.world.add(sprite.root);
      this.sprites.set(fighter.id, sprite);
      this.overlay.addPlate(fighter.id, fighter.definition.name, fighter.definition.element, fighter.team, isPlayer, fighter.boss);
    }

    this.hud = new Hud(context.uiRoot, {
      sim: this.sim,
      input: context.input,
      training: Boolean(options.config.training),
      title: options.title,
      onPause: options.onPause,
    });
    context.input.onDeviceChange = (device) => this.hud.setDevice(device);
    context.input.clear();

    stage.setPreset('battle');
    stage.setPropsVisible(true);
    context.audio.playMusic('battle');
    context.audio.setIntensity(0.2);
    this.processEvents(this.sim.drainEvents());
  }

  get isEnded(): boolean {
    return this.ended;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.hud.setVisible(!paused);
    this.overlay.setVisible(!paused);
  }

  update(delta: number): void {
    const { stage, input } = this.context;
    if (!this.paused && input.consume('pause')) {
      this.options.onPause();
      return;
    }
    if (this.paused) {
      this.updateSprites(0);
      return;
    }

    this.clock += delta;
    let scaled = delta;
    if (this.hitStop > 0) {
      this.hitStop -= delta;
      scaled = 0;
    } else if (this.slowMotion > 0) {
      this.slowMotion -= delta;
      scaled = delta * this.slowScale;
    }

    this.readPlayerInput();
    this.accumulator += scaled;
    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < 5) {
      this.sim.update(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
      steps += 1;
      this.processEvents(this.sim.drainEvents());
    }
    if (steps === 5) this.accumulator = 0;

    this.flushPendingVfx();
    this.effects.syncBolts(this.sim.projectiles);
    this.effects.update(scaled, this.sim.elapsed);
    this.vfx.update(scaled);
    this.updateSprites(scaled);
    this.updateCamera();
    this.updateAtmosphere(delta);
    this.hud.update(delta);
    this.effects.setViewportHeight(stage.canvas.clientHeight);
    const project = (world: THREE.Vector3, out: THREE.Vector2) => stage.project(world, out);
    for (const fighter of this.sim.snapshot()) {
      const sprite = this.sprites.get(fighter.id);
      if (!sprite) continue;
      const statuses: string[] = [];
      if (fighter.stunnedFor > 0) statuses.push('Stun');
      if (fighter.rootedFor > 0) statuses.push('Root');
      if (fighter.slowedFor > 0) statuses.push('Slow');
      this.overlay.updatePlate(fighter.id, sprite.headPosition(this.scratch), project, {
        hp: fighter.hp,
        maxHp: fighter.maxHp,
        alive: fighter.alive,
        statuses,
        ultReady: fighter.ult >= fighter.kit.ultimate.charge,
      }, delta);
    }
    this.overlay.updateTexts(delta, project);

    if (this.ended) {
      this.endTimer -= delta;
      if (this.endTimer <= 0 && this.summary) {
        const summary = this.summary;
        this.summary = undefined;
        this.options.onEnd(summary);
      }
    }
  }

  dispose(): void {
    for (const sprite of this.sprites.values()) sprite.dispose();
    this.sprites.clear();
    this.effects.dispose();
    this.vfx.dispose();
    this.overlay.dispose();
    this.hud.dispose();
    this.world.removeFromParent();
    this.context.input.onDeviceChange = undefined;
    this.context.stage.setGrade({ damage: 0, desaturate: 0 });
    this.context.stage.setPropsVisible(false);
  }

  // ----------------------------------------------------------------- input

  private readPlayerInput(): void {
    const player = this.sim.player;
    const { input, stage } = this.context;
    if (!player) return;
    const right = stage.cameraRight(this.scratch2);
    const forward = new THREE.Vector3(-right.z, 0, right.x).negate();
    // Screen-relative movement: up on screen is away from the camera.
    const move = input.movement;
    this.sim.input.movement.set(right.x * move.x - forward.x * move.y, right.z * move.x - forward.z * move.y);

    if (input.device === 'keyboard' && input.pointerActive) {
      const hit = stage.groundFromNdc(input.pointer, this.aim);
      if (hit) this.sim.input.aim.copy(hit);
    } else {
      const stick = input.aimStick;
      if (input.aimStickStrength > 0.05) {
        const direction = new THREE.Vector3(right.x * stick.x - forward.x * stick.y, 0, right.z * stick.x - forward.z * stick.y).normalize();
        const reach = input.device === 'touch' ? 2 + input.aimStickStrength * (player.kit.skill.range - 2) : player.kit.basic.range * 0.75;
        this.sim.input.aim.copy(player.position).addScaledVector(direction, reach);
      } else if (settings.get().aimAssist) {
        const target = this.nearestEnemy(player.position, player.facing);
        if (target) this.sim.input.aim.copy(target);
        else this.sim.input.aim.copy(player.position).addScaledVector(player.facing, 4);
      }
    }
    this.sim.input.basicHeld = input.basicHeld;

    const tryAction = (action: 'skill' | 'ultimate' | 'dash') => {
      if (!input.consume(action)) return;
      if (this.sim.phase !== 'fight' || !player.alive) return;
      const ready = action === 'skill'
        ? player.cooldowns.skill <= 0 && player.energy >= player.kit.skill.energy
        : action === 'ultimate'
          ? player.ult >= player.kit.ultimate.charge
          : player.cooldowns.dash <= 0;
      if (!ready) {
        this.hud.denySlot(action);
        this.context.audio.sfx('uiError', { volume: 0.5 });
        return;
      }
      this.sim.queue(action);
    };
    tryAction('skill');
    tryAction('ultimate');
    tryAction('dash');
  }

  private nearestEnemy(from: THREE.Vector3, facing: THREE.Vector3): THREE.Vector3 | null {
    let best: THREE.Vector3 | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const fighter of this.sim.snapshot()) {
      if (!fighter.alive || fighter.team === 'signal') continue;
      const offset = fighter.position.clone().sub(from);
      const distance = offset.length();
      if (distance > 11) continue;
      const alignment = distance > 0 ? offset.normalize().dot(facing) : 1;
      const score = distance - alignment * 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = fighter.position;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- events

  private processEvents(events: CombatEvent[]): void {
    const { audio, stage } = this.context;
    for (const event of events) {
      switch (event.type) {
        case 'phase':
          this.onPhase(event.phase, event.round);
          break;
        case 'shot': {
          this.effects.spawnBolt(event.projectileId, event.element);
          const owner = this.sprites.get(event.ownerId);
          if (event.ownerId === this.sim.playerId) audio.shot(event.element, this.pan(event.origin));
          else if (Math.random() < 0.4) audio.shot(event.element, this.pan(event.origin));
          if (owner && event.ownerId === this.sim.playerId) this.hud.pulseSlot('basic');
          break;
        }
        case 'projectileEnd':
          this.effects.endBolt(event.projectileId, event.position, event.hit);
          break;
        case 'cast':
          this.onCast(event);
          break;
        case 'impact': {
          this.effects.resolveTelegraph(event.impactId);
          const ultimate = event.kind === 'ultimate';
          audio.impact(event.element, ultimate ? 2 : 1, this.pan(event.target));
          const nearPlayer = this.sim.player ? this.sim.player.position.distanceTo(event.target) < event.radius + 3 : true;
          if (ultimate) {
            stage.addTrauma(0.55);
            stage.flashAberration(1);
          } else if (nearPlayer) {
            stage.addTrauma(0.18);
          }
          this.effects.burst(event.target.clone().setY(0.3), { count: ultimate ? 46 : 16, color: ELEMENT_HEX[event.element], speed: ultimate ? 7 : 4, life: 0.8, size: 0.45, gravity: 3, upward: 2, spread: event.radius * 0.6 });
          break;
        }
        case 'damage':
          this.onDamage(event);
          break;
        case 'heal': {
          const sprite = this.sprites.get(event.targetId);
          if (sprite) {
            sprite.trigger('heal');
            this.effects.heal(sprite.chestPosition(this.scratch));
            this.overlay.pop(sprite.chestPosition(this.scratch), `+${event.amount}`, 'heal');
          }
          break;
        }
        case 'status': {
          const sprite = this.sprites.get(event.targetId);
          if (sprite && event.status !== 'slow') {
            const label = event.status === 'knockback' ? 'Knockback' : event.status === 'root' ? 'Rooted' : 'Stunned';
            this.overlay.pop(sprite.headPosition(this.scratch), label, 'info');
          }
          break;
        }
        case 'dash': {
          const sprite = this.sprites.get(event.fighterId);
          sprite?.trigger('dash');
          this.effects.dust(event.from.clone().setY(0.15));
          if (event.fighterId === this.sim.playerId) {
            audio.sfx('dash');
            this.hud.pulseSlot('dash');
          } else {
            audio.sfx('dash', { volume: 0.35, pan: this.pan(event.from) });
          }
          break;
        }
        case 'ultReady':
          if (event.fighterId === this.sim.playerId) {
            audio.sfx('ultReady');
            this.hud.toast(this.context.input.device === 'touch' ? 'Ultimate ready — hold ★ and drag to aim' : 'Ultimate ready — press E');
          }
          break;
        case 'knockout':
          this.onKnockout(event.targetId, event.sourceId);
          break;
        case 'pickupSpawn':
          this.effects.setBloom(true, event.position);
          this.hud.toast('A Resonance Bloom has surfaced at the centre');
          audio.sfx('discover', { volume: 0.6 });
          break;
        case 'pickup': {
          this.effects.setBloom(false);
          const fighter = this.sim.fighters.get(event.fighterId);
          if (fighter) this.hud.toast(`${fighter.team === 'signal' ? '✦' : '⚠'} ${fighter.definition.name} claimed the Bloom`);
          audio.sfx('reward', { volume: 0.6 });
          break;
        }
        case 'roundEnd':
          this.onRoundEnd(event.winner, event.round);
          break;
        case 'matchEnd':
          this.onMatchEnd(event.summary);
          break;
      }
    }
  }

  private onPhase(phase: string, round: number): void {
    const { audio } = this.context;
    if (phase === 'countdown') {
      this.lastCountdown = -1;
      this.effects.clear();
      this.vfx.clear();
      this.pendingVfx.length = 0;
      for (const fighter of this.sim.snapshot()) {
        const sprite = this.sprites.get(fighter.id);
        if (!sprite) continue;
        sprite.root.position.copy(fighter.position);
        sprite.trigger('spawn');
      }
      const final = this.sim.score.signal === this.sim.config.roundsToWin - 1 && this.sim.score.rift === this.sim.config.roundsToWin - 1;
      if (!this.sim.config.training) {
        this.hud.setRoundLabel(final ? 'Final round' : `Round ${round}`);
        this.hud.announce(final ? 'Final Round' : `Round ${round}`, this.options.title, 'gold', 1.2);
      } else {
        this.hud.announce('Training Grounds', 'Practise freely · Esc to leave', 'gold', 1.6);
      }
      audio.stinger('roundStart');
    } else if (phase === 'fight') {
      this.hud.announce('Fight!', '', 'fight', 0.75);
      audio.sfx('countdownGo');
      this.context.stage.zoomPunch(0.04);
    }
  }

  private onCast(event: Extract<CombatEvent, { type: 'cast' }>): void {
    const { audio, stage } = this.context;
    const ultimate = event.kind === 'ultimate';
    const caster = this.sim.fighters.get(event.casterId);
    const sprite = this.sprites.get(event.casterId);
    sprite?.trigger('cast');
    const hostile = event.team === 'rift';
    const color = hostile ? teamColor('rift', this.colorSafe) : ELEMENT_HEX[event.element];
    this.effects.showTelegraph(event.impactId, event.target, event.radius, color, event.delay, ultimate, this.sim.elapsed);

    const origin = sprite ? sprite.chestPosition(new THREE.Vector3()) : event.origin.clone();
    const vfxEvent: ElementalVfxEvent = { element: event.element, position: origin, target: event.target.clone(), team: event.team, intensity: ultimate ? 1.8 : 1 };
    const lead = Math.max(0, event.delay - ABILITIES[event.element].impactDelay);
    if (lead > 0.01) this.pendingVfx.push({ at: this.sim.elapsed + lead, event: vfxEvent });
    else this.vfx.emit(vfxEvent);

    if (ultimate && caster) {
      audio.ultimate(event.element);
      this.hud.cutIn(caster.definition, caster.kit.ultimate.label, caster.team);
      stage.zoomPunch(0.08);
      if (!this.reducedMotion) {
        this.slowMotion = 0.45;
        this.slowScale = 0.35;
      }
    } else {
      audio.cast(event.element, this.pan(event.origin));
    }
    if (event.casterId === this.sim.playerId) this.hud.pulseSlot(ultimate ? 'ultimate' : 'skill');
  }

  private flushPendingVfx(): void {
    for (let index = this.pendingVfx.length - 1; index >= 0; index -= 1) {
      const pending = this.pendingVfx[index]!;
      if (pending.at > this.sim.elapsed) continue;
      this.vfx.emit(pending.event);
      this.pendingVfx.splice(index, 1);
    }
  }

  private onDamage(event: Extract<CombatEvent, { type: 'damage' }>): void {
    const { audio, stage } = this.context;
    const sprite = this.sprites.get(event.targetId);
    const target = this.sim.fighters.get(event.targetId);
    const source = this.sim.fighters.get(event.sourceId);
    if (!sprite || !target || !source) return;
    const heavy = event.kind !== 'basic';
    const screenRight = stage.cameraRight(this.scratch2);
    const direction = Math.sign(target.position.clone().sub(source.position).dot(screenRight)) || 1;
    sprite.trigger(heavy ? 'heavyHit' : 'hit', direction);
    const chest = sprite.chestPosition(this.scratch);
    this.effects.hit(chest, source.definition.element, heavy);

    const playerHit = event.targetId === this.sim.playerId;
    const playerSource = event.sourceId === this.sim.playerId;
    const kind = playerHit ? 'player-hit' : event.critical || event.kind === 'ultimate' ? 'crit' : 'damage';
    this.overlay.pop(chest, String(event.amount), kind, event.effectiveness);

    if (playerSource) {
      this.hud.recordPlayerDamage(event.amount);
      audio.sfx(event.critical ? 'crit' : heavy ? 'hitHeavy' : 'hitLight', { volume: heavy ? 1 : 0.55, pan: this.pan(target.position) });
      if (heavy && !this.reducedMotion) this.hitStop = Math.max(this.hitStop, event.kind === 'ultimate' ? 0.09 : 0.045);
    }
    if (playerHit) {
      audio.sfx(heavy ? 'hitHeavy' : 'hitLight', { volume: 0.8 });
      stage.addTrauma(heavy ? 0.32 : 0.12);
      stage.flashAberration(heavy ? 0.7 : 0.25);
      this.hud.flashHurt();
    }
  }

  private onKnockout(targetId: string, sourceId: string): void {
    const { audio, stage } = this.context;
    const target = this.sim.fighters.get(targetId);
    const source = this.sim.fighters.get(sourceId);
    const sprite = this.sprites.get(targetId);
    if (!target || !source) return;
    const screenRight = stage.cameraRight(this.scratch2);
    sprite?.trigger('ko', Math.sign(target.position.clone().sub(source.position).dot(screenRight)) || 1);
    if (sprite) this.effects.knockout(sprite.chestPosition(this.scratch), target.definition.element);
    audio.sfx('ko', { pan: this.pan(target.position) });
    stage.addTrauma(0.42);
    this.hud.killfeed(source.definition, source.team, target.definition, target.team);
    const teamLeft = this.sim.team(target.team).filter(({ alive }) => alive).length;
    if (!this.reducedMotion && (teamLeft === 0 || targetId === this.sim.playerId || sourceId === this.sim.playerId)) {
      this.slowMotion = teamLeft === 0 ? 0.9 : 0.4;
      this.slowScale = 0.3;
    }
    if (targetId === this.sim.playerId && teamLeft > 0) this.hud.toast('You are down — your allies fight on');
  }

  private onRoundEnd(winner: string, round: number): void {
    const { audio } = this.context;
    if (this.sim.config.training) return;
    const won = winner === 'signal';
    const draw = winner === 'draw';
    const timeUp = this.sim.roundTimeLeft <= 0;
    this.hud.announce(draw ? 'Draw' : won ? 'Round Won' : 'Round Lost', timeUp ? 'Time — decided on vitality' : `Round ${round}`, draw ? 'neutral' : won ? 'win' : 'lose', 2.2);
    audio.sfx(won ? 'roundWin' : 'roundLose');
    for (const fighter of this.sim.snapshot()) {
      if (fighter.alive && fighter.team === winner) this.sprites.get(fighter.id)?.trigger('victory');
    }
  }

  private onMatchEnd(summary: CombatMatchSummary): void {
    const { audio, stage } = this.context;
    const won = summary.result === 'win';
    this.ended = true;
    this.endTimer = 2.6;
    this.summary = summary;
    this.hud.announce(won ? 'Victory' : 'Defeat', won ? 'The Rift is sealed' : 'The Signal fades', won ? 'win' : 'lose', 2.4);
    audio.stinger(won ? 'victory' : 'defeat');
    audio.sfx(won ? 'victory' : 'defeat');
    stage.setGrade({ desaturate: won ? 0 : 0.45 });
  }

  // ----------------------------------------------------------------- frame

  private updateSprites(delta: number): void {
    const { stage } = this.context;
    const right = stage.cameraRight(this.scratch2);
    for (const fighter of this.sim.snapshot()) {
      const sprite = this.sprites.get(fighter.id);
      if (!sprite) continue;
      sprite.root.position.x = THREE.MathUtils.damp(sprite.root.position.x, fighter.position.x, 22, delta);
      sprite.root.position.z = THREE.MathUtils.damp(sprite.root.position.z, fighter.position.z, 22, delta);
      if (fighter.alive) {
        const speed = fighter.velocity.length() / Math.max(1, fighter.definition.speed);
        const screenX = fighter.velocity.dot(right) / Math.max(1, fighter.definition.speed);
        sprite.setMotion(fighter.dashTime > 0 ? 0 : speed, screenX);
        sprite.setFacing(fighter.facing.dot(right));
        sprite.setStatus({
          stunned: fighter.stunnedFor > 0,
          rooted: fighter.rootedFor > 0,
          slowed: fighter.slowedFor > 0,
          invulnerable: fighter.invulnerableFor > 0 && fighter.dashTime <= 0,
        });
        if (fighter.id === this.sim.playerId) sprite.setAim(Math.atan2(fighter.facing.z, fighter.facing.x) - stage.cameraYaw);
      } else {
        sprite.setMotion(0, 0);
      }
      sprite.update(delta, stage.cameraYaw, stage.cameraPitch);
    }
  }

  private updateCamera(): void {
    const player = this.sim.player;
    const { stage } = this.context;
    if (player?.alive) {
      this.lookAhead.copy(this.sim.input.aim).sub(player.position).multiplyScalar(0.12);
      stage.follow(player.position, this.lookAhead);
    } else {
      const living = this.sim.snapshot().filter(({ alive, team }) => alive && team === 'signal');
      const focus = living[0]?.position ?? new THREE.Vector3();
      stage.follow(focus, this.lookAhead.set(0, 0, 0));
    }
  }

  private updateAtmosphere(delta: number): void {
    const { audio, stage } = this.context;
    const player = this.sim.player;
    const signal = this.sim.team('signal');
    const rift = this.sim.team('rift');
    const health = (team: typeof signal) => team.reduce((sum, fighter) => sum + fighter.hp / fighter.maxHp, 0) / team.length;
    const tension = 1 - Math.min(health(signal), health(rift));
    const clutch = this.sim.phase === 'fight' && this.sim.roundTimeLeft < 15 ? 0.3 : 0;
    audio.setIntensity(this.sim.phase === 'fight' ? Math.min(1, 0.35 + tension * 0.45 + clutch) : 0.2);

    if (player?.alive && player.hp / player.maxHp < 0.3 && this.sim.phase === 'fight') {
      stage.setGrade({ damage: 0.35 + Math.sin(this.clock * 6) * 0.1 });
      this.heartbeat -= delta;
      if (this.heartbeat <= 0) {
        this.heartbeat = 0.85;
        audio.sfx('lowHealth');
      }
    } else {
      stage.setGrade({ damage: 0, desaturate: player && !player.alive && !this.ended ? 0.55 : this.ended ? undefined : 0 });
    }

    if (this.sim.phase === 'countdown' && !this.sim.config.training) {
      // "Round N" holds for 1.2s, then 3-2-1 lands on the remaining beats.
      const beat = (COUNTDOWN_SECONDS - 1.2) / 3;
      const remaining = 3 - Math.floor((this.sim.phaseTime - 1.2) / beat);
      if (this.sim.phaseTime >= 1.2 && remaining !== this.lastCountdown && remaining > 0 && remaining <= 3) {
        this.lastCountdown = remaining;
        this.hud.announce(String(remaining), '', 'neutral', 0.6);
        audio.sfx('countdownTick');
      }
    }
  }

  private pan(position: THREE.Vector3): number {
    return THREE.MathUtils.clamp(position.x / 9, -1, 1);
  }
}
