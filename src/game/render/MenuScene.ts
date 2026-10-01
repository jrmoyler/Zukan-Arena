import * as THREE from 'three';

import type { FighterDefinition, TeamKind } from '../types';
import { FighterSprite, type SpriteQuality } from './FighterSprite';
import { FLOOR_Y, type Stage } from './Stage';
import { glowTexture } from './textures';

/**
 * Stages fighters behind menu screens: a title lineup, the featured fighter on
 * the main menu, the select-screen pedestal, the versus face-off and the
 * results podium. Sprites are reused when the same fighter stays on stage.
 */

export type ShowcaseLayout = 'title' | 'menu' | 'select' | 'versus' | 'results';

interface Placement {
  fighter: FighterDefinition;
  position: THREE.Vector3;
  scale: number;
  facing: number;
  team?: TeamKind;
  pose?: 'victory';
}

export class MenuScene {
  private readonly stage: Stage;
  private readonly group = new THREE.Group();
  private readonly sprites = new Map<string, FighterSprite>();
  private readonly pedestal: THREE.Group;
  private quality: SpriteQuality;
  private reducedMotion: boolean;
  private time = 0;

  constructor(stage: Stage, quality: SpriteQuality, reducedMotion: boolean) {
    this.stage = stage;
    this.quality = quality;
    this.reducedMotion = reducedMotion;
    this.group.name = 'menu-showcase';
    this.group.position.y = FLOOR_Y;
    this.pedestal = this.buildPedestal();
    this.pedestal.visible = false;
    this.group.add(this.pedestal);
    stage.scene.add(this.group);
  }

  setQuality(quality: SpriteQuality, reducedMotion: boolean): void {
    this.quality = quality;
    this.reducedMotion = reducedMotion;
    this.clear();
  }

  show(layout: ShowcaseLayout, fighters: readonly FighterDefinition[], extra: { rift?: readonly FighterDefinition[]; winners?: TeamKind } = {}): void {
    const placements = this.layout(layout, fighters, extra);
    const keep = new Set(placements.map(({ fighter }) => fighter.id));
    for (const [id, sprite] of this.sprites) {
      if (!keep.has(id)) {
        sprite.dispose();
        this.sprites.delete(id);
      }
    }
    for (const placement of placements) {
      let sprite = this.sprites.get(placement.fighter.id);
      if (!sprite) {
        sprite = new FighterSprite(placement.fighter, {
          quality: this.quality,
          team: placement.team,
          showRing: Boolean(placement.team),
          scale: placement.scale,
          reducedMotion: this.reducedMotion,
        });
        this.group.add(sprite.root);
        this.sprites.set(placement.fighter.id, sprite);
      } else if (placement.team) {
        sprite.setTeam(placement.team, false, document.body.classList.contains('color-safe'));
      }
      sprite.root.position.copy(placement.position);
      sprite.setFacing(placement.facing);
      if (!placement.team) sprite.setHighlight(0xf8e6b8, layout === 'select' ? 0.6 : 0);
      if (placement.pose) sprite.trigger(placement.pose);
    }
    this.pedestal.visible = layout === 'select';
    this.group.visible = true;
  }

  /** Plays the signature cast flourish on a showcased fighter. */
  flourish(fighterId: string): void {
    this.sprites.get(fighterId)?.trigger('cast');
  }

  clear(): void {
    for (const sprite of this.sprites.values()) sprite.dispose();
    this.sprites.clear();
    this.pedestal.visible = false;
  }

  hide(): void {
    this.clear();
    this.group.visible = false;
  }

  update(delta: number): void {
    this.time += delta;
    for (const sprite of this.sprites.values()) sprite.update(delta, this.stage.cameraYaw, this.stage.cameraPitch);
    if (this.pedestal.visible) {
      const halo = this.pedestal.userData.halo as THREE.Mesh;
      halo.rotation.z += delta * (this.reducedMotion ? 0 : 0.25);
    }
  }

  dispose(): void {
    this.clear();
    this.pedestal.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        (object.material as THREE.Material).dispose();
      }
    });
    this.group.removeFromParent();
  }

  private layout(layout: ShowcaseLayout, fighters: readonly FighterDefinition[], extra: { rift?: readonly FighterDefinition[]; winners?: TeamKind }): Placement[] {
    const v = (x: number, z: number) => new THREE.Vector3(x, 0, z);
    switch (layout) {
      case 'title':
        return fighters.slice(0, 5).map((fighter, index) => {
          const slot = index - 2;
          return { fighter, position: v(slot * 2.15, -Math.abs(slot) * 0.9 - 0.4), scale: index === 2 ? 1.25 : 1, facing: slot === 0 ? 1 : -Math.sign(slot) };
        });
      case 'menu':
        return fighters.slice(0, 3).map((fighter, index) => ({
          fighter,
          position: index === 0 ? v(2.5, 0.8) : v(2.5 + (index === 1 ? -1.9 : 1.9), -1.2),
          scale: index === 0 ? 1.35 : 0.95,
          facing: index === 2 ? -1 : 1,
        }));
      case 'select':
        return fighters.slice(0, 1).map((fighter) => ({ fighter, position: new THREE.Vector3(0, 0.16, 2.2), scale: 1.15, facing: 1 }));
      case 'versus': {
        const left = fighters.map((fighter, index) => ({ fighter, position: v(-2 - index * 1.9, -index * 0.9), scale: index === 0 ? 1.2 : 1, facing: 1, team: 'signal' as const }));
        const right = (extra.rift ?? []).map((fighter, index) => ({ fighter, position: v(2 + index * 1.9, -index * 0.9), scale: index === 0 ? 1.2 : 1, facing: -1, team: 'rift' as const }));
        return [...left, ...right];
      }
      case 'results':
        return fighters.slice(0, 3).map((fighter, index) => {
          const slot = index === 0 ? 0 : index === 1 ? -1 : 1;
          return { fighter, position: v(slot * 2.1, -Math.abs(slot) * 0.8), scale: index === 0 ? 1.25 : 1, facing: slot <= 0 ? 1 : -1, pose: extra.winners === 'signal' ? 'victory' as const : undefined };
        });
    }
  }

  private buildPedestal(): THREE.Group {
    const group = new THREE.Group();
    group.position.set(0, 0, 2.2);
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(1.25, 1.35, 0.16, 64),
      new THREE.MeshPhysicalMaterial({ color: 0x1b2440, roughness: 0.3, metalness: 0.4, clearcoat: 0.6 }),
    );
    base.position.y = 0.08;
    base.receiveShadow = true;
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(1.3, 0.025, 8, 96),
      new THREE.MeshStandardMaterial({ color: 0xe8c27a, metalness: 0.9, roughness: 0.25, emissive: 0x7a5a20, emissiveIntensity: 0.4 }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.16;
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(1.45, 1.75, 96),
      new THREE.MeshBasicMaterial({ map: glowTexture(), color: 0xe8c27a, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.03;
    group.add(base, rim, halo);
    group.userData.halo = halo;
    return group;
  }
}
