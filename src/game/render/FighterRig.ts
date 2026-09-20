import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import type { FighterDefinition, TeamKind } from "../types";
import {
  characterAsset,
  CharacterAssetError,
  REQUIRED_ACTIONS,
  type FighterAnimation,
} from "../assets/characterAssets";
export type { FighterAnimation } from "../assets/characterAssets";

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

export function disposeModel(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const skeletons = new Set<THREE.Skeleton>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton);
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material))
        if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  for (const item of [...geometries, ...materials, ...textures, ...skeletons])
    item.dispose();
  root.removeFromParent();
}

/** Validate actual deformation data, not the presence of a SkinnedMesh label. */
export function validateCharacterModel(
  gltf: GLTF,
  id: string,
): THREE.SkinnedMesh {
  const fail = (message: string): never => {
    throw new CharacterAssetError(id, message);
  };
  const meshes: THREE.SkinnedMesh[] = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh) meshes.push(object);
  });
  if (!meshes.length) return fail("Model has no skinned character geometry");
  for (const mesh of meshes) {
    const positions = mesh.geometry.getAttribute("position");
    const indices = mesh.geometry.getAttribute("skinIndex");
    const weights = mesh.geometry.getAttribute("skinWeight");
    if (
      !positions ||
      !indices ||
      !weights ||
      indices.count !== positions.count ||
      weights.count !== positions.count
    ) {
      fail("Incomplete skin attributes");
    }
    for (let i = 0; i < positions.count; i++) {
      let total = 0;
      for (let j = 0; j < 4; j++) {
        const joint = indices.getComponent(i, j);
        const weight = weights.getComponent(i, j);
        if (
          !Number.isInteger(joint) ||
          joint < 0 ||
          joint >= mesh.skeleton.bones.length ||
          !Number.isFinite(weight) ||
          weight < 0
        )
          fail("Invalid skin joint or weight");
        total += weight;
      }
      if (Math.abs(total - 1) > 0.01) fail("Unnormalized skin weights");
      if (
        ![positions.getX(i), positions.getY(i), positions.getZ(i)].every(
          Number.isFinite,
        )
      )
        fail("Non-finite geometry");
    }
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];
    if (
      !materials.some((m) => m instanceof THREE.MeshStandardMaterial && m.map)
    )
      fail("Missing authored color texture");
  }
  for (const action of REQUIRED_ACTIONS) {
    const clip = gltf.animations.find(({ name }) => name === action);
    if (!clip || clip.duration <= 0 || !clip.tracks.length)
      fail(`Missing animation: ${action}`);
  }
  for (const socket of ["ability", "head", "core"]) {
    if (!gltf.scene.getObjectByName(`socket_${socket}`))
      fail(`Missing socket: ${socket}`);
  }
  for (const mesh of meshes) mesh.computeBoundingBox();
  const size = new THREE.Box3()
    .setFromObject(gltf.scene)
    .getSize(new THREE.Vector3());
  if (![size.x, size.y, size.z].every((n) => Number.isFinite(n) && n > 0.01))
    fail("Model has no valid volume");
  return meshes[0]!;
}

/** One owned GLB per instance: disposal cannot invalidate another fighter. */
export async function createFighterRig(
  fighter: FighterDefinition,
  quality: "high" | "low" = "high",
): Promise<FighterRigRuntime> {
  const asset = characterAsset(fighter.id);
  if (asset.status !== "approved")
    throw new CharacterAssetError(
      fighter.id,
      "Character reconstruction is not ready",
    );
  const gltf = await new GLTFLoader().loadAsync(asset.model);
  try {
    validateCharacterModel(gltf, fighter.id);
    return rigFromModel(gltf, fighter.id, quality);
  } catch (error) {
    disposeModel(gltf.scene);
    throw error;
  }
}

export function rigFromModel(
  gltf: GLTF,
  id: string,
  quality: "high" | "low",
): FighterRigRuntime {
  const skinnedMesh = validateCharacterModel(gltf, id);
  const root = new THREE.Group();
  root.name = `FighterRig_${id}`;
  root.userData.fighterId = id;
  const visual = gltf.scene;
  const bounds = new THREE.Box3().setFromObject(visual);
  const center = bounds.getCenter(new THREE.Vector3());
  const scale = 2.52 / (bounds.max.y - bounds.min.y);
  // Normalize via a parent so animation tracks retain their authored local space.
  const normalization = new THREE.Group();
  normalization.scale.setScalar(scale);
  normalization.position.set(
    -center.x * scale,
    -bounds.min.y * scale,
    -center.z * scale,
  );
  normalization.add(visual);
  root.add(normalization);
  visual.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = quality === "high";
      object.receiveShadow = true;
    }
  });
  const mixer = new THREE.AnimationMixer(visual);
  const actions = new Map(
    REQUIRED_ACTIONS.map((name) => [
      name,
      mixer.clipAction(gltf.animations.find((clip) => clip.name === name)!),
    ]),
  );
  let current: FighterAnimation = "idle";
  let locked = false;
  let disposed = false;
  actions.get("idle")!.play();
  const play = (
    name: FighterAnimation,
    once = name !== "idle" && name !== "run",
  ): void => {
    if (
      disposed ||
      current === "ko" ||
      (locked && (name === "idle" || name === "run")) ||
      current === name
    )
      return;
    const previous = actions.get(current)!;
    const next = actions.get(name)!;
    current = name;
    locked = once;
    next
      .reset()
      .setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    next.clampWhenFinished = once;
    next.play();
    previous.crossFadeTo(next, 0.12, false);
  };
  const onFinished = (): void => {
    if (current === "ko") return;
    locked = false;
    play("idle", false);
  };
  mixer.addEventListener("finished", onFinished);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.48, 0.54, 48),
    new THREE.MeshBasicMaterial({
      color: 0x66e6ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  root.add(ring);
  const sockets = new Map(
    ["ability", "head", "core"].map((name) => [
      name,
      visual.getObjectByName(`socket_${name}`)!,
    ]),
  );
  return {
    root,
    mixer,
    skinnedMesh,
    skeleton: skinnedMesh.skeleton,
    sockets,
    colliders: [
      { bone: "core", radius: 0.62, offset: new THREE.Vector3(0, 1, 0) },
      { bone: "head", radius: 0.35, offset: new THREE.Vector3(0, 2.2, 0) },
    ],
    play,
    update(delta) {
      if (!disposed) mixer.update(Math.max(0, Math.min(delta, 0.05)));
    },
    setTeam(team: TeamKind) {
      ring.material.color.set(team === "signal" ? 0x66e6ff : 0xff5d8f);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mixer.removeEventListener("finished", onFinished);
      mixer.stopAllAction();
      mixer.uncacheRoot(visual);
      disposeModel(root);
    },
  };
}
