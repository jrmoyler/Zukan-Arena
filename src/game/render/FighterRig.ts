import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ElementKind, FighterDefinition, RigArchetype, TeamKind } from '../types';
import { createNyxaluneZukanFighterRigFamilyModel } from './generated/createNyxaluneModel';

export type FighterAnimation = 'idle' | 'run' | 'cast' | 'hit' | 'ko';

interface BonePlan {
  name: string;
  parent: number;
  position: THREE.Vector3;
}

interface VolumePart {
  bone: number;
  geometry: THREE.BufferGeometry;
  position: THREE.Vector3;
  scale: THREE.Vector3;
  rotation?: THREE.Euler;
}

interface RigPlan {
  bones: BonePlan[];
  parts: VolumePart[];
  eyeHeight: number;
  radius: number;
}

export interface FighterRigRuntime {
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  skeleton: THREE.Skeleton;
  skinnedMesh: THREE.SkinnedMesh;
  sockets: ReadonlyMap<string, THREE.Object3D>;
  colliders: readonly { bone: string; radius: number; offset: THREE.Vector3 }[];
  play(animation: FighterAnimation, once?: boolean): void;
  update(delta: number): void;
  setTeam(team: TeamKind): void;
  dispose(): void;
}

export async function disposeFighterTextureCache(): Promise<void> {
  const textures = await Promise.all(textureCache.values());
  for (const texture of new Set(textures)) texture.dispose();
  textureCache.clear();
}

const ELEMENT_PALETTE: Record<ElementKind, [number, number, number]> = {
  earth: [0xb98a50, 0xf2d3a0, 0x6b4934],
  hydro: [0x55cde3, 0x194da8, 0xe9fbff],
  gale: [0xc6e9e3, 0x5f88c9, 0xf6e6ff],
  plasma: [0xf3cf45, 0x663cbd, 0xff6978],
  nature: [0x6fc66b, 0x2f7255, 0xf4cf82],
  void: [0x9c75e6, 0x201b52, 0xf576b3],
};

const textureCache = new Map<string, Promise<THREE.CanvasTexture>>();

