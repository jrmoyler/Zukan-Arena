import * as THREE from 'three';

import { ELEMENT_HEX } from '../data/kits';
import type { ElementKind } from '../types';
import { glowTexture, sparkleTexture, streakTexture } from './textures';

/**
 * Lightweight, pooled battle visuals that sit beside the signature-ability VFX:
 * projectile bolts, ground telegraphs, a CPU particle field and the centre
 * Resonance Bloom. Everything is allocated up front per quality tier.
 */

// ------------------------------------------------------------ particles

export interface BurstOptions {
  count: number;
  color: THREE.ColorRepresentation;
  speed?: number;
  spread?: number;
  life?: number;
  size?: number;
  gravity?: number;
  upward?: number;
  drag?: number;
  sparkle?: boolean;
}

const PARTICLE_VERTEX = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  uniform float uScale;
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(0.1, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const PARTICLE_FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec4 tex = texture2D(uMap, gl_PointCoord);
    gl_FragColor = vec4(vColor * 1.6, tex.a * vAlpha);
    if (gl_FragColor.a < 0.01) discard;
  }
`;

class ParticleField {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly capacity: number;
  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly baseSizes: Float32Array;
  private readonly alphas: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly gravity: Float32Array;
  private readonly drag: Float32Array;
  private cursor = 0;
  private readonly color = new THREE.Color();

  constructor(capacity: number, texture: THREE.Texture) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.baseSizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity).fill(1);
    this.gravity = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60);
    const material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: texture }, uScale: { value: 300 } },
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.renderOrder = 7;
    this.points.frustumCulled = false;
  }

  setViewportHeight(pixels: number): void {
    this.points.material.uniforms.uScale!.value = pixels * 0.9;
  }

  burst(origin: THREE.Vector3, options: BurstOptions): void {
    this.color.set(options.color);
    const speed = options.speed ?? 3;
    const spread = options.spread ?? 0.2;
    for (let n = 0; n < options.count; n += 1) {
      const index = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);
      const magnitude = speed * (0.35 + Math.random() * 0.65);
      const i3 = index * 3;
      this.positions[i3] = origin.x + (Math.random() - 0.5) * spread;
      this.positions[i3 + 1] = origin.y + (Math.random() - 0.5) * spread;
      this.positions[i3 + 2] = origin.z + (Math.random() - 0.5) * spread;
      this.velocities[i3] = Math.sin(phi) * Math.cos(theta) * magnitude;
      this.velocities[i3 + 1] = Math.abs(Math.cos(phi)) * magnitude * 0.6 + (options.upward ?? 1.2);
      this.velocities[i3 + 2] = Math.sin(phi) * Math.sin(theta) * magnitude;
      const tint = 0.85 + Math.random() * 0.3;
      this.colors[i3] = this.color.r * tint;
      this.colors[i3 + 1] = this.color.g * tint;
      this.colors[i3 + 2] = this.color.b * tint;
      const life = (options.life ?? 0.7) * (0.6 + Math.random() * 0.6);
      this.life[index] = life;
      this.maxLife[index] = life;
      this.baseSizes[index] = (options.size ?? 0.35) * (0.6 + Math.random() * 0.8);
      this.gravity[index] = options.gravity ?? 4;
      this.drag[index] = options.drag ?? 1.8;
    }
  }

  update(delta: number): void {
    for (let index = 0; index < this.capacity; index += 1) {
      if (this.life[index]! <= 0) {
        this.alphas[index] = 0;
        continue;
      }
      const life = (this.life[index] = this.life[index]! - delta);
      const i3 = index * 3;
      const damping = Math.max(0, 1 - this.drag[index]! * delta);
      this.velocities[i3] = this.velocities[i3]! * damping;
      this.velocities[i3 + 1] = this.velocities[i3 + 1]! * damping - this.gravity[index]! * delta;
      this.velocities[i3 + 2] = this.velocities[i3 + 2]! * damping;
      this.positions[i3] = this.positions[i3]! + this.velocities[i3]! * delta;
      this.positions[i3 + 1] = Math.max(0.03, this.positions[i3 + 1]! + this.velocities[i3 + 1]! * delta);
      this.positions[i3 + 2] = this.positions[i3 + 2]! + this.velocities[i3 + 2]! * delta;
      const t = Math.max(0, life / this.maxLife[index]!);
      this.alphas[index] = Math.min(1, t * 2.2);
      this.sizes[index] = this.baseSizes[index]! * (0.5 + t * 0.7);
    }
    const geometry = this.points.geometry;
    geometry.getAttribute('position').needsUpdate = true;
    geometry.getAttribute('aColor').needsUpdate = true;
    geometry.getAttribute('aSize').needsUpdate = true;
    geometry.getAttribute('aAlpha').needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.alphas.fill(0);
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}

// ----------------------------------------------------------- telegraphs

const TELEGRAPH_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uProgress;
  uniform float uTime;
  uniform float uUltimate;
  uniform float uFlash;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float angle = atan(p.y, p.x);
    float rim = smoothstep(0.9, 0.95, r) * (1.0 - smoothstep(0.98, 1.0, r));
    float fillEdge = uProgress;
    float fill = (1.0 - smoothstep(fillEdge - 0.02, fillEdge, r)) * 0.28;
    float front = exp(-pow((r - fillEdge) * 28.0, 2.0)) * 0.85;
    float stripes = step(0.5, fract((p.x + p.y) * 6.0 - uTime * 1.5)) * 0.08 * (1.0 - r);
    float runes = 0.0;
    if (uUltimate > 0.5) {
      float band = smoothstep(0.7, 0.72, r) * (1.0 - smoothstep(0.78, 0.8, r));
      runes = band * step(0.45, fract(angle * 4.0 / 3.14159 + uTime * 0.6)) * 0.9;
      rim *= 1.4;
    }
    float alpha = (rim + fill + front + stripes + runes) * uOpacity + uFlash * (1.0 - r) * 1.2;
    gl_FragColor = vec4(uColor * (1.2 + uFlash * 2.0), clamp(alpha, 0.0, 1.0));
  }
`;

