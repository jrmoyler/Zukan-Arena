import * as THREE from 'three';

import type { CastEvent, ElementKind, TeamKind } from '../types';
import { ABILITIES } from '../data/abilities';

export type ElementalVfxQuality = 'low' | 'high';

export interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

export interface ElementalVfxEvent {
  element: ElementKind;
  position: Vector3Like;
  target?: Vector3Like;
  team?: TeamKind;
  intensity?: number;
  seed?: number;
}

export type ElementalVfxInput = ElementalVfxEvent | CastEvent;

export interface ElementalVfxManagerOptions {
  quality?: ElementalVfxQuality;
  reducedMotion?: boolean;
  onImpact?: (event: Readonly<ElementalVfxEvent>) => void;
}

interface NormalizedEvent {
  element: ElementKind;
  position: THREE.Vector3;
  target: THREE.Vector3;
  team: TeamKind;
  intensity: number;
  seed: number;
}

interface MutableTransformRecord {
  angle: number;
  distance: number;
  delay: number;
  lift: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  yaw: number;
}

const TAU = Math.PI * 2;
const MAX_FRAME_DELTA = 0.1;
const ACTIVE_CAP: Record<ElementalVfxQuality, number> = { high: 12, low: 7 };

const TEAM_COLOR: Record<TeamKind, number> = {
  signal: 0x68f6d2,
  rift: 0xff6d9f,
};

const DURATION: Record<ElementKind, number> = {
  earth: 1.65,
  hydro: 1.45,
  gale: 1.55,
  plasma: 0.82,
  nature: 1.75,
  void: 1.6,
};

const IMPACT_TIME: Record<ElementKind, number> = {
  earth: ABILITIES.earth.impactDelay,
  hydro: ABILITIES.hydro.impactDelay,
  gale: ABILITIES.gale.impactDelay,
  plasma: ABILITIES.plasma.impactDelay,
  nature: ABILITIES.nature.impactDelay,
  void: ABILITIES.void.impactDelay,
};

function clamp01(value: number): number {
  return THREE.MathUtils.clamp(value, 0, 1);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const normalized = clamp01((value - edge0) / (edge1 - edge0));
  return normalized * normalized * (3 - 2 * normalized);
}

function pulse(value: number, start: number, end: number): number {
  return smoothstep(start, (start + end) * 0.5, value)
    * (1 - smoothstep((start + end) * 0.5, end, value));
}

function mix(minimum: number, maximum: number, amount: number): number {
  return THREE.MathUtils.lerp(minimum, maximum, amount);
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(state, 1664525) + 1013904223 >>> 0;
    return state / 4294967296;
  };
}

function copyVector(value: Vector3Like): THREE.Vector3 {
  return new THREE.Vector3(value.x, value.y, value.z);
}

function orientAlongGround(root: THREE.Object3D, origin: THREE.Vector3, target: THREE.Vector3): number {
  const deltaX = target.x - origin.x;
  const deltaZ = target.z - origin.z;
  root.position.copy(origin);
  root.rotation.set(0, -Math.atan2(deltaZ, deltaX), 0);
  return Math.max(0.05, Math.hypot(deltaX, deltaZ));
}

function disposeTree(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
      geometries.add(object.geometry);
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of objectMaterials) materials.add(material);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  root.removeFromParent();
  root.clear();
}

abstract class ElementEffect {
  readonly root = new THREE.Group();
  abstract readonly element: ElementKind;

  protected readonly quality: ElementalVfxQuality;
  protected readonly reducedMotion: boolean;
  protected event: NormalizedEvent = {
    element: 'earth',
    position: new THREE.Vector3(),
    target: new THREE.Vector3(),
    team: 'signal',
    intensity: 1,
    seed: 0,
  };
  protected elapsed = 0;

  private impacted = false;
  private readonly impactCallback?: (event: Readonly<ElementalVfxEvent>) => void;

  constructor(options: Required<Pick<ElementalVfxManagerOptions, 'quality' | 'reducedMotion'>> & Pick<ElementalVfxManagerOptions, 'onImpact'>) {
    this.quality = options.quality;
    this.reducedMotion = options.reducedMotion;
    this.impactCallback = options.onImpact;
    this.root.visible = false;
    this.root.matrixAutoUpdate = true;
  }

  reset(event: NormalizedEvent): void {
    this.event = event;
    this.elapsed = 0;
    this.impacted = false;
    this.root.visible = true;
    this.root.scale.setScalar(1);
    this.root.rotation.set(0, 0, 0);
    this.onReset(createRandom(event.seed));
    this.onUpdate(0, 0);
  }

  update(deltaSeconds: number): boolean {
    const duration = DURATION[this.element];
    this.elapsed = Math.min(duration, this.elapsed + deltaSeconds);
    const progress = this.elapsed / duration;
    this.onUpdate(progress, deltaSeconds);

    if (!this.impacted && this.elapsed >= IMPACT_TIME[this.element]) {
      this.impacted = true;
      this.impactCallback?.({
        element: this.event.element,
        position: this.event.position.clone(),
        target: this.event.target.clone(),
        team: this.event.team,
        intensity: this.event.intensity,
        seed: this.event.seed,
      });
    }

    return this.elapsed < duration;
  }

  deactivate(): void {
    this.root.visible = false;
    this.root.removeFromParent();
  }