function elementTexture(fighter: FighterDefinition): Promise<THREE.CanvasTexture> {
  const existing = textureCache.get(fighter.id);
  if (existing) return existing;
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    const [primary, secondary] = ELEMENT_PALETTE[fighter.element];
    const data = new Uint8Array([
      (primary >> 16) & 255, (primary >> 8) & 255, primary & 255, 255,
      (secondary >> 16) & 255, (secondary >> 8) & 255, secondary & 255, 255,
      (secondary >> 16) & 255, (secondary >> 8) & 255, secondary & 255, 255,
      (primary >> 16) & 255, (primary >> 8) & 255, primary & 255, 255,
    ]);
    const fallback = new THREE.DataTexture(data, 2, 2, THREE.RGBAFormat);
    fallback.colorSpace = THREE.SRGBColorSpace;
    fallback.needsUpdate = true;
    const promise = Promise.resolve(fallback as unknown as THREE.CanvasTexture);
    textureCache.set(fighter.id, promise);
    return promise;
  }
  const promise = new Promise<THREE.CanvasTexture>((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      const size = 1024;
      const source = document.createElement('canvas');
      source.width = image.naturalWidth;
      source.height = image.naturalHeight;
      const sourceContext = source.getContext('2d', { willReadFrequently: true });
      const target = document.createElement('canvas');
      target.width = size;
      target.height = size;
      const context = target.getContext('2d');
      if (!sourceContext || !context) {
        resolve(new THREE.CanvasTexture(target));
        return;
      }
      sourceContext.drawImage(image, 0, 0);
      const sourceImage = sourceContext.getImageData(0, 0, image.naturalWidth, image.naturalHeight);
      const cornerCoordinates = [
        [2, 2], [Math.max(0, image.naturalWidth - 3), 2],
        [2, Math.max(0, image.naturalHeight - 3)],
        [Math.max(0, image.naturalWidth - 3), Math.max(0, image.naturalHeight - 3)],
      ] as const;
      const cornerColors = cornerCoordinates.map(([cornerX, cornerY]) => {
        const offset = (cornerY * image.naturalWidth + cornerX) * 4;
        return [sourceImage.data[offset] ?? 0, sourceImage.data[offset + 1] ?? 0, sourceImage.data[offset + 2] ?? 0] as const;
      });
      for (let y = 0; y < image.naturalHeight; y += 1) {
        for (let x = 0; x < image.naturalWidth; x += 1) {
          const offset = (y * image.naturalWidth + x) * 4;
          const red = sourceImage.data[offset] ?? 0;
          const green = sourceImage.data[offset + 1] ?? 0;
          const blue = sourceImage.data[offset + 2] ?? 0;
          const colorDistance = Math.min(...cornerColors.map(([cornerRed, cornerGreen, cornerBlue]) =>
            Math.hypot(red - cornerRed, green - cornerGreen, blue - cornerBlue)));
          const edgeDistance = Math.min(x, y, image.naturalWidth - 1 - x, image.naturalHeight - 1 - y);
          const edgeConfidence = THREE.MathUtils.smoothstep(edgeDistance, 0, Math.min(image.naturalWidth, image.naturalHeight) * 0.12);
          const subjectConfidence = THREE.MathUtils.smoothstep(colorDistance, 26, 92);
          sourceImage.data[offset + 3] = Math.round(255 * Math.max(subjectConfidence, edgeConfidence * subjectConfidence));
        }
      }
      sourceContext.putImageData(sourceImage, 0, 0);
      const gradient = context.createLinearGradient(0, 0, size, size);
      const [primary, secondary] = ELEMENT_PALETTE[fighter.element];
      gradient.addColorStop(0, `#${primary.toString(16).padStart(6, '0')}`);
      gradient.addColorStop(0.55, `#${secondary.toString(16).padStart(6, '0')}`);
      gradient.addColorStop(1, '#141225');
      context.fillStyle = gradient;
      context.fillRect(0, 0, size, size);
      // The front of SphereGeometry maps around U=.25; the opposite hemisphere
      // remains palette-only instead of repeating the source as a billboard.
      const scale = Math.min((size * 0.54) / image.naturalWidth, (size * 0.94) / image.naturalHeight);
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      const x = size * 0.25 - width / 2;
      const y = (size - height) / 2;
      context.globalAlpha = 0.96;
      context.drawImage(source, x, y, width, height);
      context.globalAlpha = 1;
      const texture = new THREE.CanvasTexture(target);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.MirroredRepeatWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.anisotropy = 4;
      texture.needsUpdate = true;
      resolve(texture);
    };
    image.onerror = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 4;
      canvas.height = 4;
      const context = canvas.getContext('2d');
      if (context) {
        context.fillStyle = `#${ELEMENT_PALETTE[fighter.element][0].toString(16).padStart(6, '0')}`;
        context.fillRect(0, 0, 4, 4);
      }
      resolve(new THREE.CanvasTexture(canvas));
    };
    image.src = fighter.portrait;
  });
  textureCache.set(fighter.id, promise);
  return promise;
}

function vector(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z);
}

function sharedBones(archetype: RigArchetype): BonePlan[] {
  const coreY = archetype === 'serpentine' ? 0.58 : archetype === 'quadruped' ? 0.82 : 0.95;
  return [
    { name: 'RigRoot', parent: -1, position: vector(0, 0, 0) },
    { name: 'Core', parent: 0, position: vector(0, coreY, 0) },
    { name: 'Spine', parent: 1, position: vector(0, 0.58, 0) },
    { name: 'Head', parent: 2, position: vector(0, 0.62, 0.06) },
    { name: 'LeftDrive', parent: 1, position: vector(-0.48, -0.22, 0) },
    { name: 'RightDrive', parent: 1, position: vector(0.48, -0.22, 0) },
    { name: 'LeftTip', parent: 4, position: vector(-0.08, -0.72, 0) },
    { name: 'RightTip', parent: 5, position: vector(0.08, -0.72, 0) },
    { name: 'WingL', parent: 2, position: vector(-0.34, 0.15, 0) },
    { name: 'WingR', parent: 2, position: vector(0.34, 0.15, 0) },
    { name: 'Tail', parent: 1, position: vector(0, -0.1, -0.36) },
    { name: 'TailTip', parent: 10, position: vector(0, -0.1, -0.7) },
  ];
}

function sphere(segments = 16): THREE.BufferGeometry {
  return new THREE.SphereGeometry(0.5, segments, Math.max(8, segments / 2));
}

function capsule(): THREE.BufferGeometry {
  return new THREE.CapsuleGeometry(0.34, 0.52, 6, 12);
}

