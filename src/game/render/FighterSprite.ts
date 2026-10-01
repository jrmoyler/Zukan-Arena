import * as THREE from 'three';

import { ART_FACING, FLOATERS } from '../data/artDirection';
import { cutoutUrl } from '../data/assets';
import cutouts from '../data/cutouts.json';
import { ELEMENT_HEX } from '../data/kits';
import { teamColor } from '../data/palette';
import type { FighterDefinition, TeamKind } from '../types';
import { shadowTexture, sparkleTexture } from './textures';

/**
 * HD-2D fighter: the segmented Zukan artwork staged as a paper-craft cutout in
 * the 3D arena. All motion is procedural — breathing, hop cycles, squash and
 * stretch, paper-turn mirroring, hit wobble, dash afterimages and a dissolve
 * knockout — driven by a custom shader with outline, flash and fog support.
 */

export type SpriteQuality = 'high' | 'medium' | 'low';

interface CutoutMeta {
  w: number;
  h: number;
  footX: number;
  footY: number;
  palette: string[];
}

const META = cutouts as Record<string, CutoutMeta>;
const MARGIN = 0.06;
const BASE_HEIGHT = 1.95;

// ----------------------------------------------------------- texture cache

const textureCache = new Map<string, Promise<THREE.Texture>>();
const loader = new THREE.TextureLoader();

export function loadCutout(fighterId: string): Promise<THREE.Texture> {
  const cached = textureCache.get(fighterId);
  if (cached) return cached;
  const promise = new Promise<THREE.Texture>((resolve, reject) => {
    loader.load(
      cutoutUrl(fighterId),
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        resolve(texture);
      },
      undefined,
      () => reject(new Error(`Failed to load cutout for ${fighterId}`)),
    );
  });
  textureCache.set(fighterId, promise);
  promise.catch(() => textureCache.delete(fighterId));
  return promise;
}

/** Loads every listed cutout, reporting progress 0..1. Failures do not reject. */
export async function preloadCutouts(ids: readonly string[], onProgress?: (fraction: number) => void): Promise<void> {
  let done = 0;
  await Promise.all(ids.map(async (id) => {
    try {
      await loadCutout(id);
    } catch {
      // A missing sprite falls back to its silhouette placeholder.
    }
    done += 1;
    onProgress?.(done / ids.length);
  }));
}

export function disposeCutoutCache(): void {
  for (const promise of textureCache.values()) void promise.then((texture) => texture.dispose(), () => undefined);
  textureCache.clear();
}

export function spriteDimensions(fighterId: string, scale = 1): { width: number; height: number } {
  const meta = META[fighterId] ?? { w: 1, h: 1 };
  const aspect = meta.w / meta.h;
  const height = THREE.MathUtils.clamp(BASE_HEIGHT / Math.sqrt(Math.max(0.55, aspect)), 1.2, 2.1) * scale;
  return { width: height * aspect, height };
}

// ---------------------------------------------------------------- shaders

