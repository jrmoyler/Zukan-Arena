import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import type { QualityTier } from '../core/Settings';
import { PILLARS } from '../simulation/arena';
import { createCourtTexture } from './courtTexture';
import { ARENA_COMBAT_DEPTH, ARENA_COMBAT_WIDTH, LivingArena } from './LivingArena';

/**
 * Owns the WebGL renderer, scene, cinematic camera rig and post-processing.
 * Screens describe *where* the camera should be (presets / follow targets);
 * the rig eases there and layers trauma shake and zoom punches on top.
 */

/** Height of the court surface; every battle object stands on it. */
export const FLOOR_Y = 0.062;

export type CameraPreset = 'title' | 'menu' | 'select' | 'versus' | 'battle' | 'results';

interface CameraPose {
  target: THREE.Vector3;
  distance: number;
  pitch: number;
  yaw: number;
  fov: number;
}

const PRESETS: Record<CameraPreset, CameraPose> = {
  title: { target: new THREE.Vector3(0, 1.3, 0), distance: 10.5, pitch: 0.16, yaw: 0, fov: 36 },
  menu: { target: new THREE.Vector3(1.6, 1.15, 0.2), distance: 8.8, pitch: 0.14, yaw: -0.08, fov: 36 },
  select: { target: new THREE.Vector3(0, 1.15, 2.2), distance: 7.4, pitch: 0.12, yaw: 0, fov: 34 },
  versus: { target: new THREE.Vector3(0, 1.1, 0), distance: 11.5, pitch: 0.2, yaw: 0, fov: 34 },
  battle: { target: new THREE.Vector3(0, 0, 0.5), distance: 21.5, pitch: 0.92, yaw: 0, fov: 32 },
  results: { target: new THREE.Vector3(0, 1.1, 0), distance: 9, pitch: 0.18, yaw: 0.12, fov: 34 },
};