function box(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1, 1, 1, 2, 2, 2);
}

function part(bone: number, geometry: THREE.BufferGeometry, position: [number, number, number], scale: [number, number, number], rotation?: [number, number, number]): VolumePart {
  return { bone, geometry, position: vector(...position), scale: vector(...scale), rotation: rotation ? new THREE.Euler(...rotation) : undefined };
}

function rigPlan(archetype: RigArchetype, fighterIndex: number): RigPlan {
  const bones = sharedBones(archetype);
  const plans: Record<RigArchetype, RigPlan> = {
    biped: {
      bones,
      eyeHeight: 2.24,
      radius: 0.62,
      parts: [
        part(1, capsule(), [0, 1.12, 0], [1.1, 1.02, 0.82]),
        part(2, sphere(), [0, 1.66, 0], [0.63, 0.7, 0.54]),
        part(3, sphere(20), [0, 2.18, 0.04], [0.69, 0.64, 0.61]),
        part(4, capsule(), [-0.43, 0.8, 0], [0.5, 0.95, 0.5]),
        part(5, capsule(), [0.43, 0.8, 0], [0.5, 0.95, 0.5]),
        part(6, sphere(12), [-0.48, 0.25, 0.08], [0.28, 0.22, 0.5]),
        part(7, sphere(12), [0.48, 0.25, 0.08], [0.28, 0.22, 0.5]),
      ],
    },
    quadruped: {
      bones,
      eyeHeight: 1.56,
      radius: 0.84,
      parts: [
        part(1, capsule(), [0, 0.98, 0], [1.16, 1.42, 0.98], [Math.PI / 2, 0, 0]),
        part(2, sphere(), [0, 1.18, 0.52], [0.58, 0.62, 0.63]),
        part(3, sphere(20), [0, 1.48, 0.84], [0.62, 0.55, 0.69]),
        part(4, capsule(), [-0.48, 0.55, 0.45], [0.45, 0.85, 0.45]),
        part(5, capsule(), [0.48, 0.55, 0.45], [0.45, 0.85, 0.45]),
        part(6, capsule(), [-0.47, 0.51, -0.47], [0.42, 0.78, 0.42]),
        part(7, capsule(), [0.47, 0.51, -0.47], [0.42, 0.78, 0.42]),
        part(10, capsule(), [0, 0.91, -0.92], [0.3, 1.1, 0.3], [Math.PI / 2.8, 0, 0]),
      ],
    },
    avian: {
      bones,
      eyeHeight: 1.92,
      radius: 0.78,
      parts: [
        part(1, sphere(), [0, 1.12, 0], [0.68, 0.86, 0.56]),
        part(3, sphere(20), [0, 1.84, 0.06], [0.55, 0.57, 0.5]),
        part(8, box(), [-0.62, 1.3, 0], [0.86, 0.08, 0.56], [0, 0, -0.32]),
        part(9, box(), [0.62, 1.3, 0], [0.86, 0.08, 0.56], [0, 0, 0.32]),
        part(4, capsule(), [-0.2, 0.55, 0], [0.28, 0.8, 0.28]),
        part(5, capsule(), [0.2, 0.55, 0], [0.28, 0.8, 0.28]),
        part(10, box(), [0, 0.94, -0.53], [0.65, 0.08, 0.72], [0.45, 0, 0]),
      ],
    },
    serpentine: {
      bones,
      eyeHeight: 1.68,
      radius: 0.72,
      parts: [
        part(1, capsule(), [0, 0.64, 0], [0.88, 1.55, 0.88]),
        part(2, capsule(), [0, 1.22, 0], [0.72, 1.22, 0.72]),
        part(3, sphere(20), [0, 1.67, 0.03], [0.65, 0.58, 0.63]),
        part(10, capsule(), [0, 0.35, -0.65], [0.53, 1.6, 0.53], [Math.PI / 2, 0, 0]),
        part(11, capsule(), [0.22, 0.22, -1.45], [0.38, 1.45, 0.38], [Math.PI / 2, 0.25, 0]),
      ],
    },
    construct: {
      bones,
      eyeHeight: 2.05,
      radius: 0.76,
      parts: [
        part(1, box(), [0, 1.02, 0], [1.05, 0.82, 0.78]),
        part(2, box(), [0, 1.56, 0], [0.84, 0.62, 0.66]),
        part(3, sphere(12), [0, 2.06, 0.03], [0.55, 0.5, 0.52]),
        part(4, box(), [-0.58, 1.1, 0], [0.34, 1.05, 0.34], [0, 0, -0.12]),
        part(5, box(), [0.58, 1.1, 0], [0.34, 1.05, 0.34], [0, 0, 0.12]),
        part(6, box(), [-0.32, 0.39, 0], [0.38, 0.76, 0.46]),
        part(7, box(), [0.32, 0.39, 0], [0.38, 0.76, 0.46]),
      ],
    },
    swarm: {
      bones,
      eyeHeight: 1.66,
      radius: 0.95,
      parts: [
        part(1, sphere(), [0, 1.05, 0], [0.5, 0.5, 0.5]),
        part(2, sphere(12), [-0.62, 1.38, 0.08], [0.48, 0.48, 0.48]),
        part(3, sphere(12), [0.48, 1.72, 0], [0.55, 0.55, 0.55]),
        part(4, sphere(12), [-0.68, 0.67, 0.18], [0.4, 0.4, 0.4]),
        part(5, sphere(12), [0.65, 0.72, -0.1], [0.43, 0.43, 0.43]),
        part(8, sphere(12), [-0.06, 2.05, -0.08], [0.36, 0.36, 0.36]),
        part(9, sphere(12), [0.82, 1.34, -0.05], [0.34, 0.34, 0.34]),
      ],
    },
  };
  const plan = plans[archetype];
  const shapeSeed = (fighterIndex * 9301 + 49297) % 233280;
  const headScale = 0.9 + (shapeSeed % 19) / 100;
  const bodyWidth = 0.91 + ((shapeSeed >> 3) % 18) / 100;
  for (const volume of plan.parts) {
    if (volume.bone === 3) volume.scale.multiplyScalar(headScale);
    if (volume.bone === 1 || volume.bone === 2) volume.scale.x *= bodyWidth;
  }
  const featureStyle = fighterIndex % 5;
  if (featureStyle === 0) {
    plan.parts.push(
      part(3, new THREE.ConeGeometry(0.18, 0.62, 8), [-0.28, plan.eyeHeight + 0.48, 0], [1, 1, 1], [0, 0, -0.28]),
      part(3, new THREE.ConeGeometry(0.18, 0.62, 8), [0.28, plan.eyeHeight + 0.48, 0], [1, 1, 1], [0, 0, 0.28]),
    );
  } else if (featureStyle === 1) {
    plan.parts.push(
      part(3, new THREE.ConeGeometry(0.28, 0.5, 6), [-0.44, plan.eyeHeight + 0.27, 0], [0.7, 1, 0.35], [0, 0, -0.78]),
      part(3, new THREE.ConeGeometry(0.28, 0.5, 6), [0.44, plan.eyeHeight + 0.27, 0], [0.7, 1, 0.35], [0, 0, 0.78]),
    );
  } else if (featureStyle === 2) {
    plan.parts.push(part(3, new THREE.TorusGeometry(0.48, 0.06, 8, 28), [0, plan.eyeHeight + 0.5, 0], [1, 1, 1], [Math.PI / 2.6, 0, 0]));
  } else if (featureStyle === 3) {
    plan.parts.push(
      part(3, new THREE.CylinderGeometry(0.025, 0.04, 0.55, 7), [-0.19, plan.eyeHeight + 0.43, 0], [1, 1, 1], [0, 0, -0.16]),
      part(3, new THREE.CylinderGeometry(0.025, 0.04, 0.55, 7), [0.19, plan.eyeHeight + 0.43, 0], [1, 1, 1], [0, 0, 0.16]),
    );
  } else {
    plan.parts.push(part(2, new THREE.ConeGeometry(0.31, 0.86, 8), [0, plan.eyeHeight - 0.36, -0.38], [0.8, 1, 0.3], [Math.PI / 2, 0, 0]));
  }
  return plan;
}