const SPRITE_VERTEX = /* glsl */ `
  uniform float uLean;
  uniform float uWobble;
  uniform float uTime;
  uniform float uHeight;
  varying vec2 vUv;
  #include <common>
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vec3 p = position;
    float h = clamp(p.y / uHeight, 0.0, 1.2);
    p.x += uLean * h * h * uHeight;
    p.x += sin(uTime * 22.0 + h * 5.0) * uWobble * h * 0.07 * uHeight;
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const SPRITE_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform float uReady;
  uniform vec2 uTexel;
  uniform vec3 uOutlineColor;
  uniform float uOutline;
  uniform vec3 uFlashColor;
  uniform float uFlash;
  uniform vec3 uTint;
  uniform float uTintAmount;
  uniform float uDissolve;
  uniform vec3 uDissolveColor;
  uniform float uOpacity;
  uniform float uLight;
  varying vec2 vUv;
  #include <common>
  #include <fog_pars_fragment>

  float alphaAt(vec2 uv) {
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
    return texture2D(map, uv).a;
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
    float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
    float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
    float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  void main() {
    bool inside = vUv.x >= 0.0 && vUv.y >= 0.0 && vUv.x <= 1.0 && vUv.y <= 1.0;
    vec4 tex = inside ? texture2D(map, vUv) : vec4(0.0);
    // Placeholder silhouette until the texture streams in.
    if (uReady < 0.5) tex = vec4(0.0);
    float alpha = tex.a;

    float outline = 0.0;
    if (uOutline > 0.0 && uReady > 0.5) {
      vec2 o = uTexel * 2.6;
      outline = max(outline, alphaAt(vUv + vec2(o.x, 0.0)));
      outline = max(outline, alphaAt(vUv - vec2(o.x, 0.0)));
      outline = max(outline, alphaAt(vUv + vec2(0.0, o.y)));
      outline = max(outline, alphaAt(vUv - vec2(0.0, o.y)));
      outline = max(outline, alphaAt(vUv + o * 0.7071));
      outline = max(outline, alphaAt(vUv - o * 0.7071));
      outline = max(outline, alphaAt(vUv + vec2(o.x, -o.y) * 0.7071));
      outline = max(outline, alphaAt(vUv + vec2(-o.x, o.y) * 0.7071));
      outline = clamp(outline - alpha, 0.0, 1.0) * uOutline;
    }

    vec3 color = tex.rgb * uLight;
    // Contact occlusion grounds the cutout on the arena floor.
    color *= mix(0.74, 1.0, smoothstep(0.0, 0.17, vUv.y));
    color = mix(color, uTint, uTintAmount);
    color = mix(color, uFlashColor, uFlash);

    float glow = 0.0;
    if (uDissolve > 0.0) {
      float n = valueNoise(vUv * 18.0) * 0.65 + valueNoise(vUv * 41.0) * 0.35;
      float threshold = uDissolve * 1.12;
      if (n < threshold - 0.06) alpha = 0.0;
      glow = (1.0 - smoothstep(threshold - 0.06, threshold + 0.04, n)) * step(0.01, alpha);
      outline *= 1.0 - uDissolve;
    }
    color = mix(color, uDissolveColor * 2.4, glow);

    float total = max(alpha, outline);
    vec3 finalColor = mix(uOutlineColor, color, alpha / max(total, 1e-4));
    gl_FragColor = vec4(finalColor, total * uOpacity);
    if (gl_FragColor.a < 0.012) discard;
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

const RING_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uPlayer;
  uniform float uAim;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float angle = atan(p.y, p.x);
    float ring = smoothstep(0.7, 0.76, r) * (1.0 - smoothstep(0.86, 0.92, r));
    float dashes = step(0.5, fract(angle * 3.0 / 3.14159 + uTime * 0.25));
    float inner = smoothstep(0.55, 0.62, r) * (1.0 - smoothstep(0.64, 0.7, r)) * dashes * 0.55;
    float glow = exp(-pow((r - 0.8) * 5.0, 2.0)) * 0.35;
    float alpha = ring * 0.9 + inner + glow;
    if (uPlayer > 0.5) {
      float d = abs(atan(sin(angle - uAim), cos(angle - uAim)));
      float chevron = (1.0 - smoothstep(0.22, 0.3, d)) * smoothstep(0.9, 0.95, r) * (1.0 - smoothstep(1.0, 1.0, r));
      float tip = (1.0 - smoothstep(0.0, 0.16, d)) * smoothstep(0.92, 0.97, r);
      alpha += chevron * 0.9 + tip;
    }
    gl_FragColor = vec4(uColor * 1.4, clamp(alpha, 0.0, 1.0) * uOpacity);
    if (gl_FragColor.a < 0.01) discard;
  }
`;

const RING_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// ---------------------------------------------------------------- sprite

type Pose = 'idle' | 'cast' | 'dash' | 'ko' | 'victory' | 'spawn';

export interface FighterSpriteOptions {
  quality: SpriteQuality;
  team?: TeamKind;
  isPlayer?: boolean;
  scale?: number;
  showRing?: boolean;
  colorSafe?: boolean;
  reducedMotion?: boolean;
}

interface Ghost {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  life: number;
}

const ringGeometry = new THREE.PlaneGeometry(1, 1);
const shadowGeometry = new THREE.PlaneGeometry(1, 1);

export class FighterSprite {
  readonly root = new THREE.Group();
  readonly fighter: FighterDefinition;
  readonly width: number;
  readonly height: number;

  private readonly body = new THREE.Group();
  private readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly material: THREE.ShaderMaterial;
  private readonly depthMaterial?: THREE.MeshDepthMaterial;
  private readonly ring: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly ghosts: Ghost[] = [];
  private stars?: THREE.Group;
  private readonly floater: boolean;
  private readonly artFacing: number;
  private readonly reducedMotion: boolean;
  private readonly elementColor: THREE.Color;
  private disposed = false;