const DECAL_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

interface Telegraph {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  id: number;
  start: number;
  duration: number;
  flash: number;
  active: boolean;
}

// ----------------------------------------------------------- projectiles

interface Bolt {
  group: THREE.Group;
  core: THREE.Sprite;
  streak: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  glow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  id: number;
  active: boolean;
  element: ElementKind;
  trailTimer: number;
}

export interface ProjectileView {
  readonly id: number;
  readonly element: ElementKind;
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
}

const BOLT_HEIGHT = 0.95;

export class BattleEffects {
  readonly group = new THREE.Group();
  private readonly particles: ParticleField;
  private readonly telegraphs: Telegraph[] = [];
  private readonly bolts: Bolt[] = [];
  private readonly planeGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly bloom: THREE.Group;
  private readonly bloomCrystal: THREE.Mesh<THREE.OctahedronGeometry, THREE.MeshPhysicalMaterial>;
  private readonly bloomRing: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private bloomVisible = 0;
  private bloomTarget = 0;
  private time = 0;
  private readonly sparkles: ParticleField;

  constructor(quality: 'high' | 'medium' | 'low') {
    this.group.name = 'battle-effects';
    const capacity = quality === 'high' ? 1600 : quality === 'medium' ? 1000 : 500;
    this.particles = new ParticleField(capacity, glowTexture());
    this.sparkles = new ParticleField(Math.round(capacity / 4), sparkleTexture());
    this.group.add(this.particles.points, this.sparkles.points);

    this.bloom = new THREE.Group();
    this.bloomCrystal = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.34, 0),
      new THREE.MeshPhysicalMaterial({
        color: 0xfff1c8,
        emissive: 0xffc46b,
        emissiveIntensity: 1.6,
        roughness: 0.1,
        metalness: 0.2,
        transmission: 0.3,
        clearcoat: 1,
      }),
    );
    this.bloomCrystal.scale.set(1, 1.5, 1);
    this.bloomRing = new THREE.Mesh(
      this.planeGeometry,
      new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(0xffd27a) },
          uProgress: { value: 1 },
          uTime: { value: 0 },
          uUltimate: { value: 1 },
          uFlash: { value: 0 },
          uOpacity: { value: 0.9 },
        },
        vertexShader: DECAL_VERTEX,
        fragmentShader: TELEGRAPH_FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.bloomRing.rotation.x = -Math.PI / 2;
    this.bloomRing.position.y = 0.03;
    this.bloomRing.scale.setScalar(1.7);
    this.bloomRing.renderOrder = 2;
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(),
      color: 0xffcf7a,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.8,
    }));
    halo.scale.setScalar(1.8);
    halo.position.y = 1.05;
    this.bloomCrystal.position.y = 1.05;
    this.bloom.add(this.bloomCrystal, this.bloomRing, halo);
    this.bloom.visible = false;
    this.group.add(this.bloom);
  }

  setViewportHeight(pixels: number): void {
    this.particles.setViewportHeight(pixels);
    this.sparkles.setViewportHeight(pixels);
  }

  burst(origin: THREE.Vector3, options: BurstOptions): void {
    (options.sparkle ? this.sparkles : this.particles).burst(origin, options);
  }

  /** Element-coloured hit spray at a fighter's chest. */
  hit(position: THREE.Vector3, element: ElementKind, heavy: boolean): void {
    const color = ELEMENT_HEX[element];
    this.particles.burst(position, { count: heavy ? 22 : 10, color, speed: heavy ? 5.5 : 3.6, life: 0.45, size: heavy ? 0.42 : 0.3, gravity: 6, upward: 1 });
    this.sparkles.burst(position, { count: heavy ? 5 : 2, color: 0xffffff, speed: 2.5, life: 0.35, size: 0.55, gravity: 0, upward: 0.4 });
  }

  knockout(position: THREE.Vector3, element: ElementKind): void {
    const color = ELEMENT_HEX[element];
    this.particles.burst(position, { count: 70, color, speed: 6.5, life: 1.1, size: 0.5, gravity: 2.5, upward: 2.8, spread: 0.8 });
    this.sparkles.burst(position, { count: 16, color: 0xfff4d6, speed: 4, life: 1.2, size: 0.8, gravity: 0.6, upward: 2 });
  }

  dust(position: THREE.Vector3): void {
    this.particles.burst(position, { count: 8, color: 0xc9b89c, speed: 1.6, life: 0.5, size: 0.5, gravity: -0.4, upward: 0.4, drag: 4 });
  }

  heal(position: THREE.Vector3): void {
    this.sparkles.burst(position, { count: 12, color: 0x8dffb0, speed: 1.4, life: 1, size: 0.5, gravity: -1.6, upward: 1.2, spread: 0.9 });
  }

  // ------------------------------------------------------------ telegraphs

  showTelegraph(id: number, target: THREE.Vector3, radius: number, color: THREE.ColorRepresentation, duration: number, ultimate: boolean, now: number): void {
    let telegraph = this.telegraphs.find((entry) => !entry.active);
    if (!telegraph) {
      const mesh = new THREE.Mesh(
        this.planeGeometry,
        new THREE.ShaderMaterial({
          uniforms: {
            uColor: { value: new THREE.Color() },
            uProgress: { value: 0 },
            uTime: { value: 0 },
            uUltimate: { value: 0 },
            uFlash: { value: 0 },
            uOpacity: { value: 1 },
          },
          vertexShader: DECAL_VERTEX,
          fragmentShader: TELEGRAPH_FRAGMENT,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 2;
      telegraph = { mesh, id: 0, start: 0, duration: 1, flash: 0, active: false };
      this.telegraphs.push(telegraph);
      this.group.add(mesh);
    }
    telegraph.active = true;
    telegraph.id = id;
    telegraph.start = now;
    telegraph.duration = Math.max(0.05, duration);
    telegraph.flash = 0;
    telegraph.mesh.visible = true;
    telegraph.mesh.position.set(target.x, 0.035, target.z);
    telegraph.mesh.scale.setScalar(radius * 2);
    const uniforms = telegraph.mesh.material.uniforms;
    (uniforms.uColor!.value as THREE.Color).set(color);
    uniforms.uUltimate!.value = ultimate ? 1 : 0;
    uniforms.uProgress!.value = 0;
    uniforms.uFlash!.value = 0;
    uniforms.uOpacity!.value = 1;
  }

  resolveTelegraph(id: number): void {
    const telegraph = this.telegraphs.find((entry) => entry.active && entry.id === id);
    if (telegraph) telegraph.flash = 1;
  }

  // ----------------------------------------------------------- projectiles

  spawnBolt(id: number, element: ElementKind): void {
    let bolt = this.bolts.find((entry) => !entry.active);
    if (!bolt) {
      const group = new THREE.Group();
      const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      core.scale.setScalar(0.62);
      const streak = new THREE.Mesh(
        this.planeGeometry,
        new THREE.MeshBasicMaterial({ map: streakTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
      );
      streak.rotation.x = -Math.PI / 2;
      streak.scale.set(1.5, 0.36, 1);
      streak.position.x = -0.62;
      const glow = new THREE.Mesh(
        this.planeGeometry,
        new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55 }),
      );
      glow.rotation.x = -Math.PI / 2;
      glow.scale.setScalar(1.1);
      const pivot = new THREE.Group();
      pivot.add(streak);
      group.add(core, pivot);
      group.userData.pivot = pivot;
      group.renderOrder = 6;
      core.renderOrder = 6;
      streak.renderOrder = 6;
      glow.renderOrder = 2;
      bolt = { group, core, streak, glow, id: 0, active: false, element, trailTimer: 0 };
      this.bolts.push(bolt);
      this.group.add(group, glow);
    }
    bolt.active = true;
    bolt.id = id;
    bolt.element = element;
    bolt.group.visible = true;
    bolt.glow.visible = true;
    const color = new THREE.Color(ELEMENT_HEX[element]);
    bolt.core.material.color.copy(color).lerp(new THREE.Color(0xffffff), 0.45);
    bolt.streak.material.color.copy(color);
    bolt.glow.material.color.copy(color);
  }

  endBolt(id: number, position: THREE.Vector3, hit: boolean): void {
    const bolt = this.bolts.find((entry) => entry.active && entry.id === id);
    if (!bolt) return;
    bolt.active = false;
    bolt.group.visible = false;
    bolt.glow.visible = false;
    const at = position.clone().setY(BOLT_HEIGHT);
    this.particles.burst(at, { count: hit ? 6 : 10, color: ELEMENT_HEX[bolt.element], speed: 2.4, life: 0.35, size: 0.28, gravity: 3, upward: 0.6 });
  }

  syncBolts(projectiles: readonly ProjectileView[]): void {
    for (const projectile of projectiles) {
      const bolt = this.bolts.find((entry) => entry.active && entry.id === projectile.id);
      if (!bolt) continue;
      bolt.group.position.set(projectile.position.x, BOLT_HEIGHT, projectile.position.z);
      bolt.glow.position.set(projectile.position.x, 0.04, projectile.position.z);
      const pivot = bolt.group.userData.pivot as THREE.Group;
      pivot.rotation.y = -Math.atan2(projectile.velocity.z, projectile.velocity.x);
    }
  }

  // ----------------------------------------------------------------- bloom

  setBloom(active: boolean, position?: THREE.Vector3): void {
    this.bloomTarget = active ? 1 : 0;
    if (position) this.bloom.position.set(position.x, 0, position.z);
    if (active) {
      this.bloom.visible = true;
      this.sparkles.burst(this.bloom.position.clone().setY(1), { count: 14, color: 0xffd78a, speed: 2.6, life: 0.9, size: 0.6, gravity: -0.5, upward: 1.4 });
    } else {
      this.sparkles.burst(this.bloom.position.clone().setY(1), { count: 24, color: 0x9dffc4, speed: 3.6, life: 0.8, size: 0.6, gravity: 0, upward: 2 });
    }
  }

  // ---------------------------------------------------------------- frame

  update(delta: number, now: number): void {
    this.time += delta;
    this.particles.update(delta);
    this.sparkles.update(delta);

    for (const telegraph of this.telegraphs) {
      if (!telegraph.active) continue;
      const uniforms = telegraph.mesh.material.uniforms;
      uniforms.uTime!.value = this.time;
      const progress = Math.min(1, (now - telegraph.start) / telegraph.duration);
      uniforms.uProgress!.value = progress;
      if (telegraph.flash > 0) {
        telegraph.flash -= delta * 3.2;
        uniforms.uFlash!.value = Math.max(0, telegraph.flash);
        uniforms.uOpacity!.value = Math.max(0, telegraph.flash);
        if (telegraph.flash <= 0) {
          telegraph.active = false;
          telegraph.mesh.visible = false;
        }
      } else if (progress >= 1 && now - telegraph.start > telegraph.duration + 0.6) {
        telegraph.active = false;
        telegraph.mesh.visible = false;
      }
    }

    for (const bolt of this.bolts) {
      if (!bolt.active) continue;
      bolt.core.scale.setScalar(0.56 + Math.sin(this.time * 40 + bolt.id) * 0.06);
      bolt.trailTimer -= delta;
      if (bolt.trailTimer <= 0) {
        bolt.trailTimer = 0.03;
        this.particles.burst(bolt.group.position, { count: 1, color: ELEMENT_HEX[bolt.element], speed: 0.4, life: 0.32, size: 0.24, gravity: 0, upward: 0, drag: 3 });
      }
    }

    this.bloomVisible = THREE.MathUtils.damp(this.bloomVisible, this.bloomTarget, 6, delta);
    if (this.bloom.visible) {
      const scale = Math.max(0.001, this.bloomVisible);
      this.bloom.scale.setScalar(scale);
      this.bloomCrystal.rotation.y += delta * 1.4;
      this.bloomCrystal.position.y = 1.05 + Math.sin(this.time * 2.2) * 0.1;
      this.bloomRing.material.uniforms.uTime!.value = this.time;
      if (this.bloomVisible < 0.01 && this.bloomTarget === 0) this.bloom.visible = false;
    }
  }

  clear(): void {
    this.particles.clear();
    this.sparkles.clear();
    for (const telegraph of this.telegraphs) {
      telegraph.active = false;
      telegraph.mesh.visible = false;
    }
    for (const bolt of this.bolts) {
      bolt.active = false;
      bolt.group.visible = false;
      bolt.glow.visible = false;
    }
    this.bloomTarget = 0;
    this.bloomVisible = 0;
    this.bloom.visible = false;
  }

  dispose(): void {
    this.particles.dispose();
    this.sparkles.dispose();
    for (const telegraph of this.telegraphs) telegraph.mesh.material.dispose();
    for (const bolt of this.bolts) {
      bolt.core.material.dispose();
      bolt.streak.material.dispose();
      bolt.glow.material.dispose();
    }
    this.bloomCrystal.geometry.dispose();
    this.bloomCrystal.material.dispose();
    this.bloomRing.material.dispose();
    this.planeGeometry.dispose();
    this.group.removeFromParent();
  }
}