function buildGeometry(plan: RigPlan): THREE.BufferGeometry {
  const geometries = plan.parts.map((volume) => {
    const geometry = volume.geometry.clone();
    const count = geometry.getAttribute('position').count;
    const indices = new Uint16Array(count * 4);
    const weights = new Float32Array(count * 4);
    const secondaryBone = Math.max(0, plan.bones[volume.bone]?.parent ?? 0);
    const positions = geometry.getAttribute('position');
    for (let index = 0; index < count; index += 1) {
      const edgeFactor = Math.min(1, Math.abs(positions.getY(index)) * 1.75);
      const secondaryWeight = secondaryBone === volume.bone ? 0 : 0.08 + edgeFactor * 0.16;
      indices[index * 4] = volume.bone;
      indices[index * 4 + 1] = secondaryBone;
      weights[index * 4] = 1 - secondaryWeight;
      weights[index * 4 + 1] = secondaryWeight;
    }
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
    const transform = new THREE.Matrix4().compose(
      volume.position,
      new THREE.Quaternion().setFromEuler(volume.rotation ?? new THREE.Euler()),
      volume.scale,
    );
    geometry.applyMatrix4(transform);
    return geometry;
  });
  const merged = mergeGeometries(geometries, true);
  for (const geometry of geometries) geometry.dispose();
  if (!merged) throw new Error('Unable to assemble fighter geometry');
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

function buildClips(plan: RigPlan, archetype: RigArchetype): Map<FighterAnimation, THREE.AnimationClip> {
  const clip = (name: FighterAnimation, duration: number, tracks: THREE.KeyframeTrack[]) =>
    new THREE.AnimationClip(name, duration, tracks);
  const bindCoreY = plan.bones[1]?.position.y ?? 0.95;
  const locomotionTracks = archetype === 'serpentine'
    ? [
        new THREE.NumberKeyframeTrack('Spine.rotation[y]', [0, 0.31, 0.62], [-0.34, 0.34, -0.34]),
        new THREE.NumberKeyframeTrack('Tail.rotation[y]', [0, 0.31, 0.62], [0.48, -0.48, 0.48]),
        new THREE.NumberKeyframeTrack('TailTip.rotation[y]', [0, 0.31, 0.62], [-0.66, 0.66, -0.66]),
      ]
    : archetype === 'avian'
      ? [
          new THREE.NumberKeyframeTrack('WingL.rotation[z]', [0, 0.31, 0.62], [0.2, -0.72, 0.2]),
          new THREE.NumberKeyframeTrack('WingR.rotation[z]', [0, 0.31, 0.62], [-0.2, 0.72, -0.2]),
          new THREE.NumberKeyframeTrack('Core.position[y]', [0, 0.31, 0.62], [bindCoreY, bindCoreY + 0.1, bindCoreY]),
        ]
      : archetype === 'swarm'
        ? [
            new THREE.NumberKeyframeTrack('Spine.rotation[z]', [0, 0.31, 0.62], [-0.5, 0.5, -0.5]),
            new THREE.NumberKeyframeTrack('WingL.rotation[y]', [0, 0.31, 0.62], [0.7, -0.7, 0.7]),
            new THREE.NumberKeyframeTrack('WingR.rotation[y]', [0, 0.31, 0.62], [-0.7, 0.7, -0.7]),
          ]
        : [
            new THREE.NumberKeyframeTrack('LeftDrive.rotation[x]', [0, 0.31, 0.62], [-0.65, 0.65, -0.65]),
            new THREE.NumberKeyframeTrack('RightDrive.rotation[x]', [0, 0.31, 0.62], [0.65, -0.65, 0.65]),
          ];
  return new Map<FighterAnimation, THREE.AnimationClip>([
    ['idle', clip('idle', 1.8, [
      new THREE.NumberKeyframeTrack('Spine.rotation[z]', [0, 0.9, 1.8], [-0.025, 0.035, -0.025]),
      new THREE.NumberKeyframeTrack('Head.rotation[y]', [0, 0.9, 1.8], [-0.08, 0.08, -0.08]),
      new THREE.NumberKeyframeTrack('Core.position[y]', [0, 0.9, 1.8], [bindCoreY, bindCoreY + 0.035, bindCoreY]),
    ])],
    ['run', clip('run', 0.62, locomotionTracks)],
    ['cast', clip('cast', 0.58, [
      new THREE.NumberKeyframeTrack('Spine.rotation[x]', [0, 0.24, 0.58], [0, -0.42, 0.08]),
      new THREE.NumberKeyframeTrack('LeftDrive.rotation[z]', [0, 0.24, 0.58], [0, -1.05, 0]),
      new THREE.NumberKeyframeTrack('RightDrive.rotation[z]', [0, 0.24, 0.58], [0, 1.05, 0]),
    ])],
    ['hit', clip('hit', 0.36, [
      new THREE.NumberKeyframeTrack('Core.rotation[z]', [0, 0.13, 0.36], [0, 0.32, 0]),
      new THREE.NumberKeyframeTrack('Head.rotation[x]', [0, 0.13, 0.36], [0, -0.28, 0]),
    ])],
    ['ko', clip('ko', 0.88, [
      new THREE.NumberKeyframeTrack('RigRoot.rotation[z]', [0, 0.88], [0, -1.45]),
      new THREE.NumberKeyframeTrack('RigRoot.position[y]', [0, 0.5, 0.88], [0, 0.16, 0.04]),
    ])],
  ]);
}

function addFaceAndSockets(root: THREE.Group, bones: THREE.Bone[], fighter: FighterDefinition, eyeHeight: number): Map<string, THREE.Object3D> {
  const sockets = new Map<string, THREE.Object3D>();
  const [primary, secondary, accent] = ELEMENT_PALETTE[fighter.element];
  const eyeMaterial = new THREE.MeshPhysicalMaterial({
    color: accent,
    emissive: primary,
    emissiveIntensity: 2.4,
    roughness: 0.08,
    metalness: 0.05,
    transmission: 0.15,
    clearcoat: 1,
  });
  const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), eyeMaterial);
  const rightEye = leftEye.clone();
  const head = bones[3];
  const headBindHeight = (bones[1]?.position.y ?? 0) + (bones[2]?.position.y ?? 0) + (head?.position.y ?? 0);
  leftEye.position.set(-0.18, eyeHeight - headBindHeight, 0.44);
  rightEye.position.set(0.18, eyeHeight - headBindHeight, 0.44);
  leftEye.name = 'EyeL';
  rightEye.name = 'EyeR';
  (head ?? root).add(leftEye, rightEye);
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(0.53, 0.035, 8, 40),
    new THREE.MeshStandardMaterial({ color: secondary, metalness: 0.82, roughness: 0.2, emissive: primary, emissiveIntensity: 0.25 }),
  );
  halo.name = 'CrestHalo';
  halo.position.set(0, eyeHeight + 0.54 - headBindHeight, -0.02);
  halo.rotation.x = Math.PI / 2.8;
  (head ?? root).add(halo);
  const abilitySocket = new THREE.Object3D();
  abilitySocket.name = 'AbilitySocket';
  abilitySocket.position.set(0, 0.1, 0.65);
  bones[3]?.add(abilitySocket);
  sockets.set('ability', abilitySocket);
  sockets.set('head', bones[3] ?? root);
  sockets.set('core', bones[1] ?? root);
  return sockets;
}

