import * as THREE from 'three';
import {
  createArenaMaterials,
  type ArenaMaterialSet,
  type ArenaQuality,
} from './arenaMaterials';

export const ARENA_COMBAT_WIDTH = 18.4;
export const ARENA_COMBAT_DEPTH = 11.2;

export type LivingArenaOptions = {
  quality?: ArenaQuality;
  includeLighting?: boolean;
  castShadows?: boolean;
  seed?: number;
};

type BannerRecord = {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  basePositions: Float32Array;
  phase: number;
};

type FoliageRecord = {
  position: THREE.Vector3;
  rotation: number;
  scale: number;
  phase: number;
};

type DroneRecord = {
  angle: number;
  radiusX: number;
  radiusZ: number;
  height: number;
  phase: number;
  speed: number;
  scale: number;
};

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function configureMesh(mesh: THREE.Mesh, castShadow: boolean, receiveShadow: boolean): void {
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
}

/**
 * A procedural, asset-free arena built around the simulation's authoritative
 * 18.4 x 11.2 metre footprint. Add the instance directly to a THREE.Scene,
 * call update() once per rendered frame, and dispose() when the match ends.
 */
export class LivingArena extends THREE.Group {
  readonly combatBounds = new THREE.Box2(
    new THREE.Vector2(-ARENA_COMBAT_WIDTH * 0.5, -ARENA_COMBAT_DEPTH * 0.5),
    new THREE.Vector2(ARENA_COMBAT_WIDTH * 0.5, ARENA_COMBAT_DEPTH * 0.5),
  );

  readonly combatSurface: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  readonly keyLight: THREE.DirectionalLight | null;
  readonly quality: ArenaQuality;

  private readonly materials: ArenaMaterialSet;
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly banners: BannerRecord[] = [];
  private readonly foliageRecords: FoliageRecord[] = [];
  private readonly droneRecords: DroneRecord[] = [];
  private readonly dummy = new THREE.Object3D();
  private readonly waterGeometry: THREE.PlaneGeometry;
  private readonly waterBasePositions: Float32Array;
  private readonly pollenGeometry: THREE.BufferGeometry;
  private readonly pollenBasePositions: Float32Array;
  private readonly foliage: THREE.InstancedMesh;
  private readonly drones: THREE.InstancedMesh;
  private windPhase = 0;
  private disposed = false;

  constructor(options: LivingArenaOptions = {}) {
    super();
    this.name = 'porcelain-biome-colosseum';
    this.quality = options.quality ?? 'high';
    const castShadows = options.castShadows ?? true;
    const random = mulberry32(options.seed ?? 0x5a17a11);
    this.materials = createArenaMaterials(this.quality);

    this.userData.combatFootprint = {
      width: ARENA_COMBAT_WIDTH,
      depth: ARENA_COMBAT_DEPTH,
      minX: -ARENA_COMBAT_WIDTH * 0.5,
      maxX: ARENA_COMBAT_WIDTH * 0.5,
      minZ: -ARENA_COMBAT_DEPTH * 0.5,
      maxZ: ARENA_COMBAT_DEPTH * 0.5,
    };
    this.userData.renderBudget = {
      quality: this.quality,
      dynamicSystems: ['water', 'banners', 'foliage', 'pollen', 'crowd-drones'],
      noExternalAssets: true,
    };

    this.buildFoundation(castShadows);
    this.combatSurface = this.addBox(
      'combat-traction-surface',
      ARENA_COMBAT_WIDTH,
      0.22,
      ARENA_COMBAT_DEPTH,
      this.materials.traction,
      new THREE.Vector3(0, -0.05, 0),
      false,
      true,
    );
    this.buildCombatInlays();
    this.buildColonnade(castShadows);
    this.buildGlassRails(castShadows);
    this.buildGardens(castShadows);

    const water = this.buildWaterChannels();
    this.waterGeometry = water.geometry;
    this.waterBasePositions = water.basePositions;

    this.foliage = this.buildFoliage(random, castShadows);
    this.drones = this.buildCrowdDrones(random, castShadows);
    this.pollenGeometry = this.buildPollen(random);
    this.pollenBasePositions = new Float32Array(
      (this.pollenGeometry.getAttribute('position') as THREE.BufferAttribute).array,
    );
    this.buildBanners(castShadows);
    this.buildArenaLamps(castShadows);

    this.keyLight = options.includeLighting === false
      ? null
      : this.buildLighting(castShadows);
  }

