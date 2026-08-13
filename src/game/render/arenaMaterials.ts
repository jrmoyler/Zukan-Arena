import * as THREE from 'three';

export type ArenaQuality = 'low' | 'medium' | 'high';

export type ArenaMaterialSet = {
  limestone: THREE.MeshStandardMaterial;
  ceramic: THREE.MeshPhysicalMaterial;
  traction: THREE.MeshStandardMaterial;
  champagne: THREE.MeshPhysicalMaterial;
  bronze: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  water: THREE.MeshPhysicalMaterial;
  foliage: THREE.MeshStandardMaterial;
  moss: THREE.MeshStandardMaterial;
  signalFabric: THREE.MeshStandardMaterial;
  riftFabric: THREE.MeshStandardMaterial;
  drone: THREE.MeshPhysicalMaterial;
  pollen: THREE.PointsMaterial;
  dispose: () => void;
};

type SurfaceMaps = {
  color: THREE.DataTexture;
  normal: THREE.DataTexture;
  roughness: THREE.DataTexture;
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

function smoothNoise(size: number, seed: number): Float32Array {
  const random = mulberry32(seed);
  const coarseSize = Math.max(8, Math.round(size / 8));
  const coarse = new Float32Array(coarseSize * coarseSize);
  for (let index = 0; index < coarse.length; index += 1) coarse[index] = random();

  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sourceX = (x / size) * coarseSize;
      const sourceY = (y / size) * coarseSize;
      const x0 = Math.floor(sourceX) % coarseSize;
      const y0 = Math.floor(sourceY) % coarseSize;
      const x1 = (x0 + 1) % coarseSize;
      const y1 = (y0 + 1) % coarseSize;
      const tx = sourceX - Math.floor(sourceX);
      const ty = sourceY - Math.floor(sourceY);
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const a = THREE.MathUtils.lerp(coarse[y0 * coarseSize + x0] ?? 0.5, coarse[y0 * coarseSize + x1] ?? 0.5, sx);
      const b = THREE.MathUtils.lerp(coarse[y1 * coarseSize + x0] ?? 0.5, coarse[y1 * coarseSize + x1] ?? 0.5, sx);
      const grain = random() * 0.12;
      height[y * size + x] = THREE.MathUtils.clamp(THREE.MathUtils.lerp(a, b, sy) * 0.88 + grain, 0, 1);
    }
  }
  return height;
}

function configureTexture(texture: THREE.DataTexture, colorSpace: THREE.ColorSpace): THREE.DataTexture {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = colorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createSurfaceMaps(
  size: number,
  seed: number,
  baseColor: THREE.ColorRepresentation,
  variation: number,
  normalStrength: number,
  roughnessBase: number,
): SurfaceMaps {
  const height = smoothNoise(size, seed);
  // THREE.Color stores working-space linear values. The byte texture is tagged
  // sRGB, so encode the authored colour back to sRGB before writing its texels.
  const base = new THREE.Color(baseColor).convertLinearToSRGB();
  const colorBytes = new Uint8Array(size * size * 4);
  const normalBytes = new Uint8Array(size * size * 4);
  const roughnessBytes = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const pixel = y * size + x;
      const offset = pixel * 4;
      const sample = height[pixel] ?? 0.5;
      const left = height[y * size + ((x - 1 + size) % size)] ?? sample;
      const right = height[y * size + ((x + 1) % size)] ?? sample;
      const down = height[((y - 1 + size) % size) * size + x] ?? sample;
      const up = height[((y + 1) % size) * size + x] ?? sample;
      const shade = 1 + (sample - 0.5) * variation;
      const normalX = (left - right) * normalStrength;
      const normalY = (down - up) * normalStrength;
      const inverseNormalLength = 1 / Math.hypot(normalX, normalY, 1);
      const roughness = THREE.MathUtils.clamp(roughnessBase + (sample - 0.5) * 0.25, 0, 1);

      colorBytes[offset] = Math.round(THREE.MathUtils.clamp(base.r * shade, 0, 1) * 255);
      colorBytes[offset + 1] = Math.round(THREE.MathUtils.clamp(base.g * shade, 0, 1) * 255);
      colorBytes[offset + 2] = Math.round(THREE.MathUtils.clamp(base.b * shade, 0, 1) * 255);
      colorBytes[offset + 3] = 255;
      normalBytes[offset] = Math.round((normalX * inverseNormalLength * 0.5 + 0.5) * 255);
      normalBytes[offset + 1] = Math.round((normalY * inverseNormalLength * 0.5 + 0.5) * 255);
      normalBytes[offset + 2] = Math.round((inverseNormalLength * 0.5 + 0.5) * 255);
      normalBytes[offset + 3] = 255;
      const roughnessByte = Math.round(roughness * 255);
      roughnessBytes[offset] = roughnessByte;
      roughnessBytes[offset + 1] = roughnessByte;
      roughnessBytes[offset + 2] = roughnessByte;
      roughnessBytes[offset + 3] = 255;
    }
  }

  const color = configureTexture(
    new THREE.DataTexture(colorBytes, size, size, THREE.RGBAFormat, THREE.UnsignedByteType),
    THREE.SRGBColorSpace,
  );
  const normal = configureTexture(
    new THREE.DataTexture(normalBytes, size, size, THREE.RGBAFormat, THREE.UnsignedByteType),
    THREE.NoColorSpace,
  );
  const roughness = configureTexture(
    new THREE.DataTexture(roughnessBytes, size, size, THREE.RGBAFormat, THREE.UnsignedByteType),
    THREE.NoColorSpace,
  );
  return { color, normal, roughness };
}