  dispose(): void {
    disposeTree(this.root);
  }

  protected abstract onReset(random: () => number): void;
  protected abstract onUpdate(progress: number, deltaSeconds: number): void;
}

class EarthEffect extends ElementEffect {
  readonly element = 'earth' as const;

  private readonly dummy = new THREE.Object3D();
  private readonly plateRecords: MutableTransformRecord[];
  private readonly rockRecords: MutableTransformRecord[];
  private readonly plates: THREE.InstancedMesh;
  private readonly rocks: THREE.InstancedMesh;
  private readonly fissures: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;

  constructor(options: ConstructorParameters<typeof ElementEffect>[0]) {
    super(options);
    const plateCount = this.reducedMotion ? 10 : this.quality === 'low' ? 16 : 28;
    const rockCount = this.reducedMotion ? 5 : this.quality === 'low' ? 8 : 13;
    const fissureCount = this.reducedMotion ? 4 : this.quality === 'low' ? 5 : 8;

    this.plateRecords = Array.from({ length: plateCount }, () => ({
      angle: 0,
      distance: 0,
      delay: 0,
      lift: 0,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
      yaw: 0,
    }));
    this.rockRecords = Array.from({ length: rockCount }, () => ({
      angle: 0,
      distance: 0,
      delay: 0,
      lift: 0,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
      yaw: 0,
    }));

    this.plates = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({
        color: 0x6c5a42,
        emissive: 0x7a2c22,
        emissiveIntensity: 0.12,
        roughness: 0.96,
        metalness: 0.02,
        flatShading: true,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }),
      plateCount,
    );
    this.rocks = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(0.5, 0),
      new THREE.MeshStandardMaterial({
        color: 0x514536,
        emissive: 0x9c3530,
        emissiveIntensity: 0.09,
        roughness: 0.98,
        flatShading: true,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
      }),
      rockCount,
    );
    this.plates.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rocks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.plates.frustumCulled = false;
    this.rocks.frustumCulled = false;
    this.plates.renderOrder = 3;
    this.rocks.renderOrder = 4;

    const fissureGeometry = new THREE.BufferGeometry();
    fissureGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(fissureCount * 5 * 2 * 3), 3));
    this.fissures = new THREE.LineSegments(
      fissureGeometry,
      new THREE.LineBasicMaterial({
        color: 0xff8d68,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.fissures.renderOrder = 5;
    this.root.add(this.plates, this.rocks, this.fissures);
  }

  protected onReset(random: () => number): void {
    this.root.position.copy(this.event.target);
    this.root.position.y += 0.02;

    for (const record of this.plateRecords) {
      const radial = Math.sqrt(random());
      record.angle = random() * TAU;
      record.distance = radial * 2.25;
      record.yaw = random() * TAU;
      record.delay = radial * 0.16 + random() * 0.08;
      record.lift = mix(0.12, 0.54, random());
      record.scaleX = mix(0.5, 1.05, random());
      record.scaleY = mix(0.08, 0.18, random());
      record.scaleZ = mix(0.45, 0.95, random());
    }

    for (let index = 0; index < this.rockRecords.length; index += 1) {
      const record = this.rockRecords[index]!;
      const tower = index < Math.min(4, this.rockRecords.length);
      record.angle = tower ? index * 1.8 : random() * TAU;
      record.distance = tower ? random() * 0.28 : mix(0.65, 1.55, random());
      record.yaw = random() * TAU;
      record.delay = tower ? 0.17 + index * 0.045 : 0.28 + random() * 0.18;
      record.lift = tower ? 0.38 + index * 0.38 : mix(0.15, 0.8, random());
      record.scaleX = tower ? mix(0.62, 0.84, random()) : mix(0.35, 0.72, random());
      record.scaleY = tower ? mix(0.82, 1.18, random()) : mix(0.38, 0.78, random());
      record.scaleZ = tower ? mix(0.62, 0.82, random()) : mix(0.35, 0.72, random());
    }

    const position = this.fissures.geometry.getAttribute('position');
    const values = position.array as Float32Array;
    const fissureCount = values.length / (5 * 2 * 3);
    let offset = 0;
    for (let fissure = 0; fissure < fissureCount; fissure += 1) {
      const angle = fissure / fissureCount * TAU + (random() - 0.5) * 0.35;
      let lastX = 0;
      let lastZ = 0;
      const length = mix(1.5, 2.35, random());
      for (let segment = 1; segment <= 5; segment += 1) {
        const distance = segment / 5 * length;
        const wobble = (random() - 0.5) * 0.3 * segment;
        const nextX = Math.cos(angle + wobble) * distance;
        const nextZ = Math.sin(angle + wobble) * distance;
        values.set([lastX, 0.035, lastZ, nextX, 0.035, nextZ], offset);
        offset += 6;
        lastX = nextX;
        lastZ = nextZ;
      }
    }
    position.needsUpdate = true;
  }

  protected onUpdate(progress: number): void {
    const entrance = smoothstep(0, 0.48, progress);
    const fade = 1 - smoothstep(0.72, 1, progress);
    const intensity = this.event.intensity;

    for (let index = 0; index < this.plateRecords.length; index += 1) {
      const record = this.plateRecords[index]!;
      const growth = smoothstep(record.delay, record.delay + 0.24, progress);
      const settle = 1 - smoothstep(0.72, 1, progress) * 0.55;
      this.dummy.position.set(
        Math.cos(record.angle) * record.distance,
        record.lift * growth * settle,
        Math.sin(record.angle) * record.distance,
      );
      this.dummy.rotation.set(-0.08 + growth * 0.22, record.yaw, (record.angle - Math.PI * 0.5) * 0.08);
      this.dummy.scale.set(record.scaleX * growth, record.scaleY * growth, record.scaleZ * growth);
      this.dummy.updateMatrix();
      this.plates.setMatrixAt(index, this.dummy.matrix);
    }

    for (let index = 0; index < this.rockRecords.length; index += 1) {
      const record = this.rockRecords[index]!;
      const growth = smoothstep(record.delay, record.delay + 0.19, progress);
      this.dummy.position.set(
        Math.cos(record.angle) * record.distance,
        record.lift * growth,
        Math.sin(record.angle) * record.distance,
      );
      this.dummy.rotation.set(record.yaw * 0.4, record.yaw, record.angle * 0.27);
      this.dummy.scale.set(record.scaleX * growth, record.scaleY * growth, record.scaleZ * growth);
      this.dummy.updateMatrix();
      this.rocks.setMatrixAt(index, this.dummy.matrix);
    }

    this.plates.instanceMatrix.needsUpdate = true;
    this.rocks.instanceMatrix.needsUpdate = true;
    this.root.scale.setScalar(0.92 + entrance * 0.08 * intensity);
    (this.plates.material as THREE.MeshStandardMaterial).opacity = fade * 0.9;
    (this.rocks.material as THREE.MeshStandardMaterial).opacity = fade * 0.92;
    this.fissures.material.opacity = entrance * fade * 0.92;
  }
}

interface WaterUniforms {
  [name: string]: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  uProgress: THREE.IUniform<number>;
  uOpacity: THREE.IUniform<number>;
  uMotion: THREE.IUniform<number>;
}

class HydroEffect extends ElementEffect {
  readonly element = 'hydro' as const;

  private readonly uniforms: WaterUniforms;
  private readonly water: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly foam: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly rings: Array<THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>> = [];
  private length = 1;
  private width = 2.55;

  constructor(options: ConstructorParameters<typeof ElementEffect>[0]) {
    super(options);
    this.width = this.quality === 'low' ? 2 : 2.55;
    this.uniforms = {
      uTime: { value: 0 },
      uProgress: { value: 0 },
      uOpacity: { value: 0 },
      uMotion: { value: this.reducedMotion ? 0 : 1 },
    };

    const geometry = new THREE.PlaneGeometry(1, 1, this.quality === 'low' ? 12 : 24, this.quality === 'low' ? 3 : 7);
    geometry.rotateX(-Math.PI * 0.5);
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      vertexShader: `
        uniform float uTime;
        uniform float uMotion;
        varying vec2 vUv;
        varying float vWave;
        void main() {
          vUv = uv;
          vec3 transformed = position;
          float wave = sin(uv.x * 30.0 - uTime * 6.0) * 0.045;
          wave += sin(uv.y * 18.0 + uTime * 4.2) * 0.035;
          transformed.y += wave * uMotion;
          vWave = wave;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uProgress;
        uniform float uOpacity;
        varying vec2 vUv;
        varying float vWave;
        void main() {
          float leading = 1.0 - smoothstep(uProgress, uProgress + 0.13, vUv.x);
          float edge = smoothstep(0.0, 0.12, vUv.y) * (1.0 - smoothstep(0.88, 1.0, vUv.y));
          float foam = smoothstep(0.02, 0.07, abs(vWave));
          vec3 deep = vec3(0.035, 0.28, 0.48);
          vec3 crest = vec3(0.55, 0.94, 1.0);
          vec3 color = mix(deep, crest, 0.3 + foam * 0.55 + vUv.y * 0.12);
          gl_FragColor = vec4(color, leading * edge * uOpacity * (0.64 + foam * 0.25));
        }
      `,
    });
    this.water = new THREE.Mesh(geometry, material);
    this.water.frustumCulled = false;
    this.water.renderOrder = 8;

    const foamCount = this.reducedMotion ? 10 : this.quality === 'low' ? 18 : 34;
    const foamGeometry = new THREE.BufferGeometry();
    foamGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(foamCount * 3), 3));
    this.foam = new THREE.Points(
      foamGeometry,
      new THREE.PointsMaterial({
        color: 0xeafcff,
        size: this.quality === 'low' ? 0.13 : 0.18,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.foam.renderOrder = 10;

    const ringCount = this.quality === 'low' || this.reducedMotion ? 1 : 2;
    for (let index = 0; index < ringCount; index += 1) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.68 + index * 0.32, 0.76 + index * 0.35, 40),
        new THREE.MeshBasicMaterial({
          color: index === 0 ? 0xbdf5ff : 0x32cae9,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      ring.rotation.x = -Math.PI * 0.5;
      ring.renderOrder = 9;
      this.rings.push(ring);
      this.root.add(ring);
    }
    this.root.add(this.water, this.foam);
  }

  protected onReset(random: () => number): void {
    this.length = orientAlongGround(this.root, this.event.position, this.event.target);
    this.water.position.set(this.length * 0.5, 0.055, 0);
    this.water.scale.set(this.length + 0.8, 1, this.width);

    const attribute = this.foam.geometry.getAttribute('position');
    const values = attribute.array as Float32Array;
    for (let index = 0; index < values.length / 3; index += 1) {
      values[index * 3] = random() ** 0.65 * this.length;
      values[index * 3 + 1] = 0.12 + random() * 0.28;
      values[index * 3 + 2] = (random() - 0.5) * this.width * (0.2 + random() * 0.72);
    }
    attribute.needsUpdate = true;

    for (let index = 0; index < this.rings.length; index += 1) {
      const ring = this.rings[index]!;
      ring.position.set(this.length, 0.07 + index * 0.015, 0);
      ring.scale.setScalar(0.2);
      ring.material.opacity = 0;
    }
    this.rings[0]?.material.color.setHex(TEAM_COLOR[this.event.team]);
    this.uniforms.uTime.value = 0;
  }

  protected onUpdate(progress: number, deltaSeconds: number): void {
    const enter = smoothstep(0, 0.43, progress);
    const fade = 1 - smoothstep(0.73, 1, progress);
    this.uniforms.uTime.value += deltaSeconds;
    this.uniforms.uProgress.value = Math.min(1, enter * 1.08);
    this.uniforms.uOpacity.value = fade * this.event.intensity;
    this.foam.material.opacity = pulse(progress, 0.14, 0.78) * 0.92;
    for (let index = 0; index < this.rings.length; index += 1) {
      const ring = this.rings[index]!;
      const ringProgress = smoothstep(0.24 + index * 0.04, 0.78, progress);
      ring.scale.setScalar(0.35 + ringProgress * (2.25 + index * 0.42));
      ring.material.opacity = ringProgress * (1 - ringProgress) * 2.4 * fade;
    }
  }
}

interface RibbonUniforms {
  [name: string]: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  uProgress: THREE.IUniform<number>;
  uFade: THREE.IUniform<number>;
  uMotion: THREE.IUniform<number>;
  uPhase: THREE.IUniform<number>;
}

class GaleEffect extends ElementEffect {
  readonly element = 'gale' as const;

  private readonly ribbonUniforms: RibbonUniforms[] = [];
  private readonly ribbons: THREE.Mesh[] = [];
  private readonly tornado = new THREE.Group();
  private readonly tornadoMaterials: THREE.MeshBasicMaterial[] = [];
  private length = 1;

  constructor(options: ConstructorParameters<typeof ElementEffect>[0]) {
    super(options);
    const ribbonCount = this.reducedMotion ? 2 : this.quality === 'low' ? 3 : 6;
    const segments = this.quality === 'low' ? 13 : 22;
    for (let index = 0; index < ribbonCount; index += 1) {
      const uniforms: RibbonUniforms = {
        uTime: { value: 0 },
        uProgress: { value: 0 },
        uFade: { value: 0 },
        uMotion: { value: this.reducedMotion ? 0 : 1 },
        uPhase: { value: index / ribbonCount * TAU },
      };
      const geometry = new THREE.PlaneGeometry(1, 1, segments, 1);
      geometry.rotateX(-Math.PI * 0.5);
      const material = new THREE.ShaderMaterial({
        uniforms,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        vertexShader: `
          uniform float uTime;
          uniform float uMotion;
          uniform float uPhase;
          varying vec2 vUv;
          void main() {
            vUv = uv;
            vec3 transformed = position;
            float envelope = sin(uv.x * 3.14159265);
            transformed.y += sin(uv.x * 16.0 - uTime * 6.0 + uPhase) * 0.16 * envelope * uMotion;
            transformed.z += cos(uv.x * 10.0 + uTime * 4.0 + uPhase) * 0.2 * envelope * uMotion;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
          }
        `,
        fragmentShader: `
          uniform float uProgress;
          uniform float uFade;
          varying vec2 vUv;
          void main() {
            float head = 1.0 - smoothstep(uProgress, uProgress + 0.15, vUv.x);
            float ribbon = smoothstep(0.0, 0.2, vUv.y) * (1.0 - smoothstep(0.8, 1.0, vUv.y));
            vec3 color = mix(vec3(0.34, 0.74, 0.78), vec3(0.84, 1.0, 0.96), vUv.x);
            gl_FragColor = vec4(color, head * ribbon * uFade * 0.72);
          }
        `,
      });
      const ribbon = new THREE.Mesh(geometry, material);
      ribbon.frustumCulled = false;
      ribbon.renderOrder = 11;
      this.ribbonUniforms.push(uniforms);
      this.ribbons.push(ribbon);
      this.root.add(ribbon);
    }

    const tornadoCount = this.quality === 'high' && !this.reducedMotion ? 2 : 1;
    for (let index = 0; index < tornadoCount; index += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: index === 0 ? 0xbaf6e2 : 0x68bec5,
        wireframe: true,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.92 + index * 0.14, 2.35, 24, 10, true), material);
      cone.position.y = 1.17;
      cone.rotation.y = index * 1.7;
      cone.renderOrder = 12 + index;
      this.tornadoMaterials.push(material);
      this.tornado.add(cone);
    }
    this.root.add(this.tornado);
  }

  protected onReset(random: () => number): void {
    this.length = orientAlongGround(this.root, this.event.position, this.event.target);
    for (let index = 0; index < this.ribbons.length; index += 1) {
      const ribbon = this.ribbons[index]!;
      ribbon.position.set(this.length * 0.5, 0.18 + index * 0.045, (index - this.ribbons.length * 0.5) * 0.08);
      ribbon.scale.set(this.length, 1, 0.34 + index % 2 * 0.1);
      this.ribbonUniforms[index]!.uPhase.value = index / this.ribbons.length * TAU + random() * 0.35;
      this.ribbonUniforms[index]!.uTime.value = 0;
    }
    this.tornado.position.set(this.length, 0.01, 0);
    this.tornado.scale.setScalar(0.01);
  }

  protected onUpdate(progress: number, deltaSeconds: number): void {
    const enter = smoothstep(0, 0.48, progress);
    const fade = 1 - smoothstep(0.76, 1, progress);
    for (const uniforms of this.ribbonUniforms) {
      uniforms.uTime.value += deltaSeconds;
      uniforms.uProgress.value = Math.min(1, enter * 1.12);
      uniforms.uFade.value = fade * this.event.intensity;
    }
    const tornadoProgress = smoothstep(0.25, 0.56, progress);
    const tornadoFade = (1 - smoothstep(0.72, 1, progress)) * tornadoProgress;
    this.tornado.scale.set(0.45 + tornadoProgress * 0.55, tornadoProgress, 0.45 + tornadoProgress * 0.55);
    this.tornado.rotation.y += deltaSeconds * 5.5 * (this.reducedMotion ? 0 : 1);
    for (let index = 0; index < this.tornadoMaterials.length; index += 1) {
      this.tornadoMaterials[index]!.opacity = tornadoFade * (0.78 - index * 0.18);
    }
  }
}