  update(deltaSeconds: number, elapsedSeconds: number): void {
    if (this.disposed) return;
    const delta = THREE.MathUtils.clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 0, 0, 0.1);
    this.windPhase += delta * 0.92;
    const elapsed = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : this.windPhase;
    const time = elapsed + this.windPhase * 0.16;
    this.updateWater(time);
    this.updateBanners(time);
    this.updateFoliage(time);
    this.updateDrones(time);
    this.updatePollen(time);
    this.materials.water.emissiveIntensity = 0.1 + Math.sin(time * 0.55) * 0.018;
    this.materials.drone.emissiveIntensity = 0.28 + (Math.sin(time * 1.4) * 0.5 + 0.5) * 0.18;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const geometry of this.geometries) geometry.dispose();
    this.geometries.clear();
    this.materials.dispose();
    this.clear();
    this.removeFromParent();
  }

  private track<T extends THREE.BufferGeometry>(geometry: T): T {
    this.geometries.add(geometry);
    return geometry;
  }

  private addBox<T extends THREE.Material>(
    name: string,
    width: number,
    height: number,
    depth: number,
    material: T,
    position: THREE.Vector3,
    castShadow: boolean,
    receiveShadow: boolean,
  ): THREE.Mesh<THREE.BoxGeometry, T> {
    const mesh = new THREE.Mesh(this.track(new THREE.BoxGeometry(width, height, depth)), material);
    mesh.name = name;
    mesh.position.copy(position);
    configureMesh(mesh, castShadow, receiveShadow);
    this.add(mesh);
    return mesh;
  }

  private buildFoundation(castShadows: boolean): void {
    this.addBox(
      'limestone-foundation',
      25.4,
      0.9,
      17.8,
      this.materials.limestone,
      new THREE.Vector3(0, -0.8, 0),
      castShadows,
      true,
    );
    this.addBox(
      'porcelain-apron',
      22.5,
      0.36,
      14.9,
      this.materials.ceramic,
      new THREE.Vector3(0, -0.3, 0),
      castShadows,
      true,
    );

    const stairMaterial = this.materials.limestone;
    for (let tier = 0; tier < 3; tier += 1) {
      const width = 26.2 + tier * 1.35;
      const depth = 18.6 + tier * 1.05;
      this.addBox(
        `outer-terrace-${tier}`,
        width,
        0.28,
        depth,
        stairMaterial,
        new THREE.Vector3(0, -1.18 - tier * 0.25, -0.3),
        castShadows,
        true,
      );
    }
  }

  private buildCombatInlays(): void {
    const edgeThickness = 0.08;
    const top = 0.075;
    this.addBox(
      'north-champagne-boundary',
      ARENA_COMBAT_WIDTH + 0.22,
      edgeThickness,
      0.07,
      this.materials.champagne,
      new THREE.Vector3(0, top, -ARENA_COMBAT_DEPTH * 0.5),
      false,
      true,
    );
    this.addBox(
      'south-champagne-boundary',
      ARENA_COMBAT_WIDTH + 0.22,
      edgeThickness,
      0.07,
      this.materials.champagne,
      new THREE.Vector3(0, top, ARENA_COMBAT_DEPTH * 0.5),
      false,
      true,
    );
    this.addBox(
      'west-champagne-boundary',
      0.07,
      edgeThickness,
      ARENA_COMBAT_DEPTH,
      this.materials.champagne,
      new THREE.Vector3(-ARENA_COMBAT_WIDTH * 0.5, top, 0),
      false,
      true,
    );
    this.addBox(
      'east-champagne-boundary',
      0.07,
      edgeThickness,
      ARENA_COMBAT_DEPTH,
      this.materials.champagne,
      new THREE.Vector3(ARENA_COMBAT_WIDTH * 0.5, top, 0),
      false,
      true,
    );
    this.addBox(
      'centre-inlay',
      0.045,
      0.026,
      ARENA_COMBAT_DEPTH - 0.8,
      this.materials.champagne,
      new THREE.Vector3(0, 0.08, 0),
      false,
      true,
    );

    const signalRing = new THREE.Mesh(
      this.track(new THREE.RingGeometry(1.25, 1.34, 48)),
      this.materials.signalFabric,
    );
    signalRing.name = 'signal-spawn-inlay';
    signalRing.rotation.x = -Math.PI * 0.5;
    signalRing.position.set(-6.1, 0.085, 0);
    signalRing.receiveShadow = true;
    this.add(signalRing);

    const riftRing = new THREE.Mesh(
      this.track(new THREE.RingGeometry(1.25, 1.34, 48)),
      this.materials.riftFabric,
    );
    riftRing.name = 'rift-spawn-inlay';
    riftRing.rotation.x = -Math.PI * 0.5;
    riftRing.position.set(6.1, 0.085, 0);
    riftRing.receiveShadow = true;
    this.add(riftRing);
  }

  private buildColonnade(castShadows: boolean): void {
    const columnGeometry = this.track(new THREE.CylinderGeometry(0.27, 0.35, 3.8, 12));
    const columnPositions: Array<[number, number, number]> = [
      [-10.7, 1, -7.7], [-7.9, 1, -7.85], [-5.1, 1, -7.9], [-2.3, 1, -7.92],
      [2.3, 1, -7.92], [5.1, 1, -7.9], [7.9, 1, -7.85], [10.7, 1, -7.7],
      [-11.4, 1, -4.9], [-11.55, 1, -1.9], [-11.55, 1, 1.2], [-11.35, 1, 4.3],
      [11.4, 1, -4.9], [11.55, 1, -1.9], [11.55, 1, 1.2], [11.35, 1, 4.3],
    ];
    const columns = new THREE.InstancedMesh(columnGeometry, this.materials.limestone, columnPositions.length);
    columns.name = 'limestone-colonnade';
    columns.castShadow = castShadows;
    columns.receiveShadow = true;
    for (let index = 0; index < columnPositions.length; index += 1) {
      const [x, y, z] = columnPositions[index] ?? [0, 0, 0];
      this.dummy.position.set(x, y, z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      columns.setMatrixAt(index, this.dummy.matrix);
    }
    columns.instanceMatrix.needsUpdate = true;
    this.add(columns);

    const capGeometry = this.track(new THREE.CylinderGeometry(0.45, 0.32, 0.2, 12));
    const caps = new THREE.InstancedMesh(capGeometry, this.materials.champagne, columnPositions.length);
    caps.name = 'champagne-column-caps';
    caps.castShadow = castShadows;
    for (let index = 0; index < columnPositions.length; index += 1) {
      const [x, , z] = columnPositions[index] ?? [0, 0, 0];
      this.dummy.position.set(x, 2.97, z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      caps.setMatrixAt(index, this.dummy.matrix);
    }
    caps.instanceMatrix.needsUpdate = true;
    this.add(caps);

    const archGeometry = this.track(new THREE.TorusGeometry(1.38, 0.13, 8, 24, Math.PI));
    for (const x of [-8.55, -5.75, -2.95, 2.95, 5.75, 8.55]) {
      const arch = new THREE.Mesh(archGeometry, this.materials.bronze);
      arch.name = 'oxidized-bronze-arch';
      arch.position.set(x, 3.02, -7.82);
      arch.castShadow = castShadows;
      this.add(arch);
    }
  }

  private buildGlassRails(castShadows: boolean): void {
    const panelGeometry = this.track(new THREE.BoxGeometry(1.72, 0.62, 0.035));
    const railGeometry = this.track(new THREE.BoxGeometry(1.92, 0.055, 0.08));
    const panelCount = 20;
    const panels = new THREE.InstancedMesh(panelGeometry, this.materials.glass, panelCount);
    const rails = new THREE.InstancedMesh(railGeometry, this.materials.champagne, panelCount);
    panels.name = 'tempered-glass-perimeter';
    rails.name = 'champagne-rail-caps';
    panels.castShadow = false;
    panels.receiveShadow = false;
    rails.castShadow = castShadows;

    let index = 0;
    for (const z of [-6.72, 6.72]) {
      for (let section = 0; section < 10; section += 1) {
        const x = -8.55 + section * 1.9;
        this.dummy.position.set(x, 0.58, z);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.set(1, 1, 1);
        this.dummy.updateMatrix();
        panels.setMatrixAt(index, this.dummy.matrix);
        this.dummy.position.y = 0.93;
        this.dummy.updateMatrix();
        rails.setMatrixAt(index, this.dummy.matrix);
        index += 1;
      }
    }
    panels.instanceMatrix.needsUpdate = true;
    rails.instanceMatrix.needsUpdate = true;
    this.add(panels, rails);
  }

  private buildGardens(castShadows: boolean): void {
    const corners: Array<[number, number]> = [
      [-10.2, -6.45], [10.2, -6.45], [-10.2, 6.45], [10.2, 6.45],
    ];
    for (let index = 0; index < corners.length; index += 1) {
      const [x, z] = corners[index] ?? [0, 0];
      this.addBox(
        `garden-plinth-${index}`,
        2.45,
        0.5,
        1.75,
        this.materials.limestone,
        new THREE.Vector3(x, -0.08, z),
        castShadows,
        true,
      );
      this.addBox(
        `garden-bed-${index}`,
        1.94,
        0.18,
        1.26,
        this.materials.moss,
        new THREE.Vector3(x, 0.25, z),
        false,
        true,
      );
    }

    const mossGeometry = this.track(new THREE.CircleGeometry(0.34, 12));
    const patchCount = this.quality === 'low' ? 18 : 34;
    const patches = new THREE.InstancedMesh(mossGeometry, this.materials.moss, patchCount);
    patches.name = 'moss-seam-patches';
    for (let index = 0; index < patchCount; index += 1) {
      const side = index % 4;
      const lane = Math.floor(index / 4);
      const along = -7.8 + lane * 1.95;
      const x = side < 2 ? along : side === 2 ? -9.72 : 9.72;
      const z = side < 2 ? (side === 0 ? -5.92 : 5.92) : along * 0.62;
      this.dummy.position.set(x, 0.09, z);
      this.dummy.rotation.set(-Math.PI * 0.5, 0, (index * 2.399) % (Math.PI * 2));
      const scale = 0.65 + (index % 5) * 0.1;
      this.dummy.scale.set(scale * 1.6, scale, scale);
      this.dummy.updateMatrix();
      patches.setMatrixAt(index, this.dummy.matrix);
    }
    patches.instanceMatrix.needsUpdate = true;
    patches.receiveShadow = true;
    this.add(patches);
  }

  private buildWaterChannels(): { geometry: THREE.PlaneGeometry; basePositions: Float32Array } {
    for (const z of [-6.05, 6.05]) {
      this.addBox(
        `bronze-water-trough-${z < 0 ? 'north' : 'south'}`,
        19.4,
        0.2,
        0.74,
        this.materials.bronze,
        new THREE.Vector3(0, 0.01, z),
        false,
        true,
      );
    }

    const geometry = this.track(
      new THREE.PlaneGeometry(18.9, 0.54, this.quality === 'low' ? 20 : 48, this.quality === 'low' ? 1 : 3),
    );
    geometry.rotateX(-Math.PI * 0.5);
    const basePositions = new Float32Array((geometry.getAttribute('position') as THREE.BufferAttribute).array);
    for (const z of [-6.05, 6.05]) {
      const water = new THREE.Mesh(geometry, this.materials.water);
      water.name = `living-water-channel-${z < 0 ? 'north' : 'south'}`;
      water.position.set(0, 0.13, z);
      water.renderOrder = 2;
      water.receiveShadow = false;
      this.add(water);
    }
    return { geometry, basePositions };
  }

  private buildFoliage(random: () => number, castShadows: boolean): THREE.InstancedMesh {
    const count = this.quality === 'high' ? 92 : this.quality === 'medium' ? 64 : 38;
    const geometry = this.track(new THREE.ConeGeometry(0.11, 0.82, 5, 1));
    geometry.translate(0, 0.41, 0);
    const foliage = new THREE.InstancedMesh(geometry, this.materials.foliage, count);
    foliage.name = 'wind-reactive-foliage';
    foliage.castShadow = castShadows && this.quality !== 'low';
    foliage.receiveShadow = true;
    const corners: Array<[number, number]> = [
      [-10.2, -6.45], [10.2, -6.45], [-10.2, 6.45], [10.2, 6.45],
    ];
    for (let index = 0; index < count; index += 1) {
      const [cx, cz] = corners[index % corners.length] ?? [0, 0];
      const position = new THREE.Vector3(
        cx + (random() - 0.5) * 1.72,
        0.31,
        cz + (random() - 0.5) * 0.98,
      );
      const record: FoliageRecord = {
        position,
        rotation: random() * Math.PI * 2,
        scale: 0.56 + random() * 0.88,
        phase: random() * Math.PI * 2,
      };
      this.foliageRecords.push(record);
      this.setFoliageMatrix(foliage, index, record, 0);
    }
    foliage.instanceMatrix.needsUpdate = true;
    this.add(foliage);
    return foliage;
  }

  private buildCrowdDrones(random: () => number, castShadows: boolean): THREE.InstancedMesh {
    const count = this.quality === 'high' ? 24 : this.quality === 'medium' ? 16 : 10;
    const geometry = this.track(new THREE.IcosahedronGeometry(0.17, this.quality === 'low' ? 0 : 1));
    const drones = new THREE.InstancedMesh(geometry, this.materials.drone, count);
    drones.name = 'living-crowd-drones';
    drones.castShadow = castShadows && this.quality === 'high';
    for (let index = 0; index < count; index += 1) {
      const record: DroneRecord = {
        angle: (index / count) * Math.PI * 2,
        radiusX: 11.7 + random() * 1.8,
        radiusZ: 7.65 + random() * 1.1,
        height: 2.5 + random() * 2.3,
        phase: random() * Math.PI * 2,
        speed: 0.025 + random() * 0.045,
        scale: 0.7 + random() * 0.72,
      };
      this.droneRecords.push(record);
      this.setDroneMatrix(drones, index, record, 0);
    }
    drones.instanceMatrix.needsUpdate = true;
    this.add(drones);
    return drones;
  }

  private buildPollen(random: () => number): THREE.BufferGeometry {
    const count = this.quality === 'high' ? 180 : this.quality === 'medium' ? 120 : 68;
    const positions = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      positions[index * 3] = (random() - 0.5) * 25;
      positions[index * 3 + 1] = 0.35 + random() * 4.7;
      positions[index * 3 + 2] = (random() - 0.5) * 17;
    }
    const geometry = this.track(new THREE.BufferGeometry());
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const pollen = new THREE.Points(geometry, this.materials.pollen);
    pollen.name = 'single-draw-pollen-field';
    pollen.frustumCulled = false;
    pollen.renderOrder = 3;
    this.add(pollen);
    return geometry;
  }

  private buildBanners(castShadows: boolean): void {
    const bannerSpecs: Array<{
      position: THREE.Vector3;
      rotationY: number;
      material: THREE.MeshStandardMaterial;
      phase: number;
    }> = [
      { position: new THREE.Vector3(-9.2, 3.6, -7.5), rotationY: 0, material: this.materials.signalFabric, phase: 0 },
      { position: new THREE.Vector3(9.2, 3.6, -7.5), rotationY: 0, material: this.materials.riftFabric, phase: 1.7 },
      { position: new THREE.Vector3(-11.25, 3.45, 3.1), rotationY: Math.PI * 0.5, material: this.materials.signalFabric, phase: 3.2 },
      { position: new THREE.Vector3(11.25, 3.45, 3.1), rotationY: -Math.PI * 0.5, material: this.materials.riftFabric, phase: 4.8 },
    ];
    for (let index = 0; index < bannerSpecs.length; index += 1) {
      const spec = bannerSpecs[index];
      if (!spec) continue;
      const geometry = this.track(new THREE.PlaneGeometry(1.3, 2.85, 7, this.quality === 'low' ? 5 : 12));
      geometry.translate(0, -1.35, 0);
      const mesh = new THREE.Mesh(geometry, spec.material);
      mesh.name = `living-banner-${index}`;
      mesh.position.copy(spec.position);
      mesh.rotation.y = spec.rotationY;
      mesh.castShadow = castShadows && this.quality !== 'low';
      mesh.receiveShadow = true;
      const position = geometry.getAttribute('position') as THREE.BufferAttribute;
      this.banners.push({
        mesh,
        basePositions: new Float32Array(position.array),
        phase: spec.phase,
      });
      this.add(mesh);
    }
  }

  private buildArenaLamps(castShadows: boolean): void {
    const geometry = this.track(new THREE.SphereGeometry(0.09, 10, 7));
    const positions: Array<[number, number, number]> = [];
    for (const z of [-6.72, 6.72]) {
      for (let index = 0; index < 10; index += 1) positions.push([-8.55 + index * 1.9, 1.02, z]);
    }
    const lamps = new THREE.InstancedMesh(geometry, this.materials.drone, positions.length);
    lamps.name = 'champagne-rail-lamps';
    lamps.castShadow = castShadows && this.quality === 'high';
    for (let index = 0; index < positions.length; index += 1) {
      const [x, y, z] = positions[index] ?? [0, 0, 0];
      this.dummy.position.set(x, y, z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      lamps.setMatrixAt(index, this.dummy.matrix);
    }
    lamps.instanceMatrix.needsUpdate = true;
    this.add(lamps);
  }

  private buildLighting(castShadows: boolean): THREE.DirectionalLight {
    // Cinematic porcelain-colosseum lighting: warm key, cool rim, soft sky fill + subtle bounce
    const sky = new THREE.HemisphereLight('#fff6e8', '#1e2f36', 1.55);
    sky.name = 'arena-warm-sky-fill';
    this.add(sky);

    const key = new THREE.DirectionalLight('#ffe8c8', 3.35);
    key.name = 'arena-sun-key';
    key.position.set(-8.2, 14.2, 9.0);
    key.castShadow = castShadows;
    const mapSize = this.quality === 'high' ? 2048 : 1024;
    key.shadow.mapSize.set(mapSize, mapSize);
    key.shadow.camera.left = -16;
    key.shadow.camera.right = 16;
    key.shadow.camera.top = 13;
    key.shadow.camera.bottom = -13;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 38;
    key.shadow.bias = -0.00028;
    key.shadow.normalBias = 0.028;
    key.shadow.radius = this.quality === 'high' ? 2.5 : 1.2;
    this.add(key);

    const rim = new THREE.DirectionalLight('#7fd4cc', 0.95);
    rim.name = 'arena-cool-rim';
    rim.position.set(9.5, 6.5, -11.5);
    this.add(rim);

    const fill = new THREE.DirectionalLight('#d8e8f0', 0.38);
    fill.name = 'arena-soft-fill';
    fill.position.set(4.5, 7.0, 6.0);
    this.add(fill);

    const bounce = new THREE.DirectionalLight('#f5e6c8', 0.22);
    bounce.name = 'arena-floor-bounce';
    bounce.position.set(0, -2.5, 2);
    this.add(bounce);

    return key;
  }

  private updateWater(time: number): void {
    const position = this.waterGeometry.getAttribute('position') as THREE.BufferAttribute;
    const count = position.count;
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      const x = this.waterBasePositions[offset] ?? 0;
      const z = this.waterBasePositions[offset + 2] ?? 0;
      const wave = Math.sin(x * 1.6 + time * 1.15) * 0.018
        + Math.sin(x * 4.3 - time * 1.8 + z * 3.1) * 0.007;
      position.setY(index, wave);
    }
    position.needsUpdate = true;
    this.waterGeometry.computeVertexNormals();
  }

  private updateBanners(time: number): void {
    for (const record of this.banners) {
      const position = record.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let index = 0; index < position.count; index += 1) {
        const offset = index * 3;
        const x = record.basePositions[offset] ?? 0;
        const y = record.basePositions[offset + 1] ?? 0;
        const freeEdge = THREE.MathUtils.clamp((-y - 0.05) / 2.7, 0, 1);
        const ripple = Math.sin(time * 1.75 + record.phase + x * 3.6 - y * 1.15) * 0.12 * freeEdge;
        const crossRipple = Math.sin(time * 0.72 + record.phase * 1.7 - y * 2.5) * 0.045 * freeEdge;
        position.setZ(index, ripple + crossRipple);
      }
      position.needsUpdate = true;
      record.mesh.geometry.computeVertexNormals();
    }
  }

  private updateFoliage(time: number): void {
    for (let index = 0; index < this.foliageRecords.length; index += 1) {
      const record = this.foliageRecords[index];
      if (record) this.setFoliageMatrix(this.foliage, index, record, time);
    }
    this.foliage.instanceMatrix.needsUpdate = true;
  }

  private setFoliageMatrix(
    mesh: THREE.InstancedMesh,
    index: number,
    record: FoliageRecord,
    time: number,
  ): void {
    const sway = Math.sin(time * 1.4 + record.phase) * 0.075;
    const crossSway = Math.cos(time * 0.92 + record.phase * 1.8) * 0.045;
    this.dummy.position.copy(record.position);
    this.dummy.rotation.set(sway, record.rotation, crossSway);
    this.dummy.scale.set(record.scale * 0.72, record.scale, record.scale * 0.72);
    this.dummy.updateMatrix();
    mesh.setMatrixAt(index, this.dummy.matrix);
  }

  private updateDrones(time: number): void {
    for (let index = 0; index < this.droneRecords.length; index += 1) {
      const record = this.droneRecords[index];
      if (record) this.setDroneMatrix(this.drones, index, record, time);
    }
    this.drones.instanceMatrix.needsUpdate = true;
  }

  private setDroneMatrix(
    mesh: THREE.InstancedMesh,
    index: number,
    record: DroneRecord,
    time: number,
  ): void {
    const angle = record.angle + time * record.speed;
    const bob = Math.sin(time * 0.9 + record.phase) * 0.22;
    this.dummy.position.set(
      Math.cos(angle) * record.radiusX,
      record.height + bob,
      Math.sin(angle) * record.radiusZ,
    );
    this.dummy.rotation.set(time * 0.08 + record.phase, -angle, Math.sin(time * 0.4 + record.phase) * 0.2);
    this.dummy.scale.setScalar(record.scale);
    this.dummy.updateMatrix();
    mesh.setMatrixAt(index, this.dummy.matrix);
  }

  private updatePollen(time: number): void {
    const position = this.pollenGeometry.getAttribute('position') as THREE.BufferAttribute;
    for (let index = 0; index < position.count; index += 1) {
      const offset = index * 3;
      const baseX = this.pollenBasePositions[offset] ?? 0;
      const baseY = this.pollenBasePositions[offset + 1] ?? 0;
      const baseZ = this.pollenBasePositions[offset + 2] ?? 0;
      const phase = index * 0.618;
      position.setXYZ(
        index,
        baseX + Math.sin(time * 0.19 + phase) * 0.34,
        0.3 + ((baseY + time * (0.025 + (index % 7) * 0.003)) % 4.85),
        baseZ + Math.cos(time * 0.16 + phase * 1.4) * 0.26,
      );
    }
    position.needsUpdate = true;
  }
}

export function createLivingArena(options: LivingArenaOptions = {}): LivingArena {
  return new LivingArena(options);
}