const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uVignette: { value: 0.32 },
    uDamage: { value: 0 },
    uDesaturate: { value: 0 },
    uAberration: { value: 0 },
    uGrain: { value: 0.025 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uVignette;
    uniform float uDamage;
    uniform float uDesaturate;
    uniform float uAberration;
    uniform float uGrain;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 centered = vUv - 0.5;
      float dist = length(centered);
      vec2 shift = centered * uAberration * 0.012;
      vec3 color = vec3(
        texture2D(tDiffuse, vUv + shift).r,
        texture2D(tDiffuse, vUv).g,
        texture2D(tDiffuse, vUv - shift).b
      );
      // Gentle filmic grade: lift shadows toward ink-blue, warm the highlights.
      float luma = dot(color, vec3(0.299, 0.587, 0.114));
      color = mix(color, color * vec3(0.94, 0.97, 1.06), (1.0 - luma) * 0.35);
      color = mix(color, color * vec3(1.04, 1.01, 0.96), luma * 0.25);
      color = mix(color, vec3(luma), uDesaturate);
      float vignette = smoothstep(0.85, 0.18, dist * (1.0 + uVignette));
      color *= mix(1.0, vignette, 0.85);
      float edge = smoothstep(0.25, 0.75, dist);
      color = mix(color, vec3(0.75, 0.05, 0.12), edge * uDamage * 0.55);
      color += (hash(vUv * 917.0 + uTime) - 0.5) * uGrain;
      gl_FragColor = vec4(color, 1.0);
    }
  `,
};

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(34, 1, 0.1, 140);
  readonly arena: LivingArena;
  readonly canvas: HTMLCanvasElement;
  tier: QualityTier;

  private composer?: EffectComposer;
  private bloom?: UnrealBloomPass;
  private grade?: ShaderPass;
  private readonly environment: THREE.Texture;
  private court?: THREE.MeshStandardMaterial;
  private readonly pillarGroup = new THREE.Group();
  private readonly pose: CameraPose = { ...PRESETS.title, target: PRESETS.title.target.clone() };
  private readonly goal: CameraPose = { ...PRESETS.title, target: PRESETS.title.target.clone() };
  private preset: CameraPreset = 'title';
  private orbit = 0;
  private trauma = 0;
  private punch = 0;
  private time = 0;
  private readonly gradeState = { damage: 0, desaturate: 0, aberration: 0 };
  private readonly gradeGoal = { damage: 0, desaturate: 0 };
  private pixelRatioScale = 1;
  private frameAccumulator = 0;
  private frameSamples = 0;
  private reducedMotion: boolean;
  shakeScale = 1;

  constructor(canvas: HTMLCanvasElement, tier: QualityTier, reducedMotion: boolean) {
    this.canvas = canvas;
    this.tier = tier;
    this.reducedMotion = reducedMotion;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: tier !== 'low',
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    const generator = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.environment = generator.fromScene(room, 0.04).texture;
    room.dispose();
    generator.dispose();
    this.scene.environment = this.environment;
    this.scene.environmentIntensity = 0.4;
    this.scene.background = new THREE.Color(0xe6dfd1);
    this.scene.fog = new THREE.Fog(0xe6dfd1, 30, 72);

    this.arena = new LivingArena({ quality: tier, castShadows: tier !== 'low' });
    this.scene.add(this.arena);
    this.dressCourt();
    this.buildPillars();
    this.applyQuality(tier);
  }

  // ---------------------------------------------------------------- quality

  applyQuality(tier: QualityTier): void {
    this.tier = tier;
    this.pixelRatioScale = 1;
    this.renderer.shadowMap.enabled = tier !== 'low';
    const key = this.arena.keyLight;
    if (key) {
      key.castShadow = tier !== 'low';
      const size = tier === 'high' ? 2048 : 1024;
      key.shadow.mapSize.set(size, size);
      key.shadow.map?.dispose();
      key.shadow.map = null;
    }
    this.composer?.dispose();
    this.composer = undefined;
    this.bloom = undefined;
    this.grade = undefined;
    if (tier !== 'low') {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), tier === 'high' ? 0.38 : 0.3, 0.5, 1.02);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
      this.grade = new ShaderPass(GRADE_SHADER);
      this.composer.addPass(this.grade);
    }
    this.resize();
  }

  /** Battle-only props (cover pillars) are hidden behind menus. */
  setPropsVisible(visible: boolean): void {
    this.pillarGroup.visible = visible;
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  // ----------------------------------------------------------------- camera

  setPreset(preset: CameraPreset, instant = false): void {
    this.preset = preset;
    const pose = PRESETS[preset];
    this.goal.target.copy(pose.target);
    this.goal.distance = pose.distance;
    this.goal.pitch = pose.pitch;
    this.goal.yaw = pose.yaw;
    this.goal.fov = pose.fov;
    if (instant) this.snap();
  }

  /** Battle follow: eases the target toward `point` within arena-aware limits. */
  follow(point: THREE.Vector3, lookAhead: THREE.Vector3): void {
    const base = PRESETS.battle.target;
    const aspect = this.camera.aspect;
    const freedom = aspect < 1.2 ? 0.75 : 0.22;
    this.goal.target.set(
      base.x + THREE.MathUtils.clamp(point.x * freedom + lookAhead.x * 0.6, -6, 6),
      0,
      base.z + THREE.MathUtils.clamp(point.z * freedom * 0.8 + lookAhead.z * 0.5, -3, 3),
    );
    this.goal.distance = PRESETS.battle.distance * (aspect < 1 ? 1.35 : aspect < 1.45 ? 1.12 : 1);
  }

  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  zoomPunch(amount: number): void {
    this.punch = Math.min(0.25, this.punch + amount);
  }

  setGrade(goal: { damage?: number; desaturate?: number }): void {
    if (goal.damage !== undefined) this.gradeGoal.damage = goal.damage;
    if (goal.desaturate !== undefined) this.gradeGoal.desaturate = goal.desaturate;
  }

  flashAberration(amount: number): void {
    this.gradeState.aberration = Math.max(this.gradeState.aberration, amount);
  }

  get cameraYaw(): number {
    return this.pose.yaw;
  }

  get cameraPitch(): number {
    return this.pose.pitch;
  }

  /** Camera right vector on the ground plane (for mirroring and screen-relative input). */
  cameraRight(target: THREE.Vector3): THREE.Vector3 {
    return target.set(Math.cos(this.pose.yaw), 0, -Math.sin(this.pose.yaw));
  }

  /** Projects a world point to CSS pixels inside the canvas. Returns false when behind the camera. */
  project(world: THREE.Vector3, out: THREE.Vector2): boolean {
    const projected = world.clone().project(this.camera);
    out.set((projected.x * 0.5 + 0.5) * this.canvas.clientWidth, (-projected.y * 0.5 + 0.5) * this.canvas.clientHeight);
    return projected.z < 1;
  }

  /** Intersects a ray through NDC coordinates with the ground plane. */
  groundFromNdc(ndc: THREE.Vector2, out: THREE.Vector3): THREE.Vector3 | null {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);
    return raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), out);
  }

  // ----------------------------------------------------------------- frame

  render(frameDelta: number): void {
    const delta = Math.min(0.1, Math.max(0, frameDelta));
    this.time += delta;
    this.updateCamera(delta);
    this.updateGrade(delta);
    this.trackPerformance(delta);
    if (this.composer) this.composer.render(delta);
    else this.renderer.render(this.scene, this.camera);
  }

  updateArena(delta: number): void {
    if (!this.reducedMotion) this.arena.update(delta, this.time);
  }

  resize = (): void => {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    const cap = this.tier === 'high' ? 2 : this.tier === 'medium' ? 1.5 : 1;
    const ratio = Math.min(window.devicePixelRatio || 1, cap) * this.pixelRatioScale;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    this.composer?.setPixelRatio(ratio);
    this.composer?.setSize(width, height);
    this.bloom?.resolution.set(width * ratio * 0.5, height * ratio * 0.5);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

  dispose(): void {
    this.composer?.dispose();
    this.court?.map?.dispose();
    this.court?.dispose();
    this.arena.dispose();
    this.pillarGroup.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        (object.material as THREE.Material).dispose();
      }
    });
    this.environment.dispose();
    this.renderer.dispose();
  }

  // --------------------------------------------------------------- private

  private snap(): void {
    this.pose.target.copy(this.goal.target);
    this.pose.distance = this.goal.distance;
    this.pose.pitch = this.goal.pitch;
    this.pose.yaw = this.goal.yaw;
    this.pose.fov = this.goal.fov;
    this.updateCamera(0);
  }

  private updateCamera(delta: number): void {
    const lambda = this.preset === 'battle' ? 3.2 : 2.4;
    this.pose.target.x = THREE.MathUtils.damp(this.pose.target.x, this.goal.target.x, lambda, delta);
    this.pose.target.y = THREE.MathUtils.damp(this.pose.target.y, this.goal.target.y, lambda, delta);
    this.pose.target.z = THREE.MathUtils.damp(this.pose.target.z, this.goal.target.z, lambda, delta);
    this.pose.distance = THREE.MathUtils.damp(this.pose.distance, this.goal.distance, 2.2, delta);
    this.pose.pitch = THREE.MathUtils.damp(this.pose.pitch, this.goal.pitch, 2.2, delta);
    this.pose.fov = THREE.MathUtils.damp(this.pose.fov, this.goal.fov, 2.2, delta);
    this.orbit += delta;
    const drift = this.reducedMotion || this.preset === 'battle' ? 0 : Math.sin(this.orbit * 0.12) * 0.12;
    this.pose.yaw = THREE.MathUtils.damp(this.pose.yaw, this.goal.yaw + drift, 2.2, delta);

    this.trauma = Math.max(0, this.trauma - delta * 1.6);
    this.punch = THREE.MathUtils.damp(this.punch, 0, 6, delta);
    const shake = this.reducedMotion ? 0 : this.trauma * this.trauma * this.shakeScale;
    const t = this.time * 38;
    const offsetX = shake * 0.45 * (Math.sin(t * 1.1) + Math.sin(t * 2.3) * 0.5);
    const offsetY = shake * 0.35 * (Math.sin(t * 1.7 + 1.3) + Math.sin(t * 3.1) * 0.5);
    const roll = shake * 0.025 * Math.sin(t * 1.3 + 2.1);

    const distance = this.pose.distance * (1 - this.punch);
    const cosPitch = Math.cos(this.pose.pitch);
    this.camera.position.set(
      this.pose.target.x + Math.sin(this.pose.yaw) * cosPitch * distance + offsetX,
      this.pose.target.y + Math.sin(this.pose.pitch) * distance + offsetY,
      this.pose.target.z + Math.cos(this.pose.yaw) * cosPitch * distance,
    );
    this.camera.lookAt(this.pose.target);
    this.camera.rotateZ(roll);
    if (Math.abs(this.camera.fov - this.pose.fov) > 0.01) {
      this.camera.fov = this.pose.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private updateGrade(delta: number): void {
    const state = this.gradeState;
    state.damage = THREE.MathUtils.damp(state.damage, this.gradeGoal.damage, 4, delta);
    state.desaturate = THREE.MathUtils.damp(state.desaturate, this.gradeGoal.desaturate, 2.5, delta);
    state.aberration = Math.max(0, state.aberration - delta * 3);
    if (!this.grade) return;
    const uniforms = this.grade.uniforms as typeof GRADE_SHADER.uniforms;
    uniforms.uTime.value = this.time % 100;
    uniforms.uDamage.value = state.damage;
    uniforms.uDesaturate.value = state.desaturate;
    uniforms.uAberration.value = this.reducedMotion ? 0 : state.aberration;
  }

  /** Lowers internal resolution when frames run long; recovers when headroom returns. */
  private trackPerformance(delta: number): void {
    this.frameAccumulator += delta;
    this.frameSamples += 1;
    if (this.frameAccumulator < 2.5) return;
    const average = this.frameAccumulator / this.frameSamples;
    this.frameAccumulator = 0;
    this.frameSamples = 0;
    const previous = this.pixelRatioScale;
    if (average > 1 / 42 && this.pixelRatioScale > 0.6) this.pixelRatioScale -= 0.1;
    else if (average < 1 / 58 && this.pixelRatioScale < 1) this.pixelRatioScale = Math.min(1, this.pixelRatioScale + 0.05);
    if (previous !== this.pixelRatioScale) this.resize();
  }

  /** Replaces the generic traction surface with the painted court. */
  private dressCourt(): void {
    if (typeof document === 'undefined') return;
    const surface = this.arena.combatSurface;
    const court = new THREE.MeshStandardMaterial({
      map: createCourtTexture(ARENA_COMBAT_WIDTH, ARENA_COMBAT_DEPTH),
      roughness: 0.38,
      metalness: 0.08,
      envMapIntensity: 0.9,
    });
    const box = surface.geometry;
    // BoxGeometry face order: +x, -x, +y, -y, +z, -z. Only the top shows the court.
    box.clearGroups();
    box.addGroup(0, 12, 1);
    box.addGroup(12, 6, 0);
    box.addGroup(18, 18, 1);
    (surface as THREE.Mesh).material = [court, surface.material];
    this.court = court;
    // The painted court carries its own centre line and spawn markings.
    for (const name of ['centre-inlay', 'signal-spawn-inlay', 'rift-spawn-inlay']) {
      const inlay = this.arena.getObjectByName(name);
      if (inlay) inlay.visible = false;
    }
  }

  private buildPillars(): void {
    const porcelain = new THREE.MeshPhysicalMaterial({
      color: 0xd8d0c0,
      roughness: 0.5,
      clearcoat: 0.3,
      clearcoatRoughness: 0.35,
    });
    const gold = new THREE.MeshStandardMaterial({ color: 0xd9b26a, metalness: 0.9, roughness: 0.28 });
    const ink = new THREE.MeshStandardMaterial({ color: 0x2a3350, roughness: 0.4, metalness: 0.3 });
    const base = new THREE.CylinderGeometry(0.74, 0.8, 0.22, 40);
    const shaft = new THREE.CylinderGeometry(0.5, 0.56, 1.0, 24, 1);
    const band = new THREE.TorusGeometry(0.53, 0.035, 10, 48);
    const cap = new THREE.CylinderGeometry(0.66, 0.54, 0.18, 40);
    const gem = new THREE.OctahedronGeometry(0.16, 0);
    for (const pillar of PILLARS) {
      const group = new THREE.Group();
      group.position.set(pillar.x, FLOOR_Y, pillar.z);
      const parts: THREE.Mesh[] = [
        new THREE.Mesh(base, ink),
        new THREE.Mesh(shaft, porcelain),
        new THREE.Mesh(band, gold),
        new THREE.Mesh(band, gold),
        new THREE.Mesh(cap, porcelain),
        new THREE.Mesh(gem, gold),
      ];
      parts[0]!.position.y = 0.11;
      parts[1]!.position.y = 0.72;
      parts[2]!.position.y = 0.32;
      parts[2]!.rotation.x = Math.PI / 2;
      parts[3]!.position.y = 1.14;
      parts[3]!.rotation.x = Math.PI / 2;
      parts[4]!.position.y = 1.31;
      parts[5]!.position.y = 1.6;
      for (const part of parts) {
        part.castShadow = true;
        part.receiveShadow = true;
        group.add(part);
      }
      group.userData.gem = parts[5];
      this.pillarGroup.add(group);
    }
    this.pillarGroup.visible = false;
    this.scene.add(this.pillarGroup);
  }

  /** Spins pillar gems; called every frame. */
  animateProps(delta: number): void {
    for (const group of this.pillarGroup.children) {
      const gem = group.userData.gem as THREE.Object3D | undefined;
      if (gem) {
        gem.rotation.y += delta * 0.8;
        gem.position.y = 1.6 + Math.sin(this.time * 1.6 + group.position.x) * 0.05;
      }
    }
  }
}