class PlasmaEffect extends ElementEffect {
  readonly element = 'plasma' as const;

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly coreMaterials: THREE.LineBasicMaterial[] = [];
  private readonly glowMaterials: THREE.LineBasicMaterial[] = [];
  private readonly ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly samples: number;
  private length = 1;
  private flickerPhase = 0;

  constructor(options: ConstructorParameters<typeof ElementEffect>[0]) {
    super(options);
    const filamentCount = this.reducedMotion ? 2 : this.quality === 'low' ? 3 : 5;
    this.samples = this.quality === 'low' ? 10 : 15;
    for (let index = 0; index < filamentCount; index += 1) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((this.samples + 1) * 3), 3));
      const glowMaterial = new THREE.LineBasicMaterial({
        color: index % 2 === 0 ? 0x57ffef : 0xae4fff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const coreMaterial = new THREE.LineBasicMaterial({
        color: index === 0 ? 0xf3ffff : 0x84dfff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const glow = new THREE.Line(geometry, glowMaterial);
      const core = new THREE.Line(geometry, coreMaterial);
      glow.scale.set(1, 1.08, 1.08);
      glow.renderOrder = 14;
      core.renderOrder = 15;
      this.geometries.push(geometry);
      this.glowMaterials.push(glowMaterial);
      this.coreMaterials.push(coreMaterial);
      this.root.add(glow, core);
    }

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.2, 0.32, 32),
      new THREE.MeshBasicMaterial({
        color: 0xb7f5ff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.ring.rotation.x = -Math.PI * 0.5;
    this.ring.renderOrder = 16;
    this.root.add(this.ring);
  }

  protected onReset(random: () => number): void {
    this.length = orientAlongGround(this.root, this.event.position, this.event.target);
    this.flickerPhase = random() * TAU;
    for (let filament = 0; filament < this.geometries.length; filament += 1) {
      const controlPoints: THREE.Vector3[] = [];
      const phase = filament / this.geometries.length * TAU;
      const controls = this.quality === 'low' ? 9 : 14;
      for (let index = 0; index <= controls; index += 1) {
        const amount = index / controls;
        const envelope = Math.sin(Math.PI * amount);
        controlPoints.push(new THREE.Vector3(
          amount * this.length,
          mix(0.52, 0.45, amount) + (random() - 0.5) * 0.54 * envelope + Math.sin(phase) * 0.16 * envelope,
          (random() - 0.5) * 0.62 * envelope + Math.cos(phase) * 0.22 * envelope,
        ));
      }
      const curve = new THREE.CatmullRomCurve3(controlPoints, false, 'catmullrom', 0.05);
      const geometry = this.geometries[filament]!;
      const values = geometry.getAttribute('position').array as Float32Array;
      for (let sample = 0; sample <= this.samples; sample += 1) {
        const point = curve.getPoint(sample / this.samples);
        values.set([point.x, point.y, point.z], sample * 3);
      }
      geometry.getAttribute('position').needsUpdate = true;
      geometry.computeBoundingSphere();
    }
    this.ring.position.set(this.length, 0.04, 0);
    this.ring.scale.setScalar(0.2);
    this.root.scale.set(0.001, 1, 1);
  }

  protected onUpdate(progress: number): void {
    const enter = smoothstep(0, 0.26, progress);
    const fade = 1 - smoothstep(0.56, 1, progress);
    const flicker = this.reducedMotion ? 0.9 : 0.72 + Math.sin(this.elapsed * 75 + this.flickerPhase) * 0.2;
    this.root.scale.set(Math.max(0.001, enter), 1, 1);
    for (let index = 0; index < this.coreMaterials.length; index += 1) {
      this.coreMaterials[index]!.opacity = enter * fade * flicker * (index === 0 ? 1 : 0.72);
      this.glowMaterials[index]!.opacity = enter * fade * flicker * 0.24;
    }
    const ringProgress = smoothstep(0.18, 0.42, progress);
    this.ring.scale.setScalar(0.3 + ringProgress * 4.2);
    this.ring.material.opacity = ringProgress * (1 - ringProgress) * 3.2 * fade;
  }
}

interface LeafRecord {
  position: THREE.Vector3;
  rotation: number;
  delay: number;
  scale: number;
}

class NatureEffect extends ElementEffect {
  readonly element = 'nature' as const;

  private readonly vines: Array<THREE.Mesh<THREE.TubeGeometry, THREE.MeshStandardMaterial>> = [];
  private readonly leaves: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly leafRecords: LeafRecord[];
  private readonly dummy = new THREE.Object3D();

  constructor(options: ConstructorParameters<typeof ElementEffect>[0]) {
    super(options);
    const vineCount = this.reducedMotion ? 3 : this.quality === 'low' ? 4 : 7;
    for (let index = 0; index < vineCount; index += 1) {
      const fixedRandom = createRandom(0x92f1 + index * 1013);
      const points: THREE.Vector3[] = [];
      const phase = index / vineCount * TAU;
      for (let segment = 0; segment <= 9; segment += 1) {
        const amount = segment / 9;
        const radius = (1 - smoothstep(0.12, 1, amount) * 0.78) * mix(1.25, 1.9, fixedRandom());
        const angle = phase + amount * TAU * mix(0.6, 1.15, fixedRandom());
        points.push(new THREE.Vector3(
          Math.cos(angle) * radius,
          amount ** 1.3 * mix(1.15, 1.75, fixedRandom()) + Math.sin(amount * TAU) * 0.08,
          Math.sin(angle) * radius,
        ));
      }
      const geometry = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(points, false, 'centripetal'),
        this.quality === 'low' ? 20 : 32,
        0.055 + fixedRandom() * 0.025,
        5,
        false,
      );
      const material = new THREE.MeshStandardMaterial({
        color: index % 2 === 0 ? 0x2e824a : 0x78c45d,
        emissive: 0x194b2b,
        emissiveIntensity: 0.25,
        roughness: 0.78,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const vine = new THREE.Mesh(geometry, material);
      vine.renderOrder = 5;
      this.vines.push(vine);
      this.root.add(vine);
    }

    const leafCount = this.reducedMotion ? 8 : this.quality === 'low' ? 14 : 26;
    const leafGeometry = new THREE.PlaneGeometry(0.12, 0.32);
    leafGeometry.rotateZ(Math.PI * 0.5);
    this.leaves = new THREE.InstancedMesh(
      leafGeometry,
      new THREE.MeshBasicMaterial({
        color: 0x55b86d,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
      leafCount,
    );
    this.leaves.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.leaves.frustumCulled = false;
    this.leaves.renderOrder = 6;
    this.leafRecords = Array.from({ length: leafCount }, () => ({
      position: new THREE.Vector3(),
      rotation: 0,
      delay: 0,
      scale: 1,
    }));
    this.root.add(this.leaves);
  }

  protected onReset(random: () => number): void {
    this.root.position.copy(this.event.target);
    for (let index = 0; index < this.vines.length; index += 1) {
      const vine = this.vines[index]!;
      vine.rotation.y = random() * 0.5 + index / this.vines.length * TAU;
      vine.scale.set(1, 0.001, 1);
      vine.material.opacity = 0;
    }
    for (const record of this.leafRecords) {
      const angle = random() * TAU;
      const radius = mix(0.25, 1.45, random());
      record.position.set(Math.cos(angle) * radius, mix(0.2, 1.45, random()), Math.sin(angle) * radius);
      record.rotation = random() * TAU;
      record.delay = mix(0.22, 0.63, random());
      record.scale = mix(0.55, 1.25, random());
    }
  }

  protected onUpdate(progress: number): void {
    const growth = smoothstep(0.02, 0.62, progress);
    const sway = smoothstep(0.48, 0.78, progress);
    const fade = 1 - smoothstep(0.78, 1, progress);
    for (let index = 0; index < this.vines.length; index += 1) {
      const vine = this.vines[index]!;
      vine.scale.set(1, Math.max(0.001, growth), 1);
      vine.rotation.y += (index % 2 === 0 ? 1 : -1) * 0.004 * (this.reducedMotion ? 0 : 1);
      vine.material.opacity = growth * fade * (0.78 + index % 3 * 0.07);
    }
    this.leaves.material.opacity = fade * smoothstep(0.25, 0.58, progress) * 0.92;
    for (let index = 0; index < this.leafRecords.length; index += 1) {
      const record = this.leafRecords[index]!;
      const scale = smoothstep(record.delay, record.delay + 0.1, progress) * record.scale;
      this.dummy.position.copy(record.position).multiplyScalar(1 - sway * 0.18);
      this.dummy.rotation.set(record.rotation * 0.3, record.rotation + sway * 0.35, record.rotation * 0.2);
      this.dummy.scale.setScalar(scale);
      this.dummy.updateMatrix();
      this.leaves.setMatrixAt(index, this.dummy.matrix);
    }
    this.leaves.instanceMatrix.needsUpdate = true;
  }
}

class VoidEffect extends ElementEffect {
  readonly element = 'void' as const;

  private readonly tendrilGeometries: THREE.BufferGeometry[] = [];
  private readonly tendrilMaterials: THREE.LineBasicMaterial[] = [];
  private readonly core: THREE.Mesh<THREE.IcosahedronGeometry, THREE.MeshBasicMaterial>;
  private readonly column: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>;
  private readonly rings: Array<THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>> = [];
  private readonly samples: number;

  constructor(options: ConstructorParameters<typeof ElementEffect>[0]) {
    super(options);
    const tendrilCount = this.reducedMotion ? 3 : this.quality === 'low' ? 5 : 8;
    this.samples = this.quality === 'low' ? 16 : 24;
    for (let index = 0; index < tendrilCount; index += 1) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((this.samples + 1) * 3), 3));
      const material = new THREE.LineBasicMaterial({
        color: index % 2 === 0 ? 0x20ffe4 : 0x6e42e8,
        transparent: true,
        opacity: 0,
        blending: THREE.NormalBlending,
        depthWrite: false,
      });
      const tendril = new THREE.Line(geometry, material);
      tendril.renderOrder = 17;
      this.tendrilGeometries.push(geometry);
      this.tendrilMaterials.push(material);
      this.root.add(tendril);
    }

    this.core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(this.quality === 'low' ? 0.32 : 0.4, 1),
      new THREE.MeshBasicMaterial({
        color: 0x08000e,
        transparent: true,
        opacity: 0,
        blending: THREE.NormalBlending,
        depthWrite: false,
      }),
    );
    this.core.position.y = 0.4;
    this.core.renderOrder = 18;
    this.column = new THREE.Mesh(
      new THREE.ConeGeometry(0.48, 2.8, 28, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xb88fff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.column.position.y = 1.4;
    this.column.renderOrder = 19;
    this.root.add(this.core, this.column);

    const ringCount = this.quality === 'low' || this.reducedMotion ? 2 : 3;
    for (let index = 0; index < ringCount; index += 1) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.3 + index * 0.24, 0.35 + index * 0.25, 40),
        new THREE.MeshBasicMaterial({
          color: index === 0 ? 0xf2dcff : 0x8c49f5,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      ring.rotation.x = -Math.PI * 0.5;
      ring.position.y = 0.055 + index * 0.01;
      ring.renderOrder = 19;
      this.rings.push(ring);
      this.root.add(ring);
    }
  }

  protected onReset(random: () => number): void {
    this.root.position.copy(this.event.target);
    for (let tendril = 0; tendril < this.tendrilGeometries.length; tendril += 1) {
      const phase = tendril / this.tendrilGeometries.length * TAU + random() * 0.25;
      const radius = mix(1.65, 2.4, random());
      const controlPoints: THREE.Vector3[] = [];
      for (let index = 0; index <= 8; index += 1) {
        const amount = index / 8;
        const taper = (1 - amount) ** 1.15;
        const angle = phase + amount * TAU * 0.55;
        controlPoints.push(new THREE.Vector3(
          Math.cos(angle) * radius * taper,
          0.06 + Math.sin(Math.PI * amount) * (0.28 + random() * 0.2),
          Math.sin(angle) * radius * taper,
        ));
      }
      const curve = new THREE.CatmullRomCurve3(controlPoints, false, 'centripetal');
      const geometry = this.tendrilGeometries[tendril]!;
      const attribute = geometry.getAttribute('position');
      const values = attribute.array as Float32Array;
      for (let sample = 0; sample <= this.samples; sample += 1) {
        const point = curve.getPoint(sample / this.samples);
        values.set([point.x, point.y, point.z], sample * 3);
      }
      attribute.needsUpdate = true;
      geometry.computeBoundingSphere();
      this.tendrilMaterials[tendril]!.opacity = 0;
    }
    this.core.scale.setScalar(0.01);
    this.column.scale.set(1, 0.01, 1);
    for (const ring of this.rings) {
      ring.scale.setScalar(0.2);
      ring.material.opacity = 0;
    }
  }

  protected onUpdate(progress: number, deltaSeconds: number): void {
    const tendrilGrowth = smoothstep(0.02, 0.46, progress);
    const coreGrowth = smoothstep(0.32, 0.64, progress);
    const fade = 1 - smoothstep(0.74, 1, progress);
    for (let index = 0; index < this.tendrilMaterials.length; index += 1) {
      this.tendrilMaterials[index]!.opacity = tendrilGrowth * fade * (0.48 + index % 3 * 0.08);
    }
    const coreScale = (0.25 + coreGrowth * 0.75) * fade;
    this.core.scale.setScalar(Math.max(0.001, coreScale));
    this.core.material.opacity = coreGrowth * fade * 0.72;
    this.core.rotation.y += deltaSeconds * 1.8 * (this.reducedMotion ? 0 : 1);
    this.column.material.opacity = coreGrowth * (1 - smoothstep(0.64, 0.9, progress)) * 0.21;
    this.column.scale.set(1, Math.max(0.001, smoothstep(0.36, 0.62, progress)), 1);
    this.column.rotation.y += deltaSeconds * 0.8 * (this.reducedMotion ? 0 : 1);
    for (let index = 0; index < this.rings.length; index += 1) {
      const ring = this.rings[index]!;
      const ringProgress = smoothstep(0.18 + index * 0.045, 0.66, progress);
      ring.scale.setScalar(2.1 - ringProgress * (1.05 + index * 0.09));
      ring.material.opacity = ringProgress * (1 - ringProgress) * 2.2 * fade;
      ring.rotation.z += (index % 2 === 0 ? 1 : -1) * deltaSeconds * 0.35 * (this.reducedMotion ? 0 : 1);
    }
  }
}

type EffectConstructorOptions = ConstructorParameters<typeof ElementEffect>[0];

function createEffect(element: ElementKind, options: EffectConstructorOptions): ElementEffect {
  switch (element) {
    case 'earth': return new EarthEffect(options);
    case 'hydro': return new HydroEffect(options);
    case 'gale': return new GaleEffect(options);
    case 'plasma': return new PlasmaEffect(options);
    case 'nature': return new NatureEffect(options);
    case 'void': return new VoidEffect(options);
  }
}

function isCastEvent(event: ElementalVfxInput): event is CastEvent {
  return 'origin' in event;
}

function normalizeEvent(input: ElementalVfxInput, sequence: number): NormalizedEvent {
  const sourcePosition = isCastEvent(input) ? input.origin : input.position;
  const sourceTarget = input.target ?? sourcePosition;
  const team = input.team ?? 'signal';
  const intensity = THREE.MathUtils.clamp(isCastEvent(input) ? input.power : input.intensity ?? 1, 0.1, 2);
  const seed = isCastEvent(input)
    ? hashString(`${input.casterId}:${input.element}:${sequence}`)
    : input.seed ?? hashString(`${input.element}:${sequence}:${sourcePosition.x.toFixed(3)}:${sourcePosition.z.toFixed(3)}`);
  return {
    element: input.element,
    position: copyVector(sourcePosition),
    target: copyVector(sourceTarget),
    team,
    intensity,
    seed,
  };
}

/**
 * Render-only adapter for recovered elemental cast signatures.
 *
 * The manager owns a bounded active list and a bounded inactive pool. Completed
 * effects are detached from the scene and reused; dispose() releases all GPU
 * resources. Combat resolution remains in the simulation layer.
 */
export class ElementalVfxManager {
  readonly maxActive: number;

  private readonly scene: THREE.Scene;
  private readonly options: EffectConstructorOptions;
  private readonly active: ElementEffect[] = [];
  private readonly pools = new Map<ElementKind, ElementEffect[]>();
  private sequence = 0;
  private pooledCount = 0;
  private disposed = false;

  constructor(scene: THREE.Scene, options: ElementalVfxManagerOptions = {}) {
    this.scene = scene;
    this.options = {
      quality: options.quality ?? 'high',
      reducedMotion: options.reducedMotion ?? false,
      onImpact: options.onImpact,
    };
    this.maxActive = ACTIVE_CAP[this.options.quality];
  }

  emit(event: ElementalVfxInput): number;
  emit(element: ElementKind, position: Vector3Like, target?: Vector3Like): number;
  emit(eventOrElement: ElementalVfxInput | ElementKind, position?: Vector3Like, target?: Vector3Like): number {
    if (this.disposed) return -1;
    const input: ElementalVfxInput = typeof eventOrElement === 'string'
      ? { element: eventOrElement, position: position ?? { x: 0, y: 0, z: 0 }, target }
      : eventOrElement;
    this.sequence += 1;
    const normalized = normalizeEvent(input, this.sequence);

    if (this.active.length >= this.maxActive) {
      const oldest = this.active.shift();
      if (oldest) this.release(oldest);
    }

    const effect = this.acquire(normalized.element);
    effect.reset(normalized);
    this.scene.add(effect.root);
    this.active.push(effect);
    return this.sequence;
  }

  update(deltaSeconds: number): void {
    if (this.disposed || !Number.isFinite(deltaSeconds)) return;
    const step = THREE.MathUtils.clamp(deltaSeconds, 0, MAX_FRAME_DELTA);
    for (let index = this.active.length - 1; index >= 0; index -= 1) {
      const effect = this.active[index]!;
      if (!effect.update(step)) {
        this.active.splice(index, 1);
        this.release(effect);
      }
    }
  }

  clear(): void {
    for (const effect of this.active) this.release(effect);
    this.active.length = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const effect of this.active) effect.dispose();
    this.active.length = 0;
    for (const pool of this.pools.values()) {
      for (const effect of pool) effect.dispose();
      pool.length = 0;
    }
    this.pools.clear();
    this.pooledCount = 0;
  }

  get activeCount(): number {
    return this.active.length;
  }

  get pooledEffectCount(): number {
    return this.pooledCount;
  }

  private acquire(element: ElementKind): ElementEffect {
    const pool = this.pools.get(element);
    const effect = pool?.pop();
    if (effect) {
      this.pooledCount -= 1;
      return effect;
    }
    return createEffect(element, this.options);
  }

  private release(effect: ElementEffect): void {
    effect.deactivate();
    if (this.pooledCount >= this.maxActive) {
      effect.dispose();
      return;
    }
    const pool = this.pools.get(effect.element) ?? [];
    pool.push(effect);
    this.pools.set(effect.element, pool);
    this.pooledCount += 1;
  }
}

export function createElementalVfxManager(
  scene: THREE.Scene,
  options?: ElementalVfxManagerOptions,
): ElementalVfxManager {
  return new ElementalVfxManager(scene, options);
}