function repeatMaps(maps: SurfaceMaps, x: number, y: number): void {
  maps.color.repeat.set(x, y);
  maps.normal.repeat.set(x, y);
  maps.roughness.repeat.set(x, y);
}

export function createArenaMaterials(quality: ArenaQuality = 'high'): ArenaMaterialSet {
  const mapSize = quality === 'high' ? 192 : quality === 'medium' ? 128 : 64;
  const limestoneMaps = createSurfaceMaps(mapSize, 0x51a7e, '#d8cbb4', 0.14, 5.5, 0.82);
  const tractionMaps = createSurfaceMaps(mapSize, 0x7ac710, '#172229', 0.2, 8, 0.6);
  repeatMaps(limestoneMaps, 7, 5);
  repeatMaps(tractionMaps, 9, 6);

  const limestone = new THREE.MeshStandardMaterial({
    name: 'arena-limestone',
    map: limestoneMaps.color,
    normalMap: limestoneMaps.normal,
    normalScale: new THREE.Vector2(0.42, 0.42),
    roughnessMap: limestoneMaps.roughness,
    color: '#fff8e9',
    roughness: 0.86,
    metalness: 0,
  });
  const ceramic = new THREE.MeshPhysicalMaterial({
    name: 'arena-porcelain',
    color: '#f2ead8',
    roughness: 0.3,
    metalness: 0,
    clearcoat: 0.26,
    clearcoatRoughness: 0.42,
    envMapIntensity: 0.85,
  });
  const traction = new THREE.MeshStandardMaterial({
    name: 'arena-traction',
    map: tractionMaps.color,
    normalMap: tractionMaps.normal,
    normalScale: new THREE.Vector2(0.55, 0.55),
    roughnessMap: tractionMaps.roughness,
    color: '#26343b',
    roughness: 0.62,
    metalness: 0.07,
  });
  const champagne = new THREE.MeshPhysicalMaterial({
    name: 'arena-champagne-metal',
    color: '#c8aa6e',
    roughness: 0.24,
    metalness: 0.92,
    clearcoat: 0.18,
    clearcoatRoughness: 0.32,
    envMapIntensity: 1.3,
  });
  const bronze = new THREE.MeshStandardMaterial({
    name: 'arena-oxidized-bronze',
    color: '#55786f',
    roughness: 0.52,
    metalness: 0.63,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    name: 'arena-tempered-glass',
    color: '#cceee5',
    roughness: 0.16,
    metalness: 0,
    transmission: quality === 'low' ? 0 : 0.72,
    thickness: 0.22,
    ior: 1.48,
    transparent: true,
    opacity: quality === 'low' ? 0.28 : 0.52,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity: 1.1,
  });
  const water = new THREE.MeshPhysicalMaterial({
    name: 'arena-water',
    color: '#73c9bb',
    emissive: '#123832',
    emissiveIntensity: 0.13,
    roughness: 0.12,
    metalness: 0,
    transmission: quality === 'low' ? 0 : 0.62,
    thickness: 0.32,
    ior: 1.333,
    transparent: true,
    opacity: quality === 'low' ? 0.72 : 0.8,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity: 1.15,
  });
  const foliage = new THREE.MeshStandardMaterial({
    name: 'arena-foliage',
    color: '#496f48',
    roughness: 0.78,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const moss = new THREE.MeshStandardMaterial({
    name: 'arena-moss',
    color: '#6f8250',
    roughness: 0.96,
    metalness: 0,
  });
  const signalFabric = new THREE.MeshStandardMaterial({
    name: 'arena-signal-banner',
    color: '#2c9e8d',
    emissive: '#0a302b',
    emissiveIntensity: 0.12,
    roughness: 0.74,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const riftFabric = new THREE.MeshStandardMaterial({
    name: 'arena-rift-banner',
    color: '#ad657d',
    emissive: '#32131f',
    emissiveIntensity: 0.1,
    roughness: 0.74,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const drone = new THREE.MeshPhysicalMaterial({
    name: 'arena-drone',
    color: '#87745a',
    emissive: '#d7c59e',
    emissiveIntensity: 0.35,
    roughness: 0.3,
    metalness: 0.82,
    clearcoat: 0.28,
  });
  const pollen = new THREE.PointsMaterial({
    name: 'arena-pollen',
    color: '#f0dba8',
    size: quality === 'low' ? 0.035 : 0.048,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const materials: THREE.Material[] = [
    limestone,
    ceramic,
    traction,
    champagne,
    bronze,
    glass,
    water,
    foliage,
    moss,
    signalFabric,
    riftFabric,
    drone,
    pollen,
  ];
  const textures: THREE.Texture[] = [
    limestoneMaps.color,
    limestoneMaps.normal,
    limestoneMaps.roughness,
    tractionMaps.color,
    tractionMaps.normal,
    tractionMaps.roughness,
  ];

  return {
    limestone,
    ceramic,
    traction,
    champagne,
    bronze,
    glass,
    water,
    foliage,
    moss,
    signalFabric,
    riftFabric,
    drone,
    pollen,
    dispose: () => {
      for (const material of materials) material.dispose();
      for (const texture of textures) texture.dispose();
    },
  };
}