export function createFighterRig(fighter: FighterDefinition, quality: 'high' | 'low' = 'high'): FighterRigRuntime {
  const plan = rigPlan(fighter.archetype, fighter.index);
  const root = new THREE.Group();
  root.name = `FighterRig_${fighter.id}`;
  root.userData.fighterId = fighter.id;
  root.userData.archetype = fighter.archetype;
  const bones = plan.bones.map(({ name, position }) => {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.copy(position);
    return bone;
  });
  plan.bones.forEach(({ parent }, index) => {
    const current = bones[index];
    if (!current) return;
    if (parent < 0) root.add(current);
    else bones[parent]?.add(current);
  });
  const skeleton = new THREE.Skeleton(bones);
  const [primary] = ELEMENT_PALETTE[fighter.element];
  const portraitMaterial = new THREE.MeshPhysicalMaterial({
    color: primary,
    roughness: fighter.archetype === 'construct' ? 0.26 : 0.48,
    metalness: fighter.archetype === 'construct' ? 0.72 : 0.12,
    clearcoat: quality === 'high' ? 0.48 : 0.12,
    clearcoatRoughness: 0.28,
    envMapIntensity: 1.15,
  });
  const [, secondary, accent] = ELEMENT_PALETTE[fighter.element];
  const bodyMaterial = new THREE.MeshPhysicalMaterial({
    color: secondary,
    roughness: fighter.archetype === 'construct' ? 0.24 : 0.5,
    metalness: fighter.archetype === 'construct' ? 0.76 : 0.08,
    clearcoat: quality === 'high' ? 0.35 : 0.08,
    envMapIntensity: 1.05,
  });
  const limbMaterial = new THREE.MeshStandardMaterial({
    color: primary,
    roughness: 0.58,
    metalness: fighter.archetype === 'construct' ? 0.55 : 0.04,
  });
  const accentMaterial = new THREE.MeshPhysicalMaterial({
    color: accent,
    emissive: primary,
    emissiveIntensity: 0.16,
    roughness: 0.22,
    metalness: 0.62,
    clearcoat: 0.7,
  });
  const groupMaterials = plan.parts.map((volume) => {
    if (volume.bone === 3) return portraitMaterial;
    if (volume.bone === 1 || volume.bone === 2) return bodyMaterial;
    if (volume.bone >= 8) return accentMaterial;
    return limbMaterial;
  });
  const skinnedMesh = new THREE.SkinnedMesh(buildGeometry(plan), groupMaterials);
  skinnedMesh.name = 'CharacterVolume';
  skinnedMesh.castShadow = quality === 'high';
  skinnedMesh.receiveShadow = true;
  skinnedMesh.frustumCulled = true;
  root.add(skinnedMesh);
  skinnedMesh.bind(skeleton);
  const sculptShell = fighter.id === 'zukan-001' && quality === 'high'
    ? createNyxaluneZukanFighterRigFamilyModel({ castShadow: true, receiveShadow: true, qualityPriority: 'reference-fidelity' })
    : undefined;
  if (sculptShell) {
    sculptShell.name = 'Img2ThreeJsHeroShell';
    const shellBounds = new THREE.Box3().setFromObject(sculptShell);
    const shellHeight = Math.max(0.01, shellBounds.max.y - shellBounds.min.y);
    const normalizedScale = 2.52 / shellHeight;
    sculptShell.scale.setScalar(normalizedScale);
    sculptShell.position.y = -shellBounds.min.y * normalizedScale;
    const sculptRuntime = sculptShell.userData.sculptRuntime as { nodes?: Record<string, THREE.Object3D> } | undefined;
    for (const node of Object.values(sculptRuntime?.nodes ?? {})) {
      node.userData.rigBindQuaternion = node.quaternion.clone();
      node.userData.rigBindPosition = node.position.clone();
    }
    sculptShell.userData.rigBindPosition = sculptShell.position.clone();
    skinnedMesh.visible = false;
    root.add(sculptShell);
  }
  let disposed = false;
  const ownedTextures: THREE.Texture[] = [];
  void elementTexture(fighter).then((texture) => {
    if (disposed) return;
    portraitMaterial.map = texture;
    portraitMaterial.needsUpdate = true;
  });
  if (fighter.id === 'zukan-001' && typeof document !== 'undefined') {
    const loader = new THREE.TextureLoader();
    loader.load('/textures/nyxalune/skin/skin-indigo_normal.png', (texture) => {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(2.4, 2.4);
      if (disposed) return texture.dispose();
      ownedTextures.push(texture);
      portraitMaterial.normalMap = texture;
      portraitMaterial.normalScale.setScalar(0.34);
      portraitMaterial.needsUpdate = true;
    });
    loader.load('/textures/nyxalune/skin/skin-indigo_roughness.png', (texture) => {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(2.4, 2.4);
      if (disposed) return texture.dispose();
      ownedTextures.push(texture);
      portraitMaterial.roughnessMap = texture;
      portraitMaterial.needsUpdate = true;
    });
  }
  const teamRing = new THREE.Mesh(
    new THREE.RingGeometry(plan.radius * 0.72, plan.radius, 48),
    new THREE.MeshBasicMaterial({ color: 0x66e6ff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
  );
  teamRing.rotation.x = -Math.PI / 2;
  teamRing.position.y = 0.025;
  root.add(teamRing);
  const sockets = addFaceAndSockets(root, bones, fighter, plan.eyeHeight);
  const clips = buildClips(plan, fighter.archetype);
  const mixer = new THREE.AnimationMixer(root);
  let current: FighterAnimation = 'idle';
  let oneShotLocked = false;
  let actionToken = 0;
  let currentAction = mixer.clipAction(clips.get('idle') as THREE.AnimationClip);
  currentAction.play();

  return {
    root,
    mixer,
    skeleton,
    skinnedMesh,
    sockets,
    colliders: [
      { bone: 'Core', radius: plan.radius, offset: vector(0, plan.eyeHeight * 0.46, 0) },
      { bone: 'Head', radius: plan.radius * 0.54, offset: vector(0, plan.eyeHeight, 0) },
    ],
    play(animation, once = animation !== 'idle' && animation !== 'run') {
      if (current === 'ko') return;
      if (oneShotLocked && (animation === 'idle' || animation === 'run')) return;
      const priority: Record<FighterAnimation, number> = { idle: 0, run: 0, cast: 1, hit: 2, ko: 3 };
      if (oneShotLocked && priority[animation] <= priority[current]) return;
      if (animation === current && currentAction.isRunning()) return;
      const nextClip = clips.get(animation);
      if (!nextClip) return;
      const next = mixer.clipAction(nextClip);
      next.reset();
      next.enabled = true;
      next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
      next.clampWhenFinished = once;
      next.crossFadeFrom(currentAction, 0.12, true).play();
      current = animation;
      currentAction = next;
      oneShotLocked = once;
      const token = ++actionToken;
      if (once && animation !== 'ko') {
        const returnToIdle = (event: { action: THREE.AnimationAction }) => {
          if (event.action !== next) return;
          mixer.removeEventListener('finished', returnToIdle);
          if (token !== actionToken || currentAction !== next) return;
          oneShotLocked = false;
          current = 'cast';
          this.play('idle', false);
        };
        mixer.addEventListener('finished', returnToIdle);
      }
    },
    update(delta) {
      mixer.update(Math.min(delta, 0.05));
      if (sculptShell) syncSculptShell(sculptShell, bones);
      haloSpin(root, delta);
    },
    setTeam(team) {
      const teamMaterial = teamRing.material as THREE.MeshBasicMaterial;
      teamMaterial.color.set(team === 'signal' ? 0x66e6ff : 0xff5d8f);
    },
    dispose() {
      disposed = true;
      mixer.stopAllAction();
      root.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const item of new Set(materials)) item.dispose();
      });
      if (sculptShell) disposeOwnedMaterialTextures(sculptShell);
      for (const texture of ownedTextures) texture.dispose();
      skeleton.dispose();
    },
  };
}