  private time = Math.random() * 10;
  private pose: Pose = 'idle';
  private poseTime = 0;
  private move = 0;
  private moveTarget = 0;
  private leanTarget = 0;
  private lean = 0;
  private hopPhase = 0;
  private facing = 1;
  private flip = 1;
  private flash = 0;
  private wobble = 0;
  private kick = 0;
  private tilt = 0;
  private stunned = false;
  private invulnerable = false;
  private ghostTimer = 0;
  private koDirection = 1;

  constructor(fighter: FighterDefinition, options: FighterSpriteOptions) {
    this.fighter = fighter;
    this.reducedMotion = options.reducedMotion ?? false;
    const scale = options.scale ?? 1;
    const { width, height } = spriteDimensions(fighter.id, scale);
    this.width = width;
    this.height = height;
    this.floater = FLOATERS.has(fighter.index) || fighter.archetype === 'avian' || fighter.archetype === 'swarm';
    this.artFacing = ART_FACING[fighter.index] ?? 1;
    this.elementColor = new THREE.Color(ELEMENT_HEX[fighter.element]);

    const meta = META[fighter.id] ?? { w: 512, h: 640, footX: 0.5, footY: 0.97, palette: [] };
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          map: { value: null },
          uReady: { value: 0 },
          uTexel: { value: new THREE.Vector2(1 / meta.w, 1 / meta.h) },
          uOutlineColor: { value: new THREE.Color(0xffffff) },
          uOutline: { value: 0 },
          uFlashColor: { value: new THREE.Color(0xffffff) },
          uFlash: { value: 0 },
          uTint: { value: new THREE.Color(0xffffff) },
          uTintAmount: { value: 0 },
          uDissolve: { value: 0 },
          uDissolveColor: { value: this.elementColor.clone() },
          uOpacity: { value: 1 },
          uLight: { value: 1.04 },
          uLean: { value: 0 },
          uWobble: { value: 0 },
          uTime: { value: 0 },
          uHeight: { value: height },
        },
      ]),
      vertexShader: SPRITE_VERTEX,
      fragmentShader: SPRITE_FRAGMENT,
      transparent: true,
      depthWrite: true,
      fog: true,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(buildSpriteGeometry(meta, width, height), this.material);
    this.mesh.name = `Sprite_${fighter.id}`;
    this.mesh.renderOrder = 5;
    this.mesh.frustumCulled = false;
    if (options.quality !== 'low') {
      this.depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, alphaTest: 0.5 });
      this.mesh.customDepthMaterial = this.depthMaterial;
      this.mesh.castShadow = true;
    }
    this.body.add(this.mesh);
    this.root.add(this.body);
    this.root.name = `Fighter_${fighter.id}`;
    this.root.userData.fighterId = fighter.id;

    this.shadow = new THREE.Mesh(
      shadowGeometry,
      new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.9 }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.012;
    this.shadow.scale.set(Math.min(width, 2.4) * 0.78, Math.min(width, 2.4) * 0.42, 1);
    this.shadow.renderOrder = 1;
    this.root.add(this.shadow);

    this.ring = new THREE.Mesh(
      ringGeometry,
      new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(0xffffff) },
          uTime: { value: 0 },
          uPlayer: { value: options.isPlayer ? 1 : 0 },
          uAim: { value: 0 },
          uOpacity: { value: 1 },
        },
        vertexShader: RING_VERTEX,
        fragmentShader: RING_FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.02;
    const ringSize = (options.isPlayer ? 1.75 : 1.5) * Math.max(1, scale * 0.85);
    this.ring.scale.set(ringSize, ringSize, 1);
    this.ring.renderOrder = 2;
    this.ring.visible = options.showRing ?? Boolean(options.team);
    this.root.add(this.ring);
    if (options.team) this.setTeam(options.team, options.isPlayer ?? false, options.colorSafe ?? false);

    void loadCutout(fighter.id).then((texture) => {
      if (this.disposed) return;
      this.material.uniforms.map!.value = texture;
      this.material.uniforms.uReady!.value = 1;
      if (this.depthMaterial) {
        this.depthMaterial.map = texture;
        this.depthMaterial.needsUpdate = true;
      }
    }, () => undefined);
    this.trigger('spawn');
  }

  setTeam(team: TeamKind, isPlayer: boolean, colorSafe: boolean): void {
    const color = new THREE.Color(teamColor(team, colorSafe));
    this.ring.material.uniforms.uColor!.value.copy(color);
    this.ring.material.uniforms.uPlayer!.value = isPlayer ? 1 : 0;
    this.material.uniforms.uOutlineColor!.value.copy(color).lerp(new THREE.Color(0xffffff), 0.25);
    this.material.uniforms.uOutline!.value = isPlayer ? 0.95 : 0.75;
    this.ring.visible = true;
  }

  /** Outline-only highlight for menus (no team ring). */
  setHighlight(color: THREE.ColorRepresentation, strength: number): void {
    this.material.uniforms.uOutlineColor!.value.set(color);
    this.material.uniforms.uOutline!.value = strength;
  }

  /** Locomotion intent: `speed` 0..1 and screen-space horizontal direction. */
  setMotion(speed: number, screenX: number): void {
    this.moveTarget = THREE.MathUtils.clamp(speed, 0, 1);
    this.leanTarget = THREE.MathUtils.clamp(screenX, -1, 1) * this.moveTarget;
  }

  /** Faces the creature toward screen-left (<0) or screen-right (>0). */
  setFacing(screenX: number): void {
    if (Math.abs(screenX) > 0.18) this.facing = Math.sign(screenX);
  }

  /** Aim angle (radians, ground plane, atan2(z, x)) for the player chevron. */
  setAim(angle: number): void {
    this.ring.material.uniforms.uAim!.value = -angle;
  }

  setStatus(status: { stunned: boolean; invulnerable: boolean; slowed: boolean; rooted: boolean }): void {
    this.stunned = status.stunned;
    this.invulnerable = status.invulnerable;
    const tint = this.material.uniforms.uTint!.value as THREE.Color;
    let amount = 0;
    if (status.rooted) {
      tint.set(0x5fd068);
      amount = 0.22;
    } else if (status.slowed) {
      tint.set(0x6fb8ff);
      amount = 0.18;
    }
    if (this.pose !== 'cast') this.material.uniforms.uTintAmount!.value = amount;
    if (this.stunned && !this.stars) this.createStars();
    if (this.stars) this.stars.visible = this.stunned;
  }

  trigger(event: 'cast' | 'hit' | 'heavyHit' | 'dash' | 'ko' | 'victory' | 'spawn' | 'heal', direction = 0): void {
    switch (event) {
      case 'hit':
      case 'heavyHit':
        this.flash = event === 'heavyHit' ? 1 : 0.75;
        this.wobble = this.reducedMotion ? 0 : event === 'heavyHit' ? 1 : 0.55;
        this.kick = (direction || (Math.random() > 0.5 ? 1 : -1)) * (event === 'heavyHit' ? 0.2 : 0.11);
        this.material.uniforms.uFlashColor!.value.set(0xffffff);
        return;
      case 'heal':
        this.flash = 0.45;
        this.material.uniforms.uFlashColor!.value.set(0x9dffb4);
        return;
      case 'ko':
        this.pose = 'ko';
        this.koDirection = direction || -this.facing;
        this.flash = 1;
        this.material.uniforms.uFlashColor!.value.set(0xffffff);
        break;
      default:
        if (this.pose === 'ko' && event !== 'spawn') return;
        this.pose = event;
    }
    this.poseTime = 0;
  }

  /** World-space point above the head for nameplates. */
  headPosition(target: THREE.Vector3): THREE.Vector3 {
    return target.copy(this.root.position).setY(this.root.position.y + this.height * 0.96 + (this.floater ? 0.3 : 0) + 0.18);
  }

  /** World-space chest point where bolts and casts originate. */
  chestPosition(target: THREE.Vector3): THREE.Vector3 {
    return target.copy(this.root.position).setY(this.root.position.y + this.height * 0.5 + (this.floater ? 0.3 : 0));
  }

  update(delta: number, cameraYaw: number, cameraPitch: number): void {
    const dt = Math.min(delta, 0.05);
    this.time += dt;
    this.poseTime += dt;
    const motion = this.reducedMotion ? 0.35 : 1;

    this.root.rotation.y = cameraYaw;
    this.body.rotation.x = -cameraPitch * 0.42;

    this.move = THREE.MathUtils.damp(this.move, this.moveTarget, 10, dt);
    this.lean = THREE.MathUtils.damp(this.lean, this.leanTarget, 8, dt);
    this.flip = THREE.MathUtils.damp(this.flip, this.facing * this.artFacing, 16, dt);
    this.flash = Math.max(0, this.flash - dt * 4.2);
    this.wobble = Math.max(0, this.wobble - dt * 2.6);
    this.kick = THREE.MathUtils.damp(this.kick, 0, 7, dt);

    let squashX = 1;
    let squashY = 1;
    let lift = 0;
    let leanShader = -this.lean * 0.1 * motion;
    let tiltTarget = this.kick;
    let opacity = 1;
    let dissolve = 0;
    let tintAmount = this.material.uniforms.uTintAmount!.value as number;

    // Idle breathing.
    const breath = Math.sin(this.time * 2.3) * 0.022 * motion;
    squashY += breath;
    squashX -= breath * 0.6;

    if (this.floater) {
      lift = 0.32 + Math.sin(this.time * 2.1) * 0.08 * motion;
      tiltTarget += Math.sin(this.time * 1.4) * 0.03 * motion - this.lean * 0.08;
    } else if (this.move > 0.02) {
      this.hopPhase += dt * (9 + this.move * 3);
      const hop = Math.abs(Math.sin(this.hopPhase));
      lift = hop * 0.14 * this.move * motion;
      const contact = Math.pow(1 - hop, 6);
      squashY -= contact * 0.09 * this.move * motion;
      squashX += contact * 0.07 * this.move * motion;
      tiltTarget += Math.sin(this.hopPhase) * 0.035 * this.move * motion;
    }

    switch (this.pose) {
      case 'spawn': {
        const t = Math.min(1, this.poseTime / 0.55);
        const pop = t < 0.6 ? THREE.MathUtils.smootherstep(t / 0.6, 0, 1) * 1.12 : 1.12 - (t - 0.6) / 0.4 * 0.12;
        squashX *= pop;
        squashY *= pop;
        dissolve = 1 - THREE.MathUtils.smoothstep(t, 0, 0.7);
        if (t >= 1) this.pose = 'idle';
        break;
      }
      case 'cast': {
        const t = this.poseTime;
        if (t < 0.12) {
          const k = t / 0.12;
          squashY *= 1 - 0.12 * k;
          squashX *= 1 + 0.1 * k;
        } else if (t < 0.32) {
          const k = (t - 0.12) / 0.2;
          squashY *= 0.88 + 0.26 * Math.sin(k * Math.PI);
          squashX *= 1.1 - 0.16 * Math.sin(k * Math.PI);
          leanShader += this.facing * 0.12 * Math.sin(k * Math.PI) * motion;
          lift += 0.08 * Math.sin(k * Math.PI);
        } else if (t > 0.5) {
          this.pose = 'idle';
        }
        const glow = Math.max(0, 1 - Math.abs(t - 0.2) / 0.3);
        this.material.uniforms.uTint!.value.copy(this.elementColor);
        tintAmount = glow * 0.35;
        break;
      }
      case 'dash': {
        const t = this.poseTime;
        squashX *= 1.22;
        squashY *= 0.84;
        leanShader += this.facing * 0.25 * motion;
        opacity = 0.7;
        this.ghostTimer -= dt;
        if (this.ghostTimer <= 0 && !this.reducedMotion) {
          this.ghostTimer = 0.04;
          this.spawnGhost();
        }
        if (t > 0.22) this.pose = 'idle';
        break;
      }
      case 'victory': {
        const cycle = (this.poseTime % 0.9) / 0.9;
        const jump = cycle < 0.5 ? Math.sin((cycle / 0.5) * Math.PI) : 0;
        lift += jump * 0.45 * motion;
        squashY *= 1 + jump * 0.08 - (cycle > 0.5 && cycle < 0.6 ? 0.08 : 0);
        break;
      }
      case 'ko': {
        const t = this.poseTime;
        tiltTarget = this.koDirection * Math.min(1.35, t * 4.5);
        lift += Math.sin(Math.min(1, t / 0.5) * Math.PI) * 0.3;
        dissolve = THREE.MathUtils.smoothstep(t, 0.35, 1.25);
        squashY *= 1 - Math.min(0.15, t * 0.2);
        break;
      }
      default:
        break;
    }

    if (this.stunned) {
      tiltTarget += Math.sin(this.time * 9) * 0.06;
      if (this.stars) {
        this.stars.rotation.y += dt * 4;
        this.stars.position.y = this.height * 0.98 + lift;
      }
    }
    if (this.invulnerable && this.pose !== 'dash') opacity *= 0.6 + Math.sin(this.time * 40) * 0.15;

    this.tilt = THREE.MathUtils.damp(this.tilt, tiltTarget, 14, dt);
    this.body.position.y = lift;
    this.body.rotation.z = this.tilt * -1;
    this.body.scale.set(squashX * this.flip, squashY, 1);

    const uniforms = this.material.uniforms;
    uniforms.uTime!.value = this.time;
    uniforms.uLean!.value = leanShader;
    uniforms.uWobble!.value = this.wobble;
    uniforms.uFlash!.value = this.flash;
    uniforms.uOpacity!.value = opacity;
    uniforms.uDissolve!.value = dissolve;
    uniforms.uTintAmount!.value = tintAmount;

    const ringUniforms = this.ring.material.uniforms;
    ringUniforms.uTime!.value = this.time;
    ringUniforms.uOpacity!.value = this.pose === 'ko' ? Math.max(0, 1 - this.poseTime * 2) : 1;
    const shadowScale = 1 - Math.min(0.45, lift * 0.6);
    this.shadow.material.opacity = (this.pose === 'ko' ? Math.max(0, 1 - this.poseTime) : 0.9) * shadowScale;

    this.updateGhosts(dt);
  }

  dispose(): void {
    this.disposed = true;
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.depthMaterial?.dispose();
    this.ring.material.dispose();
    this.shadow.material.dispose();
    for (const ghost of this.ghosts) {
      ghost.mesh.material.dispose();
      ghost.mesh.removeFromParent();
    }
    this.stars?.traverse((object) => {
      if (object instanceof THREE.Sprite) object.material.dispose();
    });
    this.root.removeFromParent();
  }

  private spawnGhost(): void {
    const parent = this.root.parent;
    if (!parent) return;
    let ghost = this.ghosts.find(({ life }) => life <= 0);
    if (!ghost) {
      if (this.ghosts.length >= 6) return;
      const material = this.material.clone();
      material.depthWrite = false;
      const mesh = new THREE.Mesh(this.mesh.geometry, material);
      mesh.renderOrder = 4;
      mesh.frustumCulled = false;
      ghost = { mesh, life: 0 };
      this.ghosts.push(ghost);
    }
    const uniforms = ghost.mesh.material.uniforms;
    uniforms.map!.value = this.material.uniforms.map!.value;
    uniforms.uReady!.value = this.material.uniforms.uReady!.value;
    uniforms.uTint!.value.copy(this.elementColor);
    uniforms.uTintAmount!.value = 0.75;
    uniforms.uOutline!.value = 0;
    this.mesh.updateWorldMatrix(true, false);
    ghost.mesh.matrixAutoUpdate = false;
    ghost.mesh.matrix.copy(this.mesh.matrixWorld);
    ghost.life = 0.28;
    parent.add(ghost.mesh);
  }

  private updateGhosts(dt: number): void {
    for (const ghost of this.ghosts) {
      if (ghost.life <= 0) continue;
      ghost.life -= dt;
      ghost.mesh.material.uniforms.uOpacity!.value = Math.max(0, ghost.life / 0.28) * 0.45;
      if (ghost.life <= 0) ghost.mesh.removeFromParent();
    }
  }

  private createStars(): void {
    this.stars = new THREE.Group();
    for (let index = 0; index < 3; index += 1) {
      const star = new THREE.Sprite(new THREE.SpriteMaterial({
        map: sparkleTexture(),
        color: 0xffe28a,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      const angle = (index / 3) * Math.PI * 2;
      star.position.set(Math.cos(angle) * 0.42, 0, Math.sin(angle) * 0.42);
      star.scale.setScalar(0.32);
      this.stars.add(star);
    }
    this.root.add(this.stars);
  }
}

/** Builds a subdivided quad whose origin sits at the creature's foot anchor,
 * with a transparent margin so the shader outline never clips. */
function buildSpriteGeometry(meta: { footX: number; footY: number }, width: number, height: number): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(1, 1, 1, 10);
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const footU = meta.footX;
  const footV = 1 - meta.footY;
  for (let index = 0; index < position.count; index += 1) {
    const u = (position.getX(index) + 0.5) * (1 + MARGIN * 2) - MARGIN;
    const v = (position.getY(index) + 0.5) * (1 + MARGIN * 2) - MARGIN;
    position.setXYZ(index, (u - footU) * width, (v - footV) * height, 0);
    uv.setXY(index, u, v);
  }
  position.needsUpdate = true;
  uv.needsUpdate = true;
  geometry.computeBoundingSphere();
  return geometry;
}