function syncSculptShell(shell: THREE.Group, bones: THREE.Bone[]): void {
  const runtime = shell.userData.sculptRuntime as { nodes?: Record<string, THREE.Object3D> } | undefined;
  const nodes = runtime?.nodes;
  if (!nodes) return;
  const rootBone = bones[0];
  if (rootBone) {
    shell.rotation.copy(rootBone.rotation);
    const bindPosition = shell.userData.rigBindPosition as THREE.Vector3 | undefined;
    if (bindPosition) shell.position.copy(bindPosition).add(rootBone.position);
  }
  const mappings: Array<[number, string[]]> = [
    [1, ['pelvis', 'core', 'pelvis-core']],
    [2, ['spine', 'torso', 'chest', 'chest-core']],
    [3, ['head', 'neck', 'face', 'eye-l', 'eye-r']],
    [4, ['upper-arm-l', 'thigh-l', 'wing-l']],
    [5, ['upper-arm-r', 'thigh-r', 'wing-r']],
    [6, ['forearm-l', 'shin-l']],
    [7, ['forearm-r', 'shin-r']],
    [8, ['cape-l', 'wing-l']],
    [9, ['cape-r', 'wing-r']],
    [10, ['tail', 'cape']],
    [11, ['tail-tip', 'cape-border']],
  ];
  for (const [boneIndex, nodeNames] of mappings) {
    const bone = bones[boneIndex];
    if (!bone) continue;
    for (const nodeName of nodeNames) {
      const node = nodes[nodeName];
      if (!node) continue;
      const bindQuaternion = node.userData.rigBindQuaternion as THREE.Quaternion | undefined;
      node.quaternion.copy(bindQuaternion ?? new THREE.Quaternion()).multiply(bone.quaternion);
      if (boneIndex === 1) {
        const bindPosition = node.userData.rigBindPosition as THREE.Vector3 | undefined;
        const baseCoreY = 0.95;
        if (bindPosition) node.position.copy(bindPosition).add(new THREE.Vector3(0, bone.position.y - baseCoreY, 0));
      }
    }
  }
}

function disposeOwnedMaterialTextures(root: THREE.Object3D): void {
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });
  for (const texture of textures) texture.dispose();
}

function haloSpin(root: THREE.Group, delta: number): void {
  const halo = root.getObjectByName('CrestHalo');
  if (halo) halo.rotation.z += delta * 0.35;
}
