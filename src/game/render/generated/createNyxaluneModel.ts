// @ts-nocheck -- deterministic img2threejs codegen artifact, validated by its forge contract.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
}

function buildTubeGeometry(
  path: { points: [number, number, number][]; radius?: number; radialSegments?: number; closed?: boolean },
): THREE.TubeGeometry {
  const vectors = path.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(vectors, path.closed ?? false);
  const tubularSegments = Math.max(8, path.points.length * 6);
  return new THREE.TubeGeometry(curve, tubularSegments, path.radius ?? 0.05, path.radialSegments ?? 8, path.closed ?? false);
}

// Plan 1.3 F.6 — sweep a thin 2D cross-section along a 3D spine so a curved
// form (hooked blade, handle) reads correctly from EVERY camera angle, not just
// the reference angle a flat extrude happens to match. Uses ExtrudeGeometry's
// native extrudePath; bevelEnabled: false keeps sharp tips (same rule as F.5).
function buildCurveSweepGeometry(
  sweep: { spine: [number, number, number][]; crossSection: { points: [number, number][] }; closed?: boolean },
): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  const cs = sweep.crossSection.points;
  if (cs.length > 0) {
    shape.moveTo(cs[0][0], cs[0][1]);
    for (let i = 1; i < cs.length; i += 1) shape.lineTo(cs[i][0], cs[i][1]);
    shape.closePath();
  }
  const spine = sweep.spine.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const path = new THREE.CatmullRomCurve3(spine, sweep.closed ?? false);
  return new THREE.ExtrudeGeometry(shape, {
    extrudePath: path,
    steps: Math.max(24, spine.length * 8),
    bevelEnabled: false,
  });
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = typeof document === 'undefined'
    ? new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, THREE.RGBAFormat)
    : new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions): THREE.MeshPhysicalMaterial {
  const textures = makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : new THREE.Color(typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F'),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clamp01(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: Math.max(1, readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: Math.max(1, readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clamp01(readLayerNumber(spec.specularIntensity, ['base'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    if (bumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = bumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    if (displacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = displacementScale;
      material.displacementBias = -displacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Nyxalune Zukan fighter rig family
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createNyxaluneZukanFighterRigFamilyModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Nyxalune Zukan fighter rig family";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 34, "aspect": 0.6709, "orientation": {"yaw": 6, "pitch": -3, "roll": 0}, "positionHint": [0, 1.35, 4.8], "note": "Final camera match must be confirmed by overlay review: render the fitted mesh from this camera, place it beside or over the reference image, and adjust fovDegrees/orientation/position until silhouette and landmark alignment match before trusting projected texture bakes."}, "approximationNotes": []};

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["projection-front"] = createSculptMaterial(
    "projection-front",
    {"id": "projection-front", "name": "Projected front albedo", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#454b7b", "color": "#454b7b", "qualityTier": "hero", "materialClass": "fabric", "albedo": {"dominant": "#454b7b", "secondary": ["#EEE7DD", "#484D75", "#23273E", "#817B87"], "samplingNotes": "Verified material crop; projection front remains identity-authoritative.", "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_albedo.png", "url": "/textures/nyxalune/skin/skin-indigo_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#EEE7DD", "#484D75", "#23273E", "#817B87", "#B7A690"], "pattern": "reference-derived regional variation", "amplitude": 0.18, "heightCorrelation": 0.24}, "textureResolution": 1024, "textureProjection": {"mode": "perspective-camera-projection", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "1024 combat maps with consistent object-space scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.5, "amplitude": 0.2, "role": "broad value zones"}, {"id": "meso", "frequency": 12, "amplitude": 0.11, "role": "armor seams, cloth folds, scale clusters"}, {"id": "micro", "frequency": 58, "amplitude": 0.035, "role": "grazing-light highlight breakup"}], "roughness": {"base": 0.44, "variation": 0.12, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_roughness.png", "url": "/textures/nyxalune/skin/skin-indigo_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "Cavities rougher; exposed trim and eye surfaces smoother."}, "metalness": {"base": 0, "variation": 0}, "normal": {"pattern": "reference-derived height-gradient", "strength": 0.2, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_normal.png", "url": "/textures/nyxalune/skin/skin-indigo_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_height.png", "url": "/textures/nyxalune/skin/skin-indigo_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.025, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_height.png", "url": "/textures/nyxalune/skin/skin-indigo_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.34, "contactShadowBias": 0.35, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_ao.png", "url": "/textures/nyxalune/skin/skin-indigo_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Independent AO evidence; dynamic contact shadow remains separate."}, "wear": {"edgeWear": 0.03, "scratches": [], "chips": []}, "dirt": {"amount": 0.025, "cavityBias": 0.25, "color": "#181a24"}, "localOverrides": [{"id": "projection-front-regional-response", "type": "material-map-evidence", "roughness": 0.36, "evidenceRefs": ["full-object"], "notes": "Reference-derived channel separation with independent PBR maps."}], "clearcoat": 0.08, "shaderNotes": ["Use independent albedo, roughness, normal, height, and AO channels.", "Projection is front-facing only; unseen regions use palette continuation."], "notes": "Single-image material evidence; verified again under neutral and grazing lights.", "referencePbr": {"version": "1.0", "sourceImage": "/workspace/scratch/363230f53301/docs/material-crops/skin-head.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "Single-view maps are reference-derived estimates.", "maps": {"albedo": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_albedo.png", "url": "/textures/nyxalune/skin/skin-indigo_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_roughness.png", "url": "/textures/nyxalune/skin/skin-indigo_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_height.png", "url": "/textures/nyxalune/skin/skin-indigo_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_normal.png", "url": "/textures/nyxalune/skin/skin-indigo_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_ao.png", "url": "/textures/nyxalune/skin/skin-indigo_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 260, "sourceHeight": 220, "mapSize": 1024, "cropBBoxPixels": {"x": 1, "y": 0, "width": 259, "height": 220}, "mask": {"backgroundColor": "#C5B8AA", "backgroundNoise": 27.749, "transparentPixelFraction": 0, "foregroundCoverage": 0.6803}, "mapStats": {"valueRange": 0.8177, "heightP90Gradient": 0.06307, "roughnessBase": 0.694, "roughnessVariation": 0.115, "normalStrength": 0.23, "blurRadius": 21}, "palette": ["#EEE7DD", "#484D75", "#23273E", "#817B87", "#B7A690"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["skin-indigo"] = createSculptMaterial(
    "skin-indigo",
    {"id": "skin-indigo", "name": "Indigo satin scales", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#343965", "color": "#343965", "qualityTier": "hero", "materialClass": "skin", "albedo": {"dominant": "#343965", "secondary": ["#EEE7DD", "#484D75", "#23273E", "#817B87"], "samplingNotes": "Verified material crop; projection front remains identity-authoritative.", "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_albedo.png", "url": "/textures/nyxalune/skin/skin-indigo_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#EEE7DD", "#484D75", "#23273E", "#817B87", "#B7A690"], "pattern": "reference-derived regional variation", "amplitude": 0.18, "heightCorrelation": 0.24}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "1024 combat maps with consistent object-space scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.5, "amplitude": 0.2, "role": "broad value zones"}, {"id": "meso", "frequency": 12, "amplitude": 0.11, "role": "armor seams, cloth folds, scale clusters"}, {"id": "micro", "frequency": 58, "amplitude": 0.035, "role": "grazing-light highlight breakup"}], "roughness": {"base": 0.46, "variation": 0.12, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_roughness.png", "url": "/textures/nyxalune/skin/skin-indigo_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "Cavities rougher; exposed trim and eye surfaces smoother."}, "metalness": {"base": 0, "variation": 0}, "normal": {"pattern": "reference-derived height-gradient", "strength": 0.2, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_normal.png", "url": "/textures/nyxalune/skin/skin-indigo_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_height.png", "url": "/textures/nyxalune/skin/skin-indigo_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.025, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_height.png", "url": "/textures/nyxalune/skin/skin-indigo_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.34, "contactShadowBias": 0.35, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_ao.png", "url": "/textures/nyxalune/skin/skin-indigo_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Independent AO evidence; dynamic contact shadow remains separate."}, "wear": {"edgeWear": 0.03, "scratches": [], "chips": []}, "dirt": {"amount": 0.025, "cavityBias": 0.25, "color": "#181a24"}, "localOverrides": [{"id": "skin-indigo-regional-response", "type": "material-map-evidence", "roughness": 0.38, "evidenceRefs": ["full-object"], "notes": "Reference-derived channel separation with independent PBR maps."}], "clearcoat": 0.08, "shaderNotes": ["Use independent albedo, roughness, normal, height, and AO channels.", "Projection is front-facing only; unseen regions use palette continuation."], "notes": "Single-image material evidence; verified again under neutral and grazing lights.", "referencePbr": {"version": "1.0", "sourceImage": "/workspace/scratch/363230f53301/docs/material-crops/skin-head.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "Single-view maps are reference-derived estimates.", "maps": {"albedo": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_albedo.png", "url": "/textures/nyxalune/skin/skin-indigo_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_roughness.png", "url": "/textures/nyxalune/skin/skin-indigo_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_height.png", "url": "/textures/nyxalune/skin/skin-indigo_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_normal.png", "url": "/textures/nyxalune/skin/skin-indigo_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_ao.png", "url": "/textures/nyxalune/skin/skin-indigo_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 260, "sourceHeight": 220, "mapSize": 1024, "cropBBoxPixels": {"x": 1, "y": 0, "width": 259, "height": 220}, "mask": {"backgroundColor": "#C5B8AA", "backgroundNoise": 27.749, "transparentPixelFraction": 0, "foregroundCoverage": 0.6803}, "mapStats": {"valueRange": 0.8177, "heightP90Gradient": 0.06307, "roughnessBase": 0.694, "roughnessVariation": 0.115, "normalStrength": 0.23, "blurRadius": 21}, "palette": ["#EEE7DD", "#484D75", "#23273E", "#817B87", "#B7A690"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["armor-ivory"] = createSculptMaterial(
    "armor-ivory",
    {"id": "armor-ivory", "name": "Warm ivory armor", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#d8cbb9", "color": "#d8cbb9", "qualityTier": "hero", "materialClass": "ceramic", "albedo": {"dominant": "#d8cbb9", "secondary": ["#2C3049", "#454869", "#161B2D", "#736B69"], "samplingNotes": "Verified material crop; projection front remains identity-authoritative.", "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/armor/armor-ivory_albedo.png", "url": "/textures/nyxalune/armor/armor-ivory_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#2C3049", "#454869", "#161B2D", "#736B69", "#B0A291"], "pattern": "reference-derived regional variation", "amplitude": 0.18, "heightCorrelation": 0.24}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "1024 combat maps with consistent object-space scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.5, "amplitude": 0.2, "role": "broad value zones"}, {"id": "meso", "frequency": 12, "amplitude": 0.11, "role": "armor seams, cloth folds, scale clusters"}, {"id": "micro", "frequency": 58, "amplitude": 0.035, "role": "grazing-light highlight breakup"}], "roughness": {"base": 0.36, "variation": 0.12, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/armor/armor-ivory_roughness.png", "url": "/textures/nyxalune/armor/armor-ivory_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "Cavities rougher; exposed trim and eye surfaces smoother."}, "metalness": {"base": 0, "variation": 0}, "normal": {"pattern": "reference-derived height-gradient", "strength": 0.2, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/armor/armor-ivory_normal.png", "url": "/textures/nyxalune/armor/armor-ivory_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/armor/armor-ivory_height.png", "url": "/textures/nyxalune/armor/armor-ivory_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.025, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/armor/armor-ivory_height.png", "url": "/textures/nyxalune/armor/armor-ivory_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.34, "contactShadowBias": 0.35, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/armor/armor-ivory_ao.png", "url": "/textures/nyxalune/armor/armor-ivory_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Independent AO evidence; dynamic contact shadow remains separate."}, "wear": {"edgeWear": 0.03, "scratches": [], "chips": []}, "dirt": {"amount": 0.025, "cavityBias": 0.25, "color": "#181a24"}, "localOverrides": [{"id": "armor-ivory-regional-response", "type": "material-map-evidence", "roughness": 0.27999999999999997, "evidenceRefs": ["full-object"], "notes": "Reference-derived channel separation with independent PBR maps."}], "clearcoat": 0.08, "shaderNotes": ["Use independent albedo, roughness, normal, height, and AO channels.", "Projection is front-facing only; unseen regions use palette continuation."], "notes": "Single-image material evidence; verified again under neutral and grazing lights.", "referencePbr": {"version": "1.0", "sourceImage": "/workspace/scratch/363230f53301/docs/material-crops/armor-cloth.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "Single-view maps are reference-derived estimates.", "maps": {"albedo": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/armor/armor-ivory_albedo.png", "url": "/textures/nyxalune/armor/armor-ivory_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/armor/armor-ivory_roughness.png", "url": "/textures/nyxalune/armor/armor-ivory_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/armor/armor-ivory_height.png", "url": "/textures/nyxalune/armor/armor-ivory_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/armor/armor-ivory_normal.png", "url": "/textures/nyxalune/armor/armor-ivory_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/armor/armor-ivory_ao.png", "url": "/textures/nyxalune/armor/armor-ivory_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 250, "sourceHeight": 250, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 250, "height": 250}, "mask": {"backgroundColor": "#DACCBF", "backgroundNoise": 61.131, "transparentPixelFraction": 0, "foregroundCoverage": 0.6566}, "mapStats": {"valueRange": 0.5577, "heightP90Gradient": 0.08433, "roughnessBase": 0.722, "roughnessVariation": 0.157, "normalStrength": 0.255, "blurRadius": 21}, "palette": ["#2C3049", "#454869", "#161B2D", "#736B69", "#B0A291"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["crest-metal"] = createSculptMaterial(
    "crest-metal",
    {"id": "crest-metal", "name": "Antique gold trim", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#b99b61", "color": "#b99b61", "qualityTier": "hero", "materialClass": "metal", "albedo": {"dominant": "#b99b61", "secondary": ["#4B507E", "#2C3150", "#73749E", "#C3B092"], "samplingNotes": "Verified material crop; projection front remains identity-authoritative.", "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/gold/crest-metal_albedo.png", "url": "/textures/nyxalune/gold/crest-metal_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#4B507E", "#2C3150", "#73749E", "#C3B092", "#7C6F60"], "pattern": "reference-derived regional variation", "amplitude": 0.18, "heightCorrelation": 0.24}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "1024 combat maps with consistent object-space scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.5, "amplitude": 0.2, "role": "broad value zones"}, {"id": "meso", "frequency": 12, "amplitude": 0.11, "role": "armor seams, cloth folds, scale clusters"}, {"id": "micro", "frequency": 58, "amplitude": 0.035, "role": "grazing-light highlight breakup"}], "roughness": {"base": 0.24, "variation": 0.12, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/gold/crest-metal_roughness.png", "url": "/textures/nyxalune/gold/crest-metal_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "Cavities rougher; exposed trim and eye surfaces smoother."}, "metalness": {"base": 0.82, "variation": 0.12}, "normal": {"pattern": "reference-derived height-gradient", "strength": 0.2, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/gold/crest-metal_normal.png", "url": "/textures/nyxalune/gold/crest-metal_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/gold/crest-metal_height.png", "url": "/textures/nyxalune/gold/crest-metal_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.025, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/gold/crest-metal_height.png", "url": "/textures/nyxalune/gold/crest-metal_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.34, "contactShadowBias": 0.35, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/gold/crest-metal_ao.png", "url": "/textures/nyxalune/gold/crest-metal_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Independent AO evidence; dynamic contact shadow remains separate."}, "wear": {"edgeWear": 0.12, "scratches": [], "chips": []}, "dirt": {"amount": 0.025, "cavityBias": 0.25, "color": "#181a24"}, "localOverrides": [{"id": "crest-metal-regional-response", "type": "material-map-evidence", "roughness": 0.15999999999999998, "evidenceRefs": ["full-object"], "notes": "Reference-derived channel separation with independent PBR maps."}], "clearcoat": 0.32, "shaderNotes": ["Use independent albedo, roughness, normal, height, and AO channels.", "Projection is front-facing only; unseen regions use palette continuation."], "notes": "Single-image material evidence; verified again under neutral and grazing lights.", "referencePbr": {"version": "1.0", "sourceImage": "/workspace/scratch/363230f53301/docs/material-crops/crest-gold.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "Single-view maps are reference-derived estimates.", "maps": {"albedo": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/gold/crest-metal_albedo.png", "url": "/textures/nyxalune/gold/crest-metal_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/gold/crest-metal_roughness.png", "url": "/textures/nyxalune/gold/crest-metal_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/gold/crest-metal_height.png", "url": "/textures/nyxalune/gold/crest-metal_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/gold/crest-metal_normal.png", "url": "/textures/nyxalune/gold/crest-metal_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/gold/crest-metal_ao.png", "url": "/textures/nyxalune/gold/crest-metal_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 170, "sourceHeight": 140, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 31, "width": 157, "height": 109}, "mask": {"backgroundColor": "#E9E2D9", "backgroundNoise": 62.753, "transparentPixelFraction": 0, "foregroundCoverage": 0.5055}, "mapStats": {"valueRange": 0.5459, "heightP90Gradient": 0.05874, "roughnessBase": 0.694, "roughnessVariation": 0.108, "normalStrength": 0.225, "blurRadius": 21}, "palette": ["#4B507E", "#2C3150", "#73749E", "#C3B092", "#7C6F60"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["cape-cloth"] = createSculptMaterial(
    "cape-cloth",
    {"id": "cape-cloth", "name": "Indigo embroidered cloth", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#1d233c", "color": "#1d233c", "qualityTier": "hero", "materialClass": "fabric", "albedo": {"dominant": "#1d233c", "secondary": ["#1E2337", "#3F4055", "#F7EFE4", "#716963"], "samplingNotes": "Verified material crop; projection front remains identity-authoritative.", "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/cape/cape-cloth_albedo.png", "url": "/textures/nyxalune/cape/cape-cloth_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#1E2337", "#3F4055", "#F7EFE4", "#716963", "#AC9E8A"], "pattern": "reference-derived regional variation", "amplitude": 0.18, "heightCorrelation": 0.24}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "1024 combat maps with consistent object-space scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.5, "amplitude": 0.2, "role": "broad value zones"}, {"id": "meso", "frequency": 12, "amplitude": 0.11, "role": "armor seams, cloth folds, scale clusters"}, {"id": "micro", "frequency": 58, "amplitude": 0.035, "role": "grazing-light highlight breakup"}], "roughness": {"base": 0.72, "variation": 0.12, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/cape/cape-cloth_roughness.png", "url": "/textures/nyxalune/cape/cape-cloth_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "Cavities rougher; exposed trim and eye surfaces smoother."}, "metalness": {"base": 0, "variation": 0}, "normal": {"pattern": "reference-derived height-gradient", "strength": 0.28, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/cape/cape-cloth_normal.png", "url": "/textures/nyxalune/cape/cape-cloth_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/cape/cape-cloth_height.png", "url": "/textures/nyxalune/cape/cape-cloth_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.025, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/cape/cape-cloth_height.png", "url": "/textures/nyxalune/cape/cape-cloth_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.34, "contactShadowBias": 0.35, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/cape/cape-cloth_ao.png", "url": "/textures/nyxalune/cape/cape-cloth_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Independent AO evidence; dynamic contact shadow remains separate."}, "wear": {"edgeWear": 0.03, "scratches": [], "chips": []}, "dirt": {"amount": 0.025, "cavityBias": 0.25, "color": "#181a24"}, "localOverrides": [{"id": "cape-cloth-regional-response", "type": "material-map-evidence", "roughness": 0.64, "evidenceRefs": ["full-object"], "notes": "Reference-derived channel separation with independent PBR maps."}], "clearcoat": 0.08, "shaderNotes": ["Use independent albedo, roughness, normal, height, and AO channels.", "Projection is front-facing only; unseen regions use palette continuation."], "notes": "Single-image material evidence; verified again under neutral and grazing lights.", "referencePbr": {"version": "1.0", "sourceImage": "/workspace/scratch/363230f53301/docs/material-crops/cape.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "Single-view maps are reference-derived estimates.", "maps": {"albedo": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/cape/cape-cloth_albedo.png", "url": "/textures/nyxalune/cape/cape-cloth_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/cape/cape-cloth_roughness.png", "url": "/textures/nyxalune/cape/cape-cloth_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/cape/cape-cloth_height.png", "url": "/textures/nyxalune/cape/cape-cloth_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/cape/cape-cloth_normal.png", "url": "/textures/nyxalune/cape/cape-cloth_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/cape/cape-cloth_ao.png", "url": "/textures/nyxalune/cape/cape-cloth_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 310, "sourceHeight": 260, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 310, "height": 260}, "mask": {"backgroundColor": "#BCB0A2", "backgroundNoise": 41.049, "transparentPixelFraction": 0, "foregroundCoverage": 0.6348}, "mapStats": {"valueRange": 0.8477, "heightP90Gradient": 0.06807, "roughnessBase": 0.716, "roughnessVariation": 0.129, "normalStrength": 0.236, "blurRadius": 21}, "palette": ["#1E2337", "#3F4055", "#F7EFE4", "#716963", "#AC9E8A"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["eye-glass"] = createSculptMaterial(
    "eye-glass",
    {"id": "eye-glass", "name": "Violet glossy eyes", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#5c568c", "color": "#5c568c", "qualityTier": "hero", "materialClass": "glass", "albedo": {"dominant": "#5c568c", "secondary": ["#383E65", "#595E8E", "#A89EA0", "#151A2E"], "samplingNotes": "Verified material crop; projection front remains identity-authoritative.", "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/eyes/eye-glass_albedo.png", "url": "/textures/nyxalune/eyes/eye-glass_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#383E65", "#595E8E", "#A89EA0", "#151A2E", "#847664"], "pattern": "reference-derived regional variation", "amplitude": 0.18, "heightCorrelation": 0.24}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "1024 combat maps with consistent object-space scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.5, "amplitude": 0.2, "role": "broad value zones"}, {"id": "meso", "frequency": 12, "amplitude": 0.11, "role": "armor seams, cloth folds, scale clusters"}, {"id": "micro", "frequency": 58, "amplitude": 0.035, "role": "grazing-light highlight breakup"}], "roughness": {"base": 0.12, "variation": 0.12, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/eyes/eye-glass_roughness.png", "url": "/textures/nyxalune/eyes/eye-glass_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "Cavities rougher; exposed trim and eye surfaces smoother."}, "metalness": {"base": 0, "variation": 0}, "normal": {"pattern": "reference-derived height-gradient", "strength": 0.2, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/eyes/eye-glass_normal.png", "url": "/textures/nyxalune/eyes/eye-glass_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/eyes/eye-glass_height.png", "url": "/textures/nyxalune/eyes/eye-glass_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.025, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/eyes/eye-glass_height.png", "url": "/textures/nyxalune/eyes/eye-glass_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.34, "contactShadowBias": 0.35, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/eyes/eye-glass_ao.png", "url": "/textures/nyxalune/eyes/eye-glass_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Independent AO evidence; dynamic contact shadow remains separate."}, "wear": {"edgeWear": 0.03, "scratches": [], "chips": []}, "dirt": {"amount": 0.025, "cavityBias": 0.25, "color": "#181a24"}, "localOverrides": [{"id": "eye-glass-regional-response", "type": "material-map-evidence", "roughness": 0.08, "evidenceRefs": ["full-object"], "notes": "Reference-derived channel separation with independent PBR maps."}], "clearcoat": 0.82, "shaderNotes": ["Use independent albedo, roughness, normal, height, and AO channels.", "Projection is front-facing only; unseen regions use palette continuation."], "notes": "Single-image material evidence; verified again under neutral and grazing lights.", "referencePbr": {"version": "1.0", "sourceImage": "/workspace/scratch/363230f53301/docs/material-crops/eyes.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "Single-view maps are reference-derived estimates.", "maps": {"albedo": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/eyes/eye-glass_albedo.png", "url": "/textures/nyxalune/eyes/eye-glass_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/eyes/eye-glass_roughness.png", "url": "/textures/nyxalune/eyes/eye-glass_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/eyes/eye-glass_height.png", "url": "/textures/nyxalune/eyes/eye-glass_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/eyes/eye-glass_normal.png", "url": "/textures/nyxalune/eyes/eye-glass_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/eyes/eye-glass_ao.png", "url": "/textures/nyxalune/eyes/eye-glass_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 230, "sourceHeight": 120, "mapSize": 1024, "cropBBoxPixels": {"x": 13, "y": 0, "width": 191, "height": 120}, "mask": {"backgroundColor": "#ECE3D6", "backgroundNoise": 38.794, "transparentPixelFraction": 0, "foregroundCoverage": 0.6865}, "mapStats": {"valueRange": 0.5572, "heightP90Gradient": 0.06721, "roughnessBase": 0.699, "roughnessVariation": 0.121, "normalStrength": 0.235, "blurRadius": 21}, "palette": ["#383E65", "#595E8E", "#A89EA0", "#151A2E", "#847664"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["hidden-shell"] = createSculptMaterial(
    "hidden-shell",
    {"id": "hidden-shell", "name": "Inferred rear shell", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#242945", "color": "#242945", "qualityTier": "hero", "materialClass": "skin", "albedo": {"dominant": "#242945", "secondary": ["#EEE7DD", "#484D75", "#23273E", "#817B87"], "samplingNotes": "Verified material crop; projection front remains identity-authoritative.", "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_albedo.png", "url": "/textures/nyxalune/skin/skin-indigo_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#EEE7DD", "#484D75", "#23273E", "#817B87", "#B7A690"], "pattern": "reference-derived regional variation", "amplitude": 0.18, "heightCorrelation": 0.24}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 8, "texelDensityIntent": "1024 combat maps with consistent object-space scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.5, "amplitude": 0.2, "role": "broad value zones"}, {"id": "meso", "frequency": 12, "amplitude": 0.11, "role": "armor seams, cloth folds, scale clusters"}, {"id": "micro", "frequency": 58, "amplitude": 0.035, "role": "grazing-light highlight breakup"}], "roughness": {"base": 0.54, "variation": 0.12, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_roughness.png", "url": "/textures/nyxalune/skin/skin-indigo_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "Cavities rougher; exposed trim and eye surfaces smoother."}, "metalness": {"base": 0, "variation": 0}, "normal": {"pattern": "reference-derived height-gradient", "strength": 0.2, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_normal.png", "url": "/textures/nyxalune/skin/skin-indigo_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_height.png", "url": "/textures/nyxalune/skin/skin-indigo_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.025, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_height.png", "url": "/textures/nyxalune/skin/skin-indigo_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.34, "contactShadowBias": 0.35, "map": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_ao.png", "url": "/textures/nyxalune/skin/skin-indigo_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Independent AO evidence; dynamic contact shadow remains separate."}, "wear": {"edgeWear": 0.03, "scratches": [], "chips": []}, "dirt": {"amount": 0.025, "cavityBias": 0.25, "color": "#181a24"}, "localOverrides": [{"id": "hidden-shell-regional-response", "type": "material-map-evidence", "roughness": 0.46, "evidenceRefs": ["full-object"], "notes": "Reference-derived channel separation with independent PBR maps."}], "clearcoat": 0.08, "shaderNotes": ["Use independent albedo, roughness, normal, height, and AO channels.", "Projection is front-facing only; unseen regions use palette continuation."], "notes": "Single-image material evidence; verified again under neutral and grazing lights.", "referencePbr": {"version": "1.0", "sourceImage": "/workspace/scratch/363230f53301/docs/material-crops/skin-head.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "Single-view maps are reference-derived estimates.", "maps": {"albedo": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_albedo.png", "url": "/textures/nyxalune/skin/skin-indigo_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_roughness.png", "url": "/textures/nyxalune/skin/skin-indigo_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_height.png", "url": "/textures/nyxalune/skin/skin-indigo_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_normal.png", "url": "/textures/nyxalune/skin/skin-indigo_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/workspace/scratch/363230f53301/public/textures/nyxalune/skin/skin-indigo_ao.png", "url": "/textures/nyxalune/skin/skin-indigo_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 260, "sourceHeight": 220, "mapSize": 1024, "cropBBoxPixels": {"x": 1, "y": 0, "width": 259, "height": 220}, "mask": {"backgroundColor": "#C5B8AA", "backgroundNoise": 27.749, "transparentPixelFraction": 0, "foregroundCoverage": 0.6803}, "mapStats": {"valueRange": 0.8177, "heightP90Gradient": 0.06307, "roughnessBase": 0.694, "roughnessVariation": 0.115, "normalStrength": 0.23, "blurRadius": 21}, "palette": ["#EEE7DD", "#484D75", "#23273E", "#817B87", "#B7A690"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const attachment_root_0 = null;
  const endpoint_root_0 = makeAttachmentEndpoint(attachment_root_0);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "Rig root__pivot";
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0, 0, 0);
    node_root_0.scale.set(1, 1, 1);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
    node_root_0.scale.set(1.0, 1.0, 1.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "Rig root", "level": "macro", "role": "root", "importance": 1, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rig root is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": null, "attachment": null, "dimensions": {"width": 0.9, "height": 0.2, "depth": 0.65, "units": "relative", "confidence": 0.76}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "root-socket", "localPosition": [0, 0.13, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.06, 0], "scale": [0.675, 0.15000000000000002, 0.48750000000000004], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "hidden-shell"}}, "material": "hidden-shell", "materialLayers": ["hidden-shell"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["root-motion"], "seams": [], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(36, 41, 69, 1)", "secondaryAlbedo": "rgba(52, 57, 101, 1)", "materialClass": "skin", "materialClassConfidence": 0.58, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(36, 41, 69, 1)"}, {"position": 1, "color": "rgba(52, 57, 101, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "hero"};
  node_root_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "root-socket", "localPosition": [0, 0.13, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.06, 0], "scale": [0.675, 0.15000000000000002, 0.48750000000000004], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "hidden-shell"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["hidden-shell"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "Rig root";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "Rig root", "level": "macro", "role": "root", "importance": 1, "confidence": 0.86, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rig root is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": null, "attachment": null, "dimensions": {"width": 0.9, "height": 0.2, "depth": 0.65, "units": "relative", "confidence": 0.76}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "root-socket", "localPosition": [0, 0.13, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.06, 0], "scale": [0.675, 0.15000000000000002, 0.48750000000000004], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "hidden-shell"}}, "material": "hidden-shell", "materialLayers": ["hidden-shell"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["root-motion"], "seams": [], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(36, 41, 69, 1)", "secondaryAlbedo": "rgba(52, 57, 101, 1)", "materialClass": "skin", "materialClassConfidence": 0.58, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(36, 41, 69, 1)"}, {"position": 1, "color": "rgba(52, 57, 101, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "hero"};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "capsule", "offset": [0, 0.06, 0], "scale": [0.675, 0.15000000000000002, 0.48750000000000004], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);
  const socket_root_root_socket_0 = new THREE.Object3D();
  socket_root_root_socket_0.name = "root-socket";
  socket_root_root_socket_0.position.set(0.0, 0.13, 0.0);
  socket_root_root_socket_0.rotation.set(0, 0, 0);
  socket_root_root_socket_0.userData.socket = {"id": "root-socket", "localPosition": [0, 0.13, 0], "purpose": "attachment"};
  node_root_0.add(socket_root_root_socket_0);
  sockets["root:root-socket"] = socket_root_root_socket_0;

  const attachment_pelvis_1 = {"parentId": "root", "parentSocket": "root-socket", "localStart": [0, 0.66, 0], "localEnd": [0, 0.998, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_pelvis_1 = makeAttachmentEndpoint(attachment_pelvis_1);
  const node_pelvis_1 = new THREE.Group();
  node_pelvis_1.name = "Pelvis core__pivot";
  if (endpoint_pelvis_1) {
    node_pelvis_1.position.copy(endpoint_pelvis_1.start);
    node_pelvis_1.rotation.set(0, 0, 0);
    node_pelvis_1.scale.set(1, 1, 1);
  } else {
    node_pelvis_1.position.set(0.0, 0.66, 0.0);
    node_pelvis_1.rotation.set(0.0, 0.0, 0.0);
    node_pelvis_1.scale.set(1.0, 1.0, 1.0);
  }
  node_pelvis_1.userData.sculptComponent = {"id": "pelvis", "name": "Pelvis core", "level": "macro", "role": "pelvis", "importance": 1, "confidence": 0.76, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Pelvis core is a smoothly varying volume with non-planar depth.", "geometryDescriptor": {"topologyIntent": "continuous-sculpt with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-socket", "localStart": [0, 0.66, 0], "localEnd": [0, 0.998, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.58, "height": 0.52, "depth": 0.48, "units": "relative", "confidence": 0.76}, "transform": {"position": [0, 0.66, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "pelvis", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "pelvis-socket", "localPosition": [0, 0.998, 0], "purpose": "attachment"}], "collider": {"type": "sphere", "offset": [0, 0.156, 0], "scale": [0.43499999999999994, 0.39, 0.36], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pelvis", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}}, "material": "skin-indigo", "materialLayers": ["skin-indigo"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["root->pelvis"], "seams": ["root-pelvis-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(52, 57, 101, 1)", "secondaryAlbedo": "rgba(92, 86, 140, 1)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(52, 57, 101, 1)"}, {"position": 1, "color": "rgba(92, 86, 140, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "hero"};
  node_pelvis_1.userData.actionProfile = {"animationRole": "pelvis", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "pelvis-socket", "localPosition": [0, 0.998, 0], "purpose": "attachment"}], "collider": {"type": "sphere", "offset": [0, 0.156, 0], "scale": [0.43499999999999994, 0.39, 0.36], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pelvis", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}};
  (nodes["root"] ?? root).add(node_pelvis_1);
  nodes["pelvis"] = node_pelvis_1;
  const mesh_pelvis_1Geometry = endpoint_pelvis_1
    ? new THREE.CylinderGeometry(endpoint_pelvis_1.endRadius, endpoint_pelvis_1.baseRadius, endpoint_pelvis_1.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_pelvis_1 = new THREE.Mesh(
    mesh_pelvis_1Geometry,
    materialMap["skin-indigo"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pelvis_1.name = "Pelvis core";
  if (endpoint_pelvis_1) {
    mesh_pelvis_1.position.copy(endpoint_pelvis_1.midpoint);
    mesh_pelvis_1.quaternion.copy(endpoint_pelvis_1.quaternion);
  }
  mesh_pelvis_1.castShadow = options.castShadow ?? true;
  mesh_pelvis_1.receiveShadow = options.receiveShadow ?? true;
  mesh_pelvis_1.userData.sculptComponent = {"id": "pelvis", "name": "Pelvis core", "level": "macro", "role": "pelvis", "importance": 1, "confidence": 0.76, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Pelvis core is a smoothly varying volume with non-planar depth.", "geometryDescriptor": {"topologyIntent": "continuous-sculpt with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-socket", "localStart": [0, 0.66, 0], "localEnd": [0, 0.998, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.58, "height": 0.52, "depth": 0.48, "units": "relative", "confidence": 0.76}, "transform": {"position": [0, 0.66, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "pelvis", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "pelvis-socket", "localPosition": [0, 0.998, 0], "purpose": "attachment"}], "collider": {"type": "sphere", "offset": [0, 0.156, 0], "scale": [0.43499999999999994, 0.39, 0.36], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "pelvis", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}}, "material": "skin-indigo", "materialLayers": ["skin-indigo"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["root->pelvis"], "seams": ["root-pelvis-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(52, 57, 101, 1)", "secondaryAlbedo": "rgba(92, 86, 140, 1)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(52, 57, 101, 1)"}, {"position": 1, "color": "rgba(92, 86, 140, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "hero"};
  node_pelvis_1.add(mesh_pelvis_1);
  meshes["pelvis"] = mesh_pelvis_1;
  colliders["pelvis"] = {"type": "sphere", "offset": [0, 0.156, 0], "scale": [0.43499999999999994, 0.39, 0.36], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["pelvis"] ??= [];
  destructionGroups["pelvis"].push(node_pelvis_1);
  const socket_pelvis_pelvis_socket_0 = new THREE.Object3D();
  socket_pelvis_pelvis_socket_0.name = "pelvis-socket";
  socket_pelvis_pelvis_socket_0.position.set(0.0, 0.998, 0.0);
  socket_pelvis_pelvis_socket_0.rotation.set(0, 0, 0);
  socket_pelvis_pelvis_socket_0.userData.socket = {"id": "pelvis-socket", "localPosition": [0, 0.998, 0], "purpose": "attachment"};
  node_pelvis_1.add(socket_pelvis_pelvis_socket_0);
  sockets["pelvis:pelvis-socket"] = socket_pelvis_pelvis_socket_0;

  const attachment_torso_2 = {"parentId": "pelvis", "parentSocket": "pelvis-socket", "localStart": [0, 1.14, 0], "localEnd": [0, 1.6469999999999998, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_torso_2 = makeAttachmentEndpoint(attachment_torso_2);
  const node_torso_2 = new THREE.Group();
  node_torso_2.name = "Volumetric torso__pivot";
  if (endpoint_torso_2) {
    node_torso_2.position.copy(endpoint_torso_2.start);
    node_torso_2.rotation.set(0, 0, 0);
    node_torso_2.scale.set(1, 1, 1);
  } else {
    node_torso_2.position.set(0.0, 1.14, 0.0);
    node_torso_2.rotation.set(0.0, 0.0, 0.0);
    node_torso_2.scale.set(1.0, 1.0, 1.0);
  }
  node_torso_2.userData.sculptComponent = {"id": "torso", "name": "Volumetric torso", "level": "macro", "role": "spine", "importance": 1, "confidence": 0.76, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Volumetric torso is a smoothly varying volume with non-planar depth.", "geometryDescriptor": {"topologyIntent": "continuous-sculpt with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "camera projection front plus palette-continuation rear", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "pelvis", "attachment": {"parentId": "pelvis", "parentSocket": "pelvis-socket", "localStart": [0, 1.14, 0], "localEnd": [0, 1.6469999999999998, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.72, "height": 0.78, "depth": 0.5, "units": "relative", "confidence": 0.76}, "transform": {"position": [0, 1.14, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "spine", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "torso-socket", "localPosition": [0, 1.6469999999999998, 0], "purpose": "cast-origin"}], "collider": {"type": "sphere", "offset": [0, 0.23399999999999999, 0], "scale": [0.54, 0.585, 0.375], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "torso", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "projection-front"}}, "material": "projection-front", "materialLayers": ["projection-front"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["pelvis->torso"], "seams": ["pelvis-torso-overlap"], "localFeatures": [{"id": "gold-chain-drape", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(69, 75, 123, 1)", "secondaryAlbedo": "rgba(216, 203, 185, 1)", "materialClass": "fabric", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(69, 75, 123, 1)"}, {"position": 1, "color": "rgba(216, 203, 185, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["gold-chain-drape"], "fidelityTier": "hero"};
  node_torso_2.userData.actionProfile = {"animationRole": "spine", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "torso-socket", "localPosition": [0, 1.6469999999999998, 0], "purpose": "cast-origin"}], "collider": {"type": "sphere", "offset": [0, 0.23399999999999999, 0], "scale": [0.54, 0.585, 0.375], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "torso", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "projection-front"}};
  (nodes["pelvis"] ?? root).add(node_torso_2);
  nodes["torso"] = node_torso_2;
  const mesh_torso_2Geometry = endpoint_torso_2
    ? new THREE.CylinderGeometry(endpoint_torso_2.endRadius, endpoint_torso_2.baseRadius, endpoint_torso_2.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_torso_2 = new THREE.Mesh(
    mesh_torso_2Geometry,
    materialMap["projection-front"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_torso_2.name = "Volumetric torso";
  if (endpoint_torso_2) {
    mesh_torso_2.position.copy(endpoint_torso_2.midpoint);
    mesh_torso_2.quaternion.copy(endpoint_torso_2.quaternion);
  }
  mesh_torso_2.castShadow = options.castShadow ?? true;
  mesh_torso_2.receiveShadow = options.receiveShadow ?? true;
  mesh_torso_2.userData.sculptComponent = {"id": "torso", "name": "Volumetric torso", "level": "macro", "role": "spine", "importance": 1, "confidence": 0.76, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Volumetric torso is a smoothly varying volume with non-planar depth.", "geometryDescriptor": {"topologyIntent": "continuous-sculpt with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "camera projection front plus palette-continuation rear", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "pelvis", "attachment": {"parentId": "pelvis", "parentSocket": "pelvis-socket", "localStart": [0, 1.14, 0], "localEnd": [0, 1.6469999999999998, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.72, "height": 0.78, "depth": 0.5, "units": "relative", "confidence": 0.76}, "transform": {"position": [0, 1.14, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "spine", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "torso-socket", "localPosition": [0, 1.6469999999999998, 0], "purpose": "cast-origin"}], "collider": {"type": "sphere", "offset": [0, 0.23399999999999999, 0], "scale": [0.54, 0.585, 0.375], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "torso", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "projection-front"}}, "material": "projection-front", "materialLayers": ["projection-front"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["pelvis->torso"], "seams": ["pelvis-torso-overlap"], "localFeatures": [{"id": "gold-chain-drape", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(69, 75, 123, 1)", "secondaryAlbedo": "rgba(216, 203, 185, 1)", "materialClass": "fabric", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(69, 75, 123, 1)"}, {"position": 1, "color": "rgba(216, 203, 185, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["gold-chain-drape"], "fidelityTier": "hero"};
  node_torso_2.add(mesh_torso_2);
  meshes["torso"] = mesh_torso_2;
  colliders["torso"] = {"type": "sphere", "offset": [0, 0.23399999999999999, 0], "scale": [0.54, 0.585, 0.375], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["torso"] ??= [];
  destructionGroups["torso"].push(node_torso_2);
  const socket_torso_torso_socket_0 = new THREE.Object3D();
  socket_torso_torso_socket_0.name = "torso-socket";
  socket_torso_torso_socket_0.position.set(0.0, 1.6469999999999998, 0.0);
  socket_torso_torso_socket_0.rotation.set(0, 0, 0);
  socket_torso_torso_socket_0.userData.socket = {"id": "torso-socket", "localPosition": [0, 1.6469999999999998, 0], "purpose": "cast-origin"};
  node_torso_2.add(socket_torso_torso_socket_0);
  sockets["torso:torso-socket"] = socket_torso_torso_socket_0;

  const attachment_head_3 = {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0, 1.98, 0.02], "localEnd": [0, 2.5780000000000003, 0.02], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_head_3 = makeAttachmentEndpoint(attachment_head_3);
  const node_head_3 = new THREE.Group();
  node_head_3.name = "Projected volumetric head__pivot";
  if (endpoint_head_3) {
    node_head_3.position.copy(endpoint_head_3.start);
    node_head_3.rotation.set(0, 0, 0);
    node_head_3.scale.set(1, 1, 1);
  } else {
    node_head_3.position.set(0.0, 1.98, 0.02);
    node_head_3.rotation.set(0.0, 0.0, 0.0);
    node_head_3.scale.set(1.0, 1.0, 1.0);
  }
  node_head_3.userData.sculptComponent = {"id": "head", "name": "Projected volumetric head", "level": "macro", "role": "head", "importance": 1, "confidence": 0.76, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Projected volumetric head is a smoothly varying volume with non-planar depth.", "geometryDescriptor": {"topologyIntent": "continuous-sculpt with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "camera projection front plus palette-continuation rear", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "torso", "attachment": {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0, 1.98, 0.02], "localEnd": [0, 2.5780000000000003, 0.02], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.14, "height": 0.92, "depth": 0.82, "units": "relative", "confidence": 0.76}, "transform": {"position": [0, 1.98, 0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "head", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "head-socket", "localPosition": [0, 2.5780000000000003, 0.02], "purpose": "head-target"}], "collider": {"type": "sphere", "offset": [0, 0.276, 0], "scale": [0.855, 0.6900000000000001, 0.615], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "projection-front"}}, "material": "projection-front", "materialLayers": ["projection-front"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["torso->head"], "seams": ["torso-head-overlap"], "localFeatures": [{"id": "forehead-crest", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}, {"id": "skin-scale-relief", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}, {"id": "eye-catchlights", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(69, 75, 123, 1)", "secondaryAlbedo": "rgba(216, 203, 185, 1)", "materialClass": "fabric", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(69, 75, 123, 1)"}, {"position": 1, "color": "rgba(216, 203, 185, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["forehead-crest", "skin-scale-relief", "eye-catchlights"], "fidelityTier": "hero"};
  node_head_3.userData.actionProfile = {"animationRole": "head", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "head-socket", "localPosition": [0, 2.5780000000000003, 0.02], "purpose": "head-target"}], "collider": {"type": "sphere", "offset": [0, 0.276, 0], "scale": [0.855, 0.6900000000000001, 0.615], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "projection-front"}};
  (nodes["torso"] ?? root).add(node_head_3);
  nodes["head"] = node_head_3;
  const mesh_head_3Geometry = endpoint_head_3
    ? new THREE.CylinderGeometry(endpoint_head_3.endRadius, endpoint_head_3.baseRadius, endpoint_head_3.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_head_3 = new THREE.Mesh(
    mesh_head_3Geometry,
    materialMap["projection-front"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_head_3.name = "Projected volumetric head";
  if (endpoint_head_3) {
    mesh_head_3.position.copy(endpoint_head_3.midpoint);
    mesh_head_3.quaternion.copy(endpoint_head_3.quaternion);
  }
  mesh_head_3.castShadow = options.castShadow ?? true;
  mesh_head_3.receiveShadow = options.receiveShadow ?? true;
  mesh_head_3.userData.sculptComponent = {"id": "head", "name": "Projected volumetric head", "level": "macro", "role": "head", "importance": 1, "confidence": 0.76, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Projected volumetric head is a smoothly varying volume with non-planar depth.", "geometryDescriptor": {"topologyIntent": "continuous-sculpt with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "camera projection front plus palette-continuation rear", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "torso", "attachment": {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0, 1.98, 0.02], "localEnd": [0, 2.5780000000000003, 0.02], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.14, "height": 0.92, "depth": 0.82, "units": "relative", "confidence": 0.76}, "transform": {"position": [0, 1.98, 0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "head", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "head-socket", "localPosition": [0, 2.5780000000000003, 0.02], "purpose": "head-target"}], "collider": {"type": "sphere", "offset": [0, 0.276, 0], "scale": [0.855, 0.6900000000000001, 0.615], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "head", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "projection-front"}}, "material": "projection-front", "materialLayers": ["projection-front"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["torso->head"], "seams": ["torso-head-overlap"], "localFeatures": [{"id": "forehead-crest", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}, {"id": "skin-scale-relief", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}, {"id": "eye-catchlights", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(69, 75, 123, 1)", "secondaryAlbedo": "rgba(216, 203, 185, 1)", "materialClass": "fabric", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(69, 75, 123, 1)"}, {"position": 1, "color": "rgba(216, 203, 185, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["forehead-crest", "skin-scale-relief", "eye-catchlights"], "fidelityTier": "hero"};
  node_head_3.add(mesh_head_3);
  meshes["head"] = mesh_head_3;
  colliders["head"] = {"type": "sphere", "offset": [0, 0.276, 0], "scale": [0.855, 0.6900000000000001, 0.615], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["head"] ??= [];
  destructionGroups["head"].push(node_head_3);
  const socket_head_head_socket_0 = new THREE.Object3D();
  socket_head_head_socket_0.name = "head-socket";
  socket_head_head_socket_0.position.set(0.0, 2.5780000000000003, 0.02);
  socket_head_head_socket_0.rotation.set(0, 0, 0);
  socket_head_head_socket_0.userData.socket = {"id": "head-socket", "localPosition": [0, 2.5780000000000003, 0.02], "purpose": "head-target"};
  node_head_3.add(socket_head_head_socket_0);
  sockets["head:head-socket"] = socket_head_head_socket_0;

  const attachment_cape_4 = {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0, 1.18, -0.28], "localEnd": [0, 2.025, -0.28], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_cape_4 = makeAttachmentEndpoint(attachment_cape_4);
  const node_cape_4 = new THREE.Group();
  node_cape_4.name = "Split articulated cape__pivot";
  if (endpoint_cape_4) {
    node_cape_4.position.copy(endpoint_cape_4.start);
    node_cape_4.rotation.set(0, 0, 0);
    node_cape_4.scale.set(1, 1, 1);
  } else {
    node_cape_4.position.set(0.0, 1.18, -0.28);
    node_cape_4.rotation.set(0.0, 0.0, 0.0);
    node_cape_4.scale.set(1.0, 1.0, 1.0);
  }
  node_cape_4.userData.sculptComponent = {"id": "cape", "name": "Split articulated cape", "level": "macro", "role": "cloth-shell", "importance": 1, "confidence": 0.76, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "Split articulated cape is a thin articulated shell over the body.", "geometryDescriptor": {"topologyIntent": "conforming-shell with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "torso", "attachment": {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0, 1.18, -0.28], "localEnd": [0, 2.025, -0.28], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.46, "height": 1.3, "depth": 0.12, "units": "relative", "confidence": 0.76}, "transform": {"position": [0, 1.18, -0.28], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "cloth-shell", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "cape-socket", "localPosition": [0, 2.025, -0.28], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.39, 0], "scale": [1.095, 0.9750000000000001, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cape", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "cape-cloth"}}, "material": "cape-cloth", "materialLayers": ["cape-cloth"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["torso->cape"], "seams": ["torso-cape-overlap"], "localFeatures": [{"id": "split-cape-panels", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}, {"id": "cape-border-engraving", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 35, 60, 1)", "secondaryAlbedo": "rgba(69, 75, 123, 1)", "materialClass": "fabric", "materialClassConfidence": 0.84, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(29, 35, 60, 1)"}, {"position": 1, "color": "rgba(69, 75, 123, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["split-cape-panels", "cape-border-engraving"], "fidelityTier": "hero"};
  node_cape_4.userData.actionProfile = {"animationRole": "cloth-shell", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "cape-socket", "localPosition": [0, 2.025, -0.28], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.39, 0], "scale": [1.095, 0.9750000000000001, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cape", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "cape-cloth"}};
  (nodes["torso"] ?? root).add(node_cape_4);
  nodes["cape"] = node_cape_4;
  const mesh_cape_4Geometry = endpoint_cape_4
    ? new THREE.CylinderGeometry(endpoint_cape_4.endRadius, endpoint_cape_4.baseRadius, endpoint_cape_4.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  const mesh_cape_4 = new THREE.Mesh(
    mesh_cape_4Geometry,
    materialMap["cape-cloth"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cape_4.name = "Split articulated cape";
  if (endpoint_cape_4) {
    mesh_cape_4.position.copy(endpoint_cape_4.midpoint);
    mesh_cape_4.quaternion.copy(endpoint_cape_4.quaternion);
  }
  mesh_cape_4.castShadow = options.castShadow ?? true;
  mesh_cape_4.receiveShadow = options.receiveShadow ?? true;
  mesh_cape_4.userData.sculptComponent = {"id": "cape", "name": "Split articulated cape", "level": "macro", "role": "cloth-shell", "importance": 1, "confidence": 0.76, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "Split articulated cape is a thin articulated shell over the body.", "geometryDescriptor": {"topologyIntent": "conforming-shell with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "torso", "attachment": {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0, 1.18, -0.28], "localEnd": [0, 2.025, -0.28], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.46, "height": 1.3, "depth": 0.12, "units": "relative", "confidence": 0.76}, "transform": {"position": [0, 1.18, -0.28], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "cloth-shell", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "cape-socket", "localPosition": [0, 2.025, -0.28], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.39, 0], "scale": [1.095, 0.9750000000000001, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cape", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "cape-cloth"}}, "material": "cape-cloth", "materialLayers": ["cape-cloth"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["torso->cape"], "seams": ["torso-cape-overlap"], "localFeatures": [{"id": "split-cape-panels", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}, {"id": "cape-border-engraving", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(29, 35, 60, 1)", "secondaryAlbedo": "rgba(69, 75, 123, 1)", "materialClass": "fabric", "materialClassConfidence": 0.84, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(29, 35, 60, 1)"}, {"position": 1, "color": "rgba(69, 75, 123, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["split-cape-panels", "cape-border-engraving"], "fidelityTier": "hero"};
  node_cape_4.add(mesh_cape_4);
  meshes["cape"] = mesh_cape_4;
  colliders["cape"] = {"type": "capsule", "offset": [0, 0.39, 0], "scale": [1.095, 0.9750000000000001, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["cape"] ??= [];
  destructionGroups["cape"].push(node_cape_4);
  const socket_cape_cape_socket_0 = new THREE.Object3D();
  socket_cape_cape_socket_0.name = "cape-socket";
  socket_cape_cape_socket_0.position.set(0.0, 2.025, -0.28);
  socket_cape_cape_socket_0.rotation.set(0, 0, 0);
  socket_cape_cape_socket_0.userData.socket = {"id": "cape-socket", "localPosition": [0, 2.025, -0.28], "purpose": "attachment"};
  node_cape_4.add(socket_cape_cape_socket_0);
  sockets["cape:cape-socket"] = socket_cape_cape_socket_0;

  const attachment_tail_5 = {"parentId": "pelvis", "parentSocket": "pelvis-socket", "localStart": [0.42, 0.7, -0.14], "localEnd": [0.42, 1.025, -0.14], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_tail_5 = makeAttachmentEndpoint(attachment_tail_5);
  const node_tail_5 = new THREE.Group();
  node_tail_5.name = "Curled tail chain__pivot";
  if (endpoint_tail_5) {
    node_tail_5.position.copy(endpoint_tail_5.start);
    node_tail_5.rotation.set(0, 0, 0);
    node_tail_5.scale.set(1, 1, 1);
  } else {
    node_tail_5.position.set(0.42, 0.7, -0.14);
    node_tail_5.rotation.set(0.0, 0.0, 0.0);
    node_tail_5.scale.set(1.0, 1.0, 1.0);
  }
  node_tail_5.userData.sculptComponent = {"id": "tail", "name": "Curled tail chain", "level": "macro", "role": "tail", "importance": 1, "confidence": 0.76, "primitive": "curve-sweep", "topologyClass": "fiber-strand", "topologyRationale": "Curled tail chain follows a rooted curved path.", "geometryDescriptor": {"topologyIntent": "fiber-strand with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "pelvis", "attachment": {"parentId": "pelvis", "parentSocket": "pelvis-socket", "localStart": [0.42, 0.7, -0.14], "localEnd": [0.42, 1.025, -0.14], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.1, "height": 0.5, "depth": 0.3, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.42, 0.7, -0.14], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "tail", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "tail-socket", "localPosition": [0.42, 1.025, -0.14], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.15, 0], "scale": [0.8250000000000001, 0.375, 0.22499999999999998], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tail", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}}, "material": "skin-indigo", "materialLayers": ["skin-indigo"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["pelvis->tail"], "seams": ["pelvis-tail-overlap"], "localFeatures": [{"id": "tail-curve", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}, {"id": "tail-gold-tip", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(52, 57, 101, 1)", "secondaryAlbedo": "rgba(92, 86, 140, 1)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(52, 57, 101, 1)"}, {"position": 1, "color": "rgba(92, 86, 140, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["tail-curve", "tail-gold-tip"], "fidelityTier": "hero"};
  node_tail_5.userData.actionProfile = {"animationRole": "tail", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "tail-socket", "localPosition": [0.42, 1.025, -0.14], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.15, 0], "scale": [0.8250000000000001, 0.375, 0.22499999999999998], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tail", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}};
  (nodes["pelvis"] ?? root).add(node_tail_5);
  nodes["tail"] = node_tail_5;
  const mesh_tail_5Geometry = endpoint_tail_5
    ? new THREE.CylinderGeometry(endpoint_tail_5.endRadius, endpoint_tail_5.baseRadius, endpoint_tail_5.length, 32, 12)
    : buildCurveSweepGeometry({"spine": [[-0.5, -0.4, 0.0], [-0.1, 0.1, 0.0], [0.3, 0.2, 0.0], [0.6, -0.1, 0.0]], "crossSection": {"points": [[-0.04, -0.02], [0.04, -0.02], [0.04, 0.02], [-0.04, 0.02]]}, "closed": false});
  const mesh_tail_5 = new THREE.Mesh(
    mesh_tail_5Geometry,
    materialMap["skin-indigo"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tail_5.name = "Curled tail chain";
  if (endpoint_tail_5) {
    mesh_tail_5.position.copy(endpoint_tail_5.midpoint);
    mesh_tail_5.quaternion.copy(endpoint_tail_5.quaternion);
  }
  mesh_tail_5.castShadow = options.castShadow ?? true;
  mesh_tail_5.receiveShadow = options.receiveShadow ?? true;
  mesh_tail_5.userData.sculptComponent = {"id": "tail", "name": "Curled tail chain", "level": "macro", "role": "tail", "importance": 1, "confidence": 0.76, "primitive": "curve-sweep", "topologyClass": "fiber-strand", "topologyRationale": "Curled tail chain follows a rooted curved path.", "geometryDescriptor": {"topologyIntent": "fiber-strand with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "pelvis", "attachment": {"parentId": "pelvis", "parentSocket": "pelvis-socket", "localStart": [0.42, 0.7, -0.14], "localEnd": [0.42, 1.025, -0.14], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.1, "height": 0.5, "depth": 0.3, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.42, 0.7, -0.14], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "tail", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "tail-socket", "localPosition": [0.42, 1.025, -0.14], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.15, 0], "scale": [0.8250000000000001, 0.375, 0.22499999999999998], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tail", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}}, "material": "skin-indigo", "materialLayers": ["skin-indigo"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["pelvis->tail"], "seams": ["pelvis-tail-overlap"], "localFeatures": [{"id": "tail-curve", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}, {"id": "tail-gold-tip", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(52, 57, 101, 1)", "secondaryAlbedo": "rgba(92, 86, 140, 1)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(52, 57, 101, 1)"}, {"position": 1, "color": "rgba(92, 86, 140, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["tail-curve", "tail-gold-tip"], "fidelityTier": "hero"};
  node_tail_5.add(mesh_tail_5);
  meshes["tail"] = mesh_tail_5;
  colliders["tail"] = {"type": "capsule", "offset": [0, 0.15, 0], "scale": [0.8250000000000001, 0.375, 0.22499999999999998], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["tail"] ??= [];
  destructionGroups["tail"].push(node_tail_5);
  const socket_tail_tail_socket_0 = new THREE.Object3D();
  socket_tail_tail_socket_0.name = "tail-socket";
  socket_tail_tail_socket_0.position.set(0.42, 1.025, -0.14);
  socket_tail_tail_socket_0.rotation.set(0, 0, 0);
  socket_tail_tail_socket_0.userData.socket = {"id": "tail-socket", "localPosition": [0.42, 1.025, -0.14], "purpose": "attachment"};
  node_tail_5.add(socket_tail_tail_socket_0);
  sockets["tail:tail-socket"] = socket_tail_tail_socket_0;

  const attachment_neck_6 = {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0, 1.62, 0], "localEnd": [0, 1.828, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_neck_6 = makeAttachmentEndpoint(attachment_neck_6);
  const node_neck_6 = new THREE.Group();
  node_neck_6.name = "Neck joint__pivot";
  if (endpoint_neck_6) {
    node_neck_6.position.copy(endpoint_neck_6.start);
    node_neck_6.rotation.set(0, 0, 0);
    node_neck_6.scale.set(1, 1, 1);
  } else {
    node_neck_6.position.set(0.0, 1.62, 0.0);
    node_neck_6.rotation.set(0.0, 0.0, 0.0);
    node_neck_6.scale.set(1.0, 1.0, 1.0);
  }
  node_neck_6.userData.sculptComponent = {"id": "neck", "name": "Neck joint", "level": "meso", "role": "connector", "importance": 0.82, "confidence": 0.76, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Neck joint is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "torso", "attachment": {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0, 1.62, 0], "localEnd": [0, 1.828, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.28, "height": 0.32, "depth": 0.28, "units": "relative", "confidence": 0.76}, "transform": {"position": [0, 1.62, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "neck-socket", "localPosition": [0, 1.828, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.096, 0], "scale": [0.21000000000000002, 0.24, 0.21000000000000002], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "neck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}}, "material": "skin-indigo", "materialLayers": ["skin-indigo"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["torso->neck"], "seams": ["torso-neck-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(52, 57, 101, 1)", "secondaryAlbedo": "rgba(92, 86, 140, 1)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(52, 57, 101, 1)"}, {"position": 1, "color": "rgba(92, 86, 140, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_neck_6.userData.actionProfile = {"animationRole": "connector", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "neck-socket", "localPosition": [0, 1.828, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.096, 0], "scale": [0.21000000000000002, 0.24, 0.21000000000000002], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "neck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}};
  (nodes["torso"] ?? root).add(node_neck_6);
  nodes["neck"] = node_neck_6;
  const mesh_neck_6Geometry = endpoint_neck_6
    ? new THREE.CylinderGeometry(endpoint_neck_6.endRadius, endpoint_neck_6.baseRadius, endpoint_neck_6.length, 32, 12)
    : new THREE.CapsuleGeometry(0.35, 0.7, 16, 32);
  const mesh_neck_6 = new THREE.Mesh(
    mesh_neck_6Geometry,
    materialMap["skin-indigo"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_neck_6.name = "Neck joint";
  if (endpoint_neck_6) {
    mesh_neck_6.position.copy(endpoint_neck_6.midpoint);
    mesh_neck_6.quaternion.copy(endpoint_neck_6.quaternion);
  }
  mesh_neck_6.castShadow = options.castShadow ?? true;
  mesh_neck_6.receiveShadow = options.receiveShadow ?? true;
  mesh_neck_6.userData.sculptComponent = {"id": "neck", "name": "Neck joint", "level": "meso", "role": "connector", "importance": 0.82, "confidence": 0.76, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Neck joint is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "torso", "attachment": {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0, 1.62, 0], "localEnd": [0, 1.828, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.28, "height": 0.32, "depth": 0.28, "units": "relative", "confidence": 0.76}, "transform": {"position": [0, 1.62, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "neck-socket", "localPosition": [0, 1.828, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.096, 0], "scale": [0.21000000000000002, 0.24, 0.21000000000000002], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "neck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}}, "material": "skin-indigo", "materialLayers": ["skin-indigo"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["torso->neck"], "seams": ["torso-neck-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(52, 57, 101, 1)", "secondaryAlbedo": "rgba(92, 86, 140, 1)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(52, 57, 101, 1)"}, {"position": 1, "color": "rgba(92, 86, 140, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_neck_6.add(mesh_neck_6);
  meshes["neck"] = mesh_neck_6;
  colliders["neck"] = {"type": "capsule", "offset": [0, 0.096, 0], "scale": [0.21000000000000002, 0.24, 0.21000000000000002], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["neck"] ??= [];
  destructionGroups["neck"].push(node_neck_6);
  const socket_neck_neck_socket_0 = new THREE.Object3D();
  socket_neck_neck_socket_0.name = "neck-socket";
  socket_neck_neck_socket_0.position.set(0.0, 1.828, 0.0);
  socket_neck_neck_socket_0.rotation.set(0, 0, 0);
  socket_neck_neck_socket_0.userData.socket = {"id": "neck-socket", "localPosition": [0, 1.828, 0], "purpose": "attachment"};
  node_neck_6.add(socket_neck_neck_socket_0);
  sockets["neck:neck-socket"] = socket_neck_neck_socket_0;

  const attachment_upper_arm_l_7 = {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [-0.5, 1.34, 0], "localEnd": [-0.5, 1.6520000000000001, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_upper_arm_l_7 = makeAttachmentEndpoint(attachment_upper_arm_l_7);
  const node_upper_arm_l_7 = new THREE.Group();
  node_upper_arm_l_7.name = "Left upper arm__pivot";
  if (endpoint_upper_arm_l_7) {
    node_upper_arm_l_7.position.copy(endpoint_upper_arm_l_7.start);
    node_upper_arm_l_7.rotation.set(0, 0, 0);
    node_upper_arm_l_7.scale.set(1, 1, 1);
  } else {
    node_upper_arm_l_7.position.set(-0.5, 1.34, 0.0);
    node_upper_arm_l_7.rotation.set(0.0, 0.0, 0.0);
    node_upper_arm_l_7.scale.set(1.0, 1.0, 1.0);
  }
  node_upper_arm_l_7.userData.sculptComponent = {"id": "upper-arm-l", "name": "Left upper arm", "level": "meso", "role": "arm", "importance": 0.82, "confidence": 0.76, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Left upper arm is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "torso", "attachment": {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [-0.5, 1.34, 0], "localEnd": [-0.5, 1.6520000000000001, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.22, "height": 0.48, "depth": 0.22, "units": "relative", "confidence": 0.76}, "transform": {"position": [-0.5, 1.34, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "arm", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "upper-arm-l-socket", "localPosition": [-0.5, 1.6520000000000001, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.144, 0], "scale": [0.165, 0.36, 0.165], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}}, "material": "skin-indigo", "materialLayers": ["skin-indigo"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["torso->upper-arm-l"], "seams": ["torso-upper-arm-l-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(52, 57, 101, 1)", "secondaryAlbedo": "rgba(92, 86, 140, 1)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(52, 57, 101, 1)"}, {"position": 1, "color": "rgba(92, 86, 140, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_upper_arm_l_7.userData.actionProfile = {"animationRole": "arm", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "upper-arm-l-socket", "localPosition": [-0.5, 1.6520000000000001, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.144, 0], "scale": [0.165, 0.36, 0.165], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}};
  (nodes["torso"] ?? root).add(node_upper_arm_l_7);
  nodes["upper-arm-l"] = node_upper_arm_l_7;
  const mesh_upper_arm_l_7Geometry = endpoint_upper_arm_l_7
    ? new THREE.CylinderGeometry(endpoint_upper_arm_l_7.endRadius, endpoint_upper_arm_l_7.baseRadius, endpoint_upper_arm_l_7.length, 32, 12)
    : new THREE.CapsuleGeometry(0.35, 0.7, 16, 32);
  const mesh_upper_arm_l_7 = new THREE.Mesh(
    mesh_upper_arm_l_7Geometry,
    materialMap["skin-indigo"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_arm_l_7.name = "Left upper arm";
  if (endpoint_upper_arm_l_7) {
    mesh_upper_arm_l_7.position.copy(endpoint_upper_arm_l_7.midpoint);
    mesh_upper_arm_l_7.quaternion.copy(endpoint_upper_arm_l_7.quaternion);
  }
  mesh_upper_arm_l_7.castShadow = options.castShadow ?? true;
  mesh_upper_arm_l_7.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_arm_l_7.userData.sculptComponent = {"id": "upper-arm-l", "name": "Left upper arm", "level": "meso", "role": "arm", "importance": 0.82, "confidence": 0.76, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Left upper arm is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "torso", "attachment": {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [-0.5, 1.34, 0], "localEnd": [-0.5, 1.6520000000000001, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.22, "height": 0.48, "depth": 0.22, "units": "relative", "confidence": 0.76}, "transform": {"position": [-0.5, 1.34, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "arm", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "upper-arm-l-socket", "localPosition": [-0.5, 1.6520000000000001, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.144, 0], "scale": [0.165, 0.36, 0.165], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}}, "material": "skin-indigo", "materialLayers": ["skin-indigo"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["torso->upper-arm-l"], "seams": ["torso-upper-arm-l-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(52, 57, 101, 1)", "secondaryAlbedo": "rgba(92, 86, 140, 1)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(52, 57, 101, 1)"}, {"position": 1, "color": "rgba(92, 86, 140, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_upper_arm_l_7.add(mesh_upper_arm_l_7);
  meshes["upper-arm-l"] = mesh_upper_arm_l_7;
  colliders["upper-arm-l"] = {"type": "capsule", "offset": [0, 0.144, 0], "scale": [0.165, 0.36, 0.165], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["upper-arm-l"] ??= [];
  destructionGroups["upper-arm-l"].push(node_upper_arm_l_7);
  const socket_upper_arm_l_upper_arm_l_socket_0 = new THREE.Object3D();
  socket_upper_arm_l_upper_arm_l_socket_0.name = "upper-arm-l-socket";
  socket_upper_arm_l_upper_arm_l_socket_0.position.set(-0.5, 1.6520000000000001, 0.0);
  socket_upper_arm_l_upper_arm_l_socket_0.rotation.set(0, 0, 0);
  socket_upper_arm_l_upper_arm_l_socket_0.userData.socket = {"id": "upper-arm-l-socket", "localPosition": [-0.5, 1.6520000000000001, 0], "purpose": "attachment"};
  node_upper_arm_l_7.add(socket_upper_arm_l_upper_arm_l_socket_0);
  sockets["upper-arm-l:upper-arm-l-socket"] = socket_upper_arm_l_upper_arm_l_socket_0;

  const attachment_upper_arm_r_8 = {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0.5, 1.34, 0], "localEnd": [0.5, 1.6520000000000001, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_upper_arm_r_8 = makeAttachmentEndpoint(attachment_upper_arm_r_8);
  const node_upper_arm_r_8 = new THREE.Group();
  node_upper_arm_r_8.name = "Right upper arm__pivot";
  if (endpoint_upper_arm_r_8) {
    node_upper_arm_r_8.position.copy(endpoint_upper_arm_r_8.start);
    node_upper_arm_r_8.rotation.set(0, 0, 0);
    node_upper_arm_r_8.scale.set(1, 1, 1);
  } else {
    node_upper_arm_r_8.position.set(0.5, 1.34, 0.0);
    node_upper_arm_r_8.rotation.set(0.0, 0.0, 0.0);
    node_upper_arm_r_8.scale.set(1.0, 1.0, 1.0);
  }
  node_upper_arm_r_8.userData.sculptComponent = {"id": "upper-arm-r", "name": "Right upper arm", "level": "meso", "role": "arm", "importance": 0.82, "confidence": 0.76, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Right upper arm is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "torso", "attachment": {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0.5, 1.34, 0], "localEnd": [0.5, 1.6520000000000001, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.22, "height": 0.48, "depth": 0.22, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.5, 1.34, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "arm", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "upper-arm-r-socket", "localPosition": [0.5, 1.6520000000000001, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.144, 0], "scale": [0.165, 0.36, 0.165], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}}, "material": "skin-indigo", "materialLayers": ["skin-indigo"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["torso->upper-arm-r"], "seams": ["torso-upper-arm-r-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(52, 57, 101, 1)", "secondaryAlbedo": "rgba(92, 86, 140, 1)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(52, 57, 101, 1)"}, {"position": 1, "color": "rgba(92, 86, 140, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_upper_arm_r_8.userData.actionProfile = {"animationRole": "arm", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "upper-arm-r-socket", "localPosition": [0.5, 1.6520000000000001, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.144, 0], "scale": [0.165, 0.36, 0.165], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}};
  (nodes["torso"] ?? root).add(node_upper_arm_r_8);
  nodes["upper-arm-r"] = node_upper_arm_r_8;
  const mesh_upper_arm_r_8Geometry = endpoint_upper_arm_r_8
    ? new THREE.CylinderGeometry(endpoint_upper_arm_r_8.endRadius, endpoint_upper_arm_r_8.baseRadius, endpoint_upper_arm_r_8.length, 32, 12)
    : new THREE.CapsuleGeometry(0.35, 0.7, 16, 32);
  const mesh_upper_arm_r_8 = new THREE.Mesh(
    mesh_upper_arm_r_8Geometry,
    materialMap["skin-indigo"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_arm_r_8.name = "Right upper arm";
  if (endpoint_upper_arm_r_8) {
    mesh_upper_arm_r_8.position.copy(endpoint_upper_arm_r_8.midpoint);
    mesh_upper_arm_r_8.quaternion.copy(endpoint_upper_arm_r_8.quaternion);
  }
  mesh_upper_arm_r_8.castShadow = options.castShadow ?? true;
  mesh_upper_arm_r_8.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_arm_r_8.userData.sculptComponent = {"id": "upper-arm-r", "name": "Right upper arm", "level": "meso", "role": "arm", "importance": 0.82, "confidence": 0.76, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Right upper arm is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "torso", "attachment": {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0.5, 1.34, 0], "localEnd": [0.5, 1.6520000000000001, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.22, "height": 0.48, "depth": 0.22, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.5, 1.34, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "arm", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "upper-arm-r-socket", "localPosition": [0.5, 1.6520000000000001, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.144, 0], "scale": [0.165, 0.36, 0.165], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-arm-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}}, "material": "skin-indigo", "materialLayers": ["skin-indigo"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["torso->upper-arm-r"], "seams": ["torso-upper-arm-r-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(52, 57, 101, 1)", "secondaryAlbedo": "rgba(92, 86, 140, 1)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(52, 57, 101, 1)"}, {"position": 1, "color": "rgba(92, 86, 140, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_upper_arm_r_8.add(mesh_upper_arm_r_8);
  meshes["upper-arm-r"] = mesh_upper_arm_r_8;
  colliders["upper-arm-r"] = {"type": "capsule", "offset": [0, 0.144, 0], "scale": [0.165, 0.36, 0.165], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["upper-arm-r"] ??= [];
  destructionGroups["upper-arm-r"].push(node_upper_arm_r_8);
  const socket_upper_arm_r_upper_arm_r_socket_0 = new THREE.Object3D();
  socket_upper_arm_r_upper_arm_r_socket_0.name = "upper-arm-r-socket";
  socket_upper_arm_r_upper_arm_r_socket_0.position.set(0.5, 1.6520000000000001, 0.0);
  socket_upper_arm_r_upper_arm_r_socket_0.rotation.set(0, 0, 0);
  socket_upper_arm_r_upper_arm_r_socket_0.userData.socket = {"id": "upper-arm-r-socket", "localPosition": [0.5, 1.6520000000000001, 0], "purpose": "attachment"};
  node_upper_arm_r_8.add(socket_upper_arm_r_upper_arm_r_socket_0);
  sockets["upper-arm-r:upper-arm-r-socket"] = socket_upper_arm_r_upper_arm_r_socket_0;

  const attachment_forearm_l_9 = {"parentId": "upper-arm-l", "parentSocket": "upper-arm-l-socket", "localStart": [-0.62, 1, 0.04], "localEnd": [-0.62, 1.2730000000000001, 0.04], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_forearm_l_9 = makeAttachmentEndpoint(attachment_forearm_l_9);
  const node_forearm_l_9 = new THREE.Group();
  node_forearm_l_9.name = "Left forearm__pivot";
  if (endpoint_forearm_l_9) {
    node_forearm_l_9.position.copy(endpoint_forearm_l_9.start);
    node_forearm_l_9.rotation.set(0, 0, 0);
    node_forearm_l_9.scale.set(1, 1, 1);
  } else {
    node_forearm_l_9.position.set(-0.62, 1.0, 0.04);
    node_forearm_l_9.rotation.set(0.0, 0.0, 0.0);
    node_forearm_l_9.scale.set(1.0, 1.0, 1.0);
  }
  node_forearm_l_9.userData.sculptComponent = {"id": "forearm-l", "name": "Left forearm", "level": "meso", "role": "arm", "importance": 0.82, "confidence": 0.76, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Left forearm is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "upper-arm-l", "attachment": {"parentId": "upper-arm-l", "parentSocket": "upper-arm-l-socket", "localStart": [-0.62, 1, 0.04], "localEnd": [-0.62, 1.2730000000000001, 0.04], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.2, "height": 0.42, "depth": 0.2, "units": "relative", "confidence": 0.76}, "transform": {"position": [-0.62, 1, 0.04], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "arm", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "forearm-l-socket", "localPosition": [-0.62, 1.2730000000000001, 0.04], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.126, 0], "scale": [0.15000000000000002, 0.315, 0.15000000000000002], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "armor-ivory"}}, "material": "armor-ivory", "materialLayers": ["armor-ivory"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["upper-arm-l->forearm-l"], "seams": ["upper-arm-l-forearm-l-overlap"], "localFeatures": [{"id": "bracer-diamond-grid", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 203, 185, 1)", "secondaryAlbedo": "rgba(185, 155, 97, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.84, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(216, 203, 185, 1)"}, {"position": 1, "color": "rgba(185, 155, 97, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["bracer-diamond-grid"], "fidelityTier": "structural"};
  node_forearm_l_9.userData.actionProfile = {"animationRole": "arm", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "forearm-l-socket", "localPosition": [-0.62, 1.2730000000000001, 0.04], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.126, 0], "scale": [0.15000000000000002, 0.315, 0.15000000000000002], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "armor-ivory"}};
  (nodes["upper-arm-l"] ?? root).add(node_forearm_l_9);
  nodes["forearm-l"] = node_forearm_l_9;
  const mesh_forearm_l_9Geometry = endpoint_forearm_l_9
    ? new THREE.CylinderGeometry(endpoint_forearm_l_9.endRadius, endpoint_forearm_l_9.baseRadius, endpoint_forearm_l_9.length, 32, 12)
    : new THREE.CapsuleGeometry(0.35, 0.7, 16, 32);
  const mesh_forearm_l_9 = new THREE.Mesh(
    mesh_forearm_l_9Geometry,
    materialMap["armor-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_forearm_l_9.name = "Left forearm";
  if (endpoint_forearm_l_9) {
    mesh_forearm_l_9.position.copy(endpoint_forearm_l_9.midpoint);
    mesh_forearm_l_9.quaternion.copy(endpoint_forearm_l_9.quaternion);
  }
  mesh_forearm_l_9.castShadow = options.castShadow ?? true;
  mesh_forearm_l_9.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_l_9.userData.sculptComponent = {"id": "forearm-l", "name": "Left forearm", "level": "meso", "role": "arm", "importance": 0.82, "confidence": 0.76, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Left forearm is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "upper-arm-l", "attachment": {"parentId": "upper-arm-l", "parentSocket": "upper-arm-l-socket", "localStart": [-0.62, 1, 0.04], "localEnd": [-0.62, 1.2730000000000001, 0.04], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.2, "height": 0.42, "depth": 0.2, "units": "relative", "confidence": 0.76}, "transform": {"position": [-0.62, 1, 0.04], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "arm", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "forearm-l-socket", "localPosition": [-0.62, 1.2730000000000001, 0.04], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.126, 0], "scale": [0.15000000000000002, 0.315, 0.15000000000000002], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "armor-ivory"}}, "material": "armor-ivory", "materialLayers": ["armor-ivory"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["upper-arm-l->forearm-l"], "seams": ["upper-arm-l-forearm-l-overlap"], "localFeatures": [{"id": "bracer-diamond-grid", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 203, 185, 1)", "secondaryAlbedo": "rgba(185, 155, 97, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.84, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(216, 203, 185, 1)"}, {"position": 1, "color": "rgba(185, 155, 97, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["bracer-diamond-grid"], "fidelityTier": "structural"};
  node_forearm_l_9.add(mesh_forearm_l_9);
  meshes["forearm-l"] = mesh_forearm_l_9;
  colliders["forearm-l"] = {"type": "capsule", "offset": [0, 0.126, 0], "scale": [0.15000000000000002, 0.315, 0.15000000000000002], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["forearm-l"] ??= [];
  destructionGroups["forearm-l"].push(node_forearm_l_9);
  const socket_forearm_l_forearm_l_socket_0 = new THREE.Object3D();
  socket_forearm_l_forearm_l_socket_0.name = "forearm-l-socket";
  socket_forearm_l_forearm_l_socket_0.position.set(-0.62, 1.2730000000000001, 0.04);
  socket_forearm_l_forearm_l_socket_0.rotation.set(0, 0, 0);
  socket_forearm_l_forearm_l_socket_0.userData.socket = {"id": "forearm-l-socket", "localPosition": [-0.62, 1.2730000000000001, 0.04], "purpose": "attachment"};
  node_forearm_l_9.add(socket_forearm_l_forearm_l_socket_0);
  sockets["forearm-l:forearm-l-socket"] = socket_forearm_l_forearm_l_socket_0;

  const attachment_forearm_r_10 = {"parentId": "upper-arm-r", "parentSocket": "upper-arm-r-socket", "localStart": [0.62, 1, 0.04], "localEnd": [0.62, 1.2730000000000001, 0.04], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_forearm_r_10 = makeAttachmentEndpoint(attachment_forearm_r_10);
  const node_forearm_r_10 = new THREE.Group();
  node_forearm_r_10.name = "Right forearm__pivot";
  if (endpoint_forearm_r_10) {
    node_forearm_r_10.position.copy(endpoint_forearm_r_10.start);
    node_forearm_r_10.rotation.set(0, 0, 0);
    node_forearm_r_10.scale.set(1, 1, 1);
  } else {
    node_forearm_r_10.position.set(0.62, 1.0, 0.04);
    node_forearm_r_10.rotation.set(0.0, 0.0, 0.0);
    node_forearm_r_10.scale.set(1.0, 1.0, 1.0);
  }
  node_forearm_r_10.userData.sculptComponent = {"id": "forearm-r", "name": "Right forearm", "level": "meso", "role": "arm", "importance": 0.82, "confidence": 0.76, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Right forearm is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "upper-arm-r", "attachment": {"parentId": "upper-arm-r", "parentSocket": "upper-arm-r-socket", "localStart": [0.62, 1, 0.04], "localEnd": [0.62, 1.2730000000000001, 0.04], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.2, "height": 0.42, "depth": 0.2, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.62, 1, 0.04], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "arm", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "forearm-r-socket", "localPosition": [0.62, 1.2730000000000001, 0.04], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.126, 0], "scale": [0.15000000000000002, 0.315, 0.15000000000000002], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "armor-ivory"}}, "material": "armor-ivory", "materialLayers": ["armor-ivory"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["upper-arm-r->forearm-r"], "seams": ["upper-arm-r-forearm-r-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 203, 185, 1)", "secondaryAlbedo": "rgba(185, 155, 97, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.84, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(216, 203, 185, 1)"}, {"position": 1, "color": "rgba(185, 155, 97, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_forearm_r_10.userData.actionProfile = {"animationRole": "arm", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "forearm-r-socket", "localPosition": [0.62, 1.2730000000000001, 0.04], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.126, 0], "scale": [0.15000000000000002, 0.315, 0.15000000000000002], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "armor-ivory"}};
  (nodes["upper-arm-r"] ?? root).add(node_forearm_r_10);
  nodes["forearm-r"] = node_forearm_r_10;
  const mesh_forearm_r_10Geometry = endpoint_forearm_r_10
    ? new THREE.CylinderGeometry(endpoint_forearm_r_10.endRadius, endpoint_forearm_r_10.baseRadius, endpoint_forearm_r_10.length, 32, 12)
    : new THREE.CapsuleGeometry(0.35, 0.7, 16, 32);
  const mesh_forearm_r_10 = new THREE.Mesh(
    mesh_forearm_r_10Geometry,
    materialMap["armor-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_forearm_r_10.name = "Right forearm";
  if (endpoint_forearm_r_10) {
    mesh_forearm_r_10.position.copy(endpoint_forearm_r_10.midpoint);
    mesh_forearm_r_10.quaternion.copy(endpoint_forearm_r_10.quaternion);
  }
  mesh_forearm_r_10.castShadow = options.castShadow ?? true;
  mesh_forearm_r_10.receiveShadow = options.receiveShadow ?? true;
  mesh_forearm_r_10.userData.sculptComponent = {"id": "forearm-r", "name": "Right forearm", "level": "meso", "role": "arm", "importance": 0.82, "confidence": 0.76, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Right forearm is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "upper-arm-r", "attachment": {"parentId": "upper-arm-r", "parentSocket": "upper-arm-r-socket", "localStart": [0.62, 1, 0.04], "localEnd": [0.62, 1.2730000000000001, 0.04], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.2, "height": 0.42, "depth": 0.2, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.62, 1, 0.04], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "arm", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "forearm-r-socket", "localPosition": [0.62, 1.2730000000000001, 0.04], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.126, 0], "scale": [0.15000000000000002, 0.315, 0.15000000000000002], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "forearm-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "armor-ivory"}}, "material": "armor-ivory", "materialLayers": ["armor-ivory"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["upper-arm-r->forearm-r"], "seams": ["upper-arm-r-forearm-r-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 203, 185, 1)", "secondaryAlbedo": "rgba(185, 155, 97, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.84, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(216, 203, 185, 1)"}, {"position": 1, "color": "rgba(185, 155, 97, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_forearm_r_10.add(mesh_forearm_r_10);
  meshes["forearm-r"] = mesh_forearm_r_10;
  colliders["forearm-r"] = {"type": "capsule", "offset": [0, 0.126, 0], "scale": [0.15000000000000002, 0.315, 0.15000000000000002], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["forearm-r"] ??= [];
  destructionGroups["forearm-r"].push(node_forearm_r_10);
  const socket_forearm_r_forearm_r_socket_0 = new THREE.Object3D();
  socket_forearm_r_forearm_r_socket_0.name = "forearm-r-socket";
  socket_forearm_r_forearm_r_socket_0.position.set(0.62, 1.2730000000000001, 0.04);
  socket_forearm_r_forearm_r_socket_0.rotation.set(0, 0, 0);
  socket_forearm_r_forearm_r_socket_0.userData.socket = {"id": "forearm-r-socket", "localPosition": [0.62, 1.2730000000000001, 0.04], "purpose": "attachment"};
  node_forearm_r_10.add(socket_forearm_r_forearm_r_socket_0);
  sockets["forearm-r:forearm-r-socket"] = socket_forearm_r_forearm_r_socket_0;

  const attachment_thigh_l_11 = {"parentId": "pelvis", "parentSocket": "pelvis-socket", "localStart": [-0.25, 0.52, 0], "localEnd": [-0.25, 0.806, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_thigh_l_11 = makeAttachmentEndpoint(attachment_thigh_l_11);
  const node_thigh_l_11 = new THREE.Group();
  node_thigh_l_11.name = "Left thigh__pivot";
  if (endpoint_thigh_l_11) {
    node_thigh_l_11.position.copy(endpoint_thigh_l_11.start);
    node_thigh_l_11.rotation.set(0, 0, 0);
    node_thigh_l_11.scale.set(1, 1, 1);
  } else {
    node_thigh_l_11.position.set(-0.25, 0.52, 0.0);
    node_thigh_l_11.rotation.set(0.0, 0.0, 0.0);
    node_thigh_l_11.scale.set(1.0, 1.0, 1.0);
  }
  node_thigh_l_11.userData.sculptComponent = {"id": "thigh-l", "name": "Left thigh", "level": "meso", "role": "leg", "importance": 0.82, "confidence": 0.76, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Left thigh is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "pelvis", "attachment": {"parentId": "pelvis", "parentSocket": "pelvis-socket", "localStart": [-0.25, 0.52, 0], "localEnd": [-0.25, 0.806, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.28, "height": 0.44, "depth": 0.28, "units": "relative", "confidence": 0.76}, "transform": {"position": [-0.25, 0.52, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "leg", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "thigh-l-socket", "localPosition": [-0.25, 0.806, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.132, 0], "scale": [0.21000000000000002, 0.33, 0.21000000000000002], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thigh-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}}, "material": "skin-indigo", "materialLayers": ["skin-indigo"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["pelvis->thigh-l"], "seams": ["pelvis-thigh-l-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(52, 57, 101, 1)", "secondaryAlbedo": "rgba(92, 86, 140, 1)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(52, 57, 101, 1)"}, {"position": 1, "color": "rgba(92, 86, 140, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_thigh_l_11.userData.actionProfile = {"animationRole": "leg", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "thigh-l-socket", "localPosition": [-0.25, 0.806, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.132, 0], "scale": [0.21000000000000002, 0.33, 0.21000000000000002], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thigh-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}};
  (nodes["pelvis"] ?? root).add(node_thigh_l_11);
  nodes["thigh-l"] = node_thigh_l_11;
  const mesh_thigh_l_11Geometry = endpoint_thigh_l_11
    ? new THREE.CylinderGeometry(endpoint_thigh_l_11.endRadius, endpoint_thigh_l_11.baseRadius, endpoint_thigh_l_11.length, 32, 12)
    : new THREE.CapsuleGeometry(0.35, 0.7, 16, 32);
  const mesh_thigh_l_11 = new THREE.Mesh(
    mesh_thigh_l_11Geometry,
    materialMap["skin-indigo"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_l_11.name = "Left thigh";
  if (endpoint_thigh_l_11) {
    mesh_thigh_l_11.position.copy(endpoint_thigh_l_11.midpoint);
    mesh_thigh_l_11.quaternion.copy(endpoint_thigh_l_11.quaternion);
  }
  mesh_thigh_l_11.castShadow = options.castShadow ?? true;
  mesh_thigh_l_11.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_l_11.userData.sculptComponent = {"id": "thigh-l", "name": "Left thigh", "level": "meso", "role": "leg", "importance": 0.82, "confidence": 0.76, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Left thigh is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "pelvis", "attachment": {"parentId": "pelvis", "parentSocket": "pelvis-socket", "localStart": [-0.25, 0.52, 0], "localEnd": [-0.25, 0.806, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.28, "height": 0.44, "depth": 0.28, "units": "relative", "confidence": 0.76}, "transform": {"position": [-0.25, 0.52, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "leg", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "thigh-l-socket", "localPosition": [-0.25, 0.806, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.132, 0], "scale": [0.21000000000000002, 0.33, 0.21000000000000002], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thigh-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}}, "material": "skin-indigo", "materialLayers": ["skin-indigo"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["pelvis->thigh-l"], "seams": ["pelvis-thigh-l-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(52, 57, 101, 1)", "secondaryAlbedo": "rgba(92, 86, 140, 1)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(52, 57, 101, 1)"}, {"position": 1, "color": "rgba(92, 86, 140, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_thigh_l_11.add(mesh_thigh_l_11);
  meshes["thigh-l"] = mesh_thigh_l_11;
  colliders["thigh-l"] = {"type": "capsule", "offset": [0, 0.132, 0], "scale": [0.21000000000000002, 0.33, 0.21000000000000002], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["thigh-l"] ??= [];
  destructionGroups["thigh-l"].push(node_thigh_l_11);
  const socket_thigh_l_thigh_l_socket_0 = new THREE.Object3D();
  socket_thigh_l_thigh_l_socket_0.name = "thigh-l-socket";
  socket_thigh_l_thigh_l_socket_0.position.set(-0.25, 0.806, 0.0);
  socket_thigh_l_thigh_l_socket_0.rotation.set(0, 0, 0);
  socket_thigh_l_thigh_l_socket_0.userData.socket = {"id": "thigh-l-socket", "localPosition": [-0.25, 0.806, 0], "purpose": "attachment"};
  node_thigh_l_11.add(socket_thigh_l_thigh_l_socket_0);
  sockets["thigh-l:thigh-l-socket"] = socket_thigh_l_thigh_l_socket_0;

  const attachment_thigh_r_12 = {"parentId": "pelvis", "parentSocket": "pelvis-socket", "localStart": [0.25, 0.52, 0], "localEnd": [0.25, 0.806, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_thigh_r_12 = makeAttachmentEndpoint(attachment_thigh_r_12);
  const node_thigh_r_12 = new THREE.Group();
  node_thigh_r_12.name = "Right thigh__pivot";
  if (endpoint_thigh_r_12) {
    node_thigh_r_12.position.copy(endpoint_thigh_r_12.start);
    node_thigh_r_12.rotation.set(0, 0, 0);
    node_thigh_r_12.scale.set(1, 1, 1);
  } else {
    node_thigh_r_12.position.set(0.25, 0.52, 0.0);
    node_thigh_r_12.rotation.set(0.0, 0.0, 0.0);
    node_thigh_r_12.scale.set(1.0, 1.0, 1.0);
  }
  node_thigh_r_12.userData.sculptComponent = {"id": "thigh-r", "name": "Right thigh", "level": "meso", "role": "leg", "importance": 0.82, "confidence": 0.76, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Right thigh is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "pelvis", "attachment": {"parentId": "pelvis", "parentSocket": "pelvis-socket", "localStart": [0.25, 0.52, 0], "localEnd": [0.25, 0.806, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.28, "height": 0.44, "depth": 0.28, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.25, 0.52, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "leg", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "thigh-r-socket", "localPosition": [0.25, 0.806, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.132, 0], "scale": [0.21000000000000002, 0.33, 0.21000000000000002], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thigh-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}}, "material": "skin-indigo", "materialLayers": ["skin-indigo"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["pelvis->thigh-r"], "seams": ["pelvis-thigh-r-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(52, 57, 101, 1)", "secondaryAlbedo": "rgba(92, 86, 140, 1)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(52, 57, 101, 1)"}, {"position": 1, "color": "rgba(92, 86, 140, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_thigh_r_12.userData.actionProfile = {"animationRole": "leg", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "thigh-r-socket", "localPosition": [0.25, 0.806, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.132, 0], "scale": [0.21000000000000002, 0.33, 0.21000000000000002], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thigh-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}};
  (nodes["pelvis"] ?? root).add(node_thigh_r_12);
  nodes["thigh-r"] = node_thigh_r_12;
  const mesh_thigh_r_12Geometry = endpoint_thigh_r_12
    ? new THREE.CylinderGeometry(endpoint_thigh_r_12.endRadius, endpoint_thigh_r_12.baseRadius, endpoint_thigh_r_12.length, 32, 12)
    : new THREE.CapsuleGeometry(0.35, 0.7, 16, 32);
  const mesh_thigh_r_12 = new THREE.Mesh(
    mesh_thigh_r_12Geometry,
    materialMap["skin-indigo"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_thigh_r_12.name = "Right thigh";
  if (endpoint_thigh_r_12) {
    mesh_thigh_r_12.position.copy(endpoint_thigh_r_12.midpoint);
    mesh_thigh_r_12.quaternion.copy(endpoint_thigh_r_12.quaternion);
  }
  mesh_thigh_r_12.castShadow = options.castShadow ?? true;
  mesh_thigh_r_12.receiveShadow = options.receiveShadow ?? true;
  mesh_thigh_r_12.userData.sculptComponent = {"id": "thigh-r", "name": "Right thigh", "level": "meso", "role": "leg", "importance": 0.82, "confidence": 0.76, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Right thigh is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "pelvis", "attachment": {"parentId": "pelvis", "parentSocket": "pelvis-socket", "localStart": [0.25, 0.52, 0], "localEnd": [0.25, 0.806, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.28, "height": 0.44, "depth": 0.28, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.25, 0.52, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "leg", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "thigh-r-socket", "localPosition": [0.25, 0.806, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.132, 0], "scale": [0.21000000000000002, 0.33, 0.21000000000000002], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "thigh-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}}, "material": "skin-indigo", "materialLayers": ["skin-indigo"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["pelvis->thigh-r"], "seams": ["pelvis-thigh-r-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(52, 57, 101, 1)", "secondaryAlbedo": "rgba(92, 86, 140, 1)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(52, 57, 101, 1)"}, {"position": 1, "color": "rgba(92, 86, 140, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_thigh_r_12.add(mesh_thigh_r_12);
  meshes["thigh-r"] = mesh_thigh_r_12;
  colliders["thigh-r"] = {"type": "capsule", "offset": [0, 0.132, 0], "scale": [0.21000000000000002, 0.33, 0.21000000000000002], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["thigh-r"] ??= [];
  destructionGroups["thigh-r"].push(node_thigh_r_12);
  const socket_thigh_r_thigh_r_socket_0 = new THREE.Object3D();
  socket_thigh_r_thigh_r_socket_0.name = "thigh-r-socket";
  socket_thigh_r_thigh_r_socket_0.position.set(0.25, 0.806, 0.0);
  socket_thigh_r_thigh_r_socket_0.rotation.set(0, 0, 0);
  socket_thigh_r_thigh_r_socket_0.userData.socket = {"id": "thigh-r-socket", "localPosition": [0.25, 0.806, 0], "purpose": "attachment"};
  node_thigh_r_12.add(socket_thigh_r_thigh_r_socket_0);
  sockets["thigh-r:thigh-r-socket"] = socket_thigh_r_thigh_r_socket_0;

  const attachment_shin_l_13 = {"parentId": "thigh-l", "parentSocket": "thigh-l-socket", "localStart": [-0.25, 0.26, 0], "localEnd": [-0.25, 0.48100000000000004, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_shin_l_13 = makeAttachmentEndpoint(attachment_shin_l_13);
  const node_shin_l_13 = new THREE.Group();
  node_shin_l_13.name = "Left shin__pivot";
  if (endpoint_shin_l_13) {
    node_shin_l_13.position.copy(endpoint_shin_l_13.start);
    node_shin_l_13.rotation.set(0, 0, 0);
    node_shin_l_13.scale.set(1, 1, 1);
  } else {
    node_shin_l_13.position.set(-0.25, 0.26, 0.0);
    node_shin_l_13.rotation.set(0.0, 0.0, 0.0);
    node_shin_l_13.scale.set(1.0, 1.0, 1.0);
  }
  node_shin_l_13.userData.sculptComponent = {"id": "shin-l", "name": "Left shin", "level": "meso", "role": "leg", "importance": 0.82, "confidence": 0.76, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Left shin is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "thigh-l", "attachment": {"parentId": "thigh-l", "parentSocket": "thigh-l-socket", "localStart": [-0.25, 0.26, 0], "localEnd": [-0.25, 0.48100000000000004, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.22, "height": 0.34, "depth": 0.22, "units": "relative", "confidence": 0.76}, "transform": {"position": [-0.25, 0.26, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "leg", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "shin-l-socket", "localPosition": [-0.25, 0.48100000000000004, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.10200000000000001, 0], "scale": [0.165, 0.255, 0.165], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shin-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}}, "material": "skin-indigo", "materialLayers": ["skin-indigo"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["thigh-l->shin-l"], "seams": ["thigh-l-shin-l-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(52, 57, 101, 1)", "secondaryAlbedo": "rgba(92, 86, 140, 1)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(52, 57, 101, 1)"}, {"position": 1, "color": "rgba(92, 86, 140, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_shin_l_13.userData.actionProfile = {"animationRole": "leg", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "shin-l-socket", "localPosition": [-0.25, 0.48100000000000004, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.10200000000000001, 0], "scale": [0.165, 0.255, 0.165], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shin-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}};
  (nodes["thigh-l"] ?? root).add(node_shin_l_13);
  nodes["shin-l"] = node_shin_l_13;
  const mesh_shin_l_13Geometry = endpoint_shin_l_13
    ? new THREE.CylinderGeometry(endpoint_shin_l_13.endRadius, endpoint_shin_l_13.baseRadius, endpoint_shin_l_13.length, 32, 12)
    : new THREE.CapsuleGeometry(0.35, 0.7, 16, 32);
  const mesh_shin_l_13 = new THREE.Mesh(
    mesh_shin_l_13Geometry,
    materialMap["skin-indigo"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_l_13.name = "Left shin";
  if (endpoint_shin_l_13) {
    mesh_shin_l_13.position.copy(endpoint_shin_l_13.midpoint);
    mesh_shin_l_13.quaternion.copy(endpoint_shin_l_13.quaternion);
  }
  mesh_shin_l_13.castShadow = options.castShadow ?? true;
  mesh_shin_l_13.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_l_13.userData.sculptComponent = {"id": "shin-l", "name": "Left shin", "level": "meso", "role": "leg", "importance": 0.82, "confidence": 0.76, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Left shin is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "thigh-l", "attachment": {"parentId": "thigh-l", "parentSocket": "thigh-l-socket", "localStart": [-0.25, 0.26, 0], "localEnd": [-0.25, 0.48100000000000004, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.22, "height": 0.34, "depth": 0.22, "units": "relative", "confidence": 0.76}, "transform": {"position": [-0.25, 0.26, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "leg", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "shin-l-socket", "localPosition": [-0.25, 0.48100000000000004, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.10200000000000001, 0], "scale": [0.165, 0.255, 0.165], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shin-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}}, "material": "skin-indigo", "materialLayers": ["skin-indigo"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["thigh-l->shin-l"], "seams": ["thigh-l-shin-l-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(52, 57, 101, 1)", "secondaryAlbedo": "rgba(92, 86, 140, 1)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(52, 57, 101, 1)"}, {"position": 1, "color": "rgba(92, 86, 140, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_shin_l_13.add(mesh_shin_l_13);
  meshes["shin-l"] = mesh_shin_l_13;
  colliders["shin-l"] = {"type": "capsule", "offset": [0, 0.10200000000000001, 0], "scale": [0.165, 0.255, 0.165], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["shin-l"] ??= [];
  destructionGroups["shin-l"].push(node_shin_l_13);
  const socket_shin_l_shin_l_socket_0 = new THREE.Object3D();
  socket_shin_l_shin_l_socket_0.name = "shin-l-socket";
  socket_shin_l_shin_l_socket_0.position.set(-0.25, 0.48100000000000004, 0.0);
  socket_shin_l_shin_l_socket_0.rotation.set(0, 0, 0);
  socket_shin_l_shin_l_socket_0.userData.socket = {"id": "shin-l-socket", "localPosition": [-0.25, 0.48100000000000004, 0], "purpose": "attachment"};
  node_shin_l_13.add(socket_shin_l_shin_l_socket_0);
  sockets["shin-l:shin-l-socket"] = socket_shin_l_shin_l_socket_0;

  const attachment_shin_r_14 = {"parentId": "thigh-r", "parentSocket": "thigh-r-socket", "localStart": [0.25, 0.26, 0], "localEnd": [0.25, 0.48100000000000004, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_shin_r_14 = makeAttachmentEndpoint(attachment_shin_r_14);
  const node_shin_r_14 = new THREE.Group();
  node_shin_r_14.name = "Right shin__pivot";
  if (endpoint_shin_r_14) {
    node_shin_r_14.position.copy(endpoint_shin_r_14.start);
    node_shin_r_14.rotation.set(0, 0, 0);
    node_shin_r_14.scale.set(1, 1, 1);
  } else {
    node_shin_r_14.position.set(0.25, 0.26, 0.0);
    node_shin_r_14.rotation.set(0.0, 0.0, 0.0);
    node_shin_r_14.scale.set(1.0, 1.0, 1.0);
  }
  node_shin_r_14.userData.sculptComponent = {"id": "shin-r", "name": "Right shin", "level": "meso", "role": "leg", "importance": 0.82, "confidence": 0.76, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Right shin is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "thigh-r", "attachment": {"parentId": "thigh-r", "parentSocket": "thigh-r-socket", "localStart": [0.25, 0.26, 0], "localEnd": [0.25, 0.48100000000000004, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.22, "height": 0.34, "depth": 0.22, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.25, 0.26, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "leg", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "shin-r-socket", "localPosition": [0.25, 0.48100000000000004, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.10200000000000001, 0], "scale": [0.165, 0.255, 0.165], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shin-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}}, "material": "skin-indigo", "materialLayers": ["skin-indigo"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["thigh-r->shin-r"], "seams": ["thigh-r-shin-r-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(52, 57, 101, 1)", "secondaryAlbedo": "rgba(92, 86, 140, 1)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(52, 57, 101, 1)"}, {"position": 1, "color": "rgba(92, 86, 140, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_shin_r_14.userData.actionProfile = {"animationRole": "leg", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "shin-r-socket", "localPosition": [0.25, 0.48100000000000004, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.10200000000000001, 0], "scale": [0.165, 0.255, 0.165], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shin-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}};
  (nodes["thigh-r"] ?? root).add(node_shin_r_14);
  nodes["shin-r"] = node_shin_r_14;
  const mesh_shin_r_14Geometry = endpoint_shin_r_14
    ? new THREE.CylinderGeometry(endpoint_shin_r_14.endRadius, endpoint_shin_r_14.baseRadius, endpoint_shin_r_14.length, 32, 12)
    : new THREE.CapsuleGeometry(0.35, 0.7, 16, 32);
  const mesh_shin_r_14 = new THREE.Mesh(
    mesh_shin_r_14Geometry,
    materialMap["skin-indigo"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shin_r_14.name = "Right shin";
  if (endpoint_shin_r_14) {
    mesh_shin_r_14.position.copy(endpoint_shin_r_14.midpoint);
    mesh_shin_r_14.quaternion.copy(endpoint_shin_r_14.quaternion);
  }
  mesh_shin_r_14.castShadow = options.castShadow ?? true;
  mesh_shin_r_14.receiveShadow = options.receiveShadow ?? true;
  mesh_shin_r_14.userData.sculptComponent = {"id": "shin-r", "name": "Right shin", "level": "meso", "role": "leg", "importance": 0.82, "confidence": 0.76, "primitive": "capsule", "topologyClass": "assembled-solid", "topologyRationale": "Right shin is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "thigh-r", "attachment": {"parentId": "thigh-r", "parentSocket": "thigh-r-socket", "localStart": [0.25, 0.26, 0], "localEnd": [0.25, 0.48100000000000004, 0], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.22, "height": 0.34, "depth": 0.22, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.25, 0.26, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "leg", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "shin-r-socket", "localPosition": [0.25, 0.48100000000000004, 0], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.10200000000000001, 0], "scale": [0.165, 0.255, 0.165], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shin-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "skin-indigo"}}, "material": "skin-indigo", "materialLayers": ["skin-indigo"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["thigh-r->shin-r"], "seams": ["thigh-r-shin-r-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(52, 57, 101, 1)", "secondaryAlbedo": "rgba(92, 86, 140, 1)", "materialClass": "skin", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(52, 57, 101, 1)"}, {"position": 1, "color": "rgba(92, 86, 140, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_shin_r_14.add(mesh_shin_r_14);
  meshes["shin-r"] = mesh_shin_r_14;
  colliders["shin-r"] = {"type": "capsule", "offset": [0, 0.10200000000000001, 0], "scale": [0.165, 0.255, 0.165], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["shin-r"] ??= [];
  destructionGroups["shin-r"].push(node_shin_r_14);
  const socket_shin_r_shin_r_socket_0 = new THREE.Object3D();
  socket_shin_r_shin_r_socket_0.name = "shin-r-socket";
  socket_shin_r_shin_r_socket_0.position.set(0.25, 0.48100000000000004, 0.0);
  socket_shin_r_shin_r_socket_0.rotation.set(0, 0, 0);
  socket_shin_r_shin_r_socket_0.userData.socket = {"id": "shin-r-socket", "localPosition": [0.25, 0.48100000000000004, 0], "purpose": "attachment"};
  node_shin_r_14.add(socket_shin_r_shin_r_socket_0);
  sockets["shin-r:shin-r-socket"] = socket_shin_r_shin_r_socket_0;

  const attachment_foot_l_15 = {"parentId": "shin-l", "parentSocket": "shin-l-socket", "localStart": [-0.25, 0.1, 0.09], "localEnd": [-0.25, 0.217, 0.09], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_foot_l_15 = makeAttachmentEndpoint(attachment_foot_l_15);
  const node_foot_l_15 = new THREE.Group();
  node_foot_l_15.name = "Left armored foot__pivot";
  if (endpoint_foot_l_15) {
    node_foot_l_15.position.copy(endpoint_foot_l_15.start);
    node_foot_l_15.rotation.set(0, 0, 0);
    node_foot_l_15.scale.set(1, 1, 1);
  } else {
    node_foot_l_15.position.set(-0.25, 0.1, 0.09);
    node_foot_l_15.rotation.set(0.0, 0.0, 0.0);
    node_foot_l_15.scale.set(1.0, 1.0, 1.0);
  }
  node_foot_l_15.userData.sculptComponent = {"id": "foot-l", "name": "Left armored foot", "level": "meso", "role": "foot", "importance": 0.82, "confidence": 0.76, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Left armored foot is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "shin-l", "attachment": {"parentId": "shin-l", "parentSocket": "shin-l-socket", "localStart": [-0.25, 0.1, 0.09], "localEnd": [-0.25, 0.217, 0.09], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.34, "height": 0.18, "depth": 0.48, "units": "relative", "confidence": 0.76}, "transform": {"position": [-0.25, 0.1, 0.09], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "foot", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "foot-l-socket", "localPosition": [-0.25, 0.217, 0.09], "purpose": "attachment"}], "collider": {"type": "sphere", "offset": [0, 0.054, 0], "scale": [0.255, 0.135, 0.36], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "armor-ivory"}}, "material": "armor-ivory", "materialLayers": ["armor-ivory"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["shin-l->foot-l"], "seams": ["shin-l-foot-l-overlap"], "localFeatures": [{"id": "boot-diamond-grid", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 203, 185, 1)", "secondaryAlbedo": "rgba(185, 155, 97, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.84, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(216, 203, 185, 1)"}, {"position": 1, "color": "rgba(185, 155, 97, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["boot-diamond-grid"], "fidelityTier": "structural"};
  node_foot_l_15.userData.actionProfile = {"animationRole": "foot", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "foot-l-socket", "localPosition": [-0.25, 0.217, 0.09], "purpose": "attachment"}], "collider": {"type": "sphere", "offset": [0, 0.054, 0], "scale": [0.255, 0.135, 0.36], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "armor-ivory"}};
  (nodes["shin-l"] ?? root).add(node_foot_l_15);
  nodes["foot-l"] = node_foot_l_15;
  const mesh_foot_l_15Geometry = endpoint_foot_l_15
    ? new THREE.CylinderGeometry(endpoint_foot_l_15.endRadius, endpoint_foot_l_15.baseRadius, endpoint_foot_l_15.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_foot_l_15 = new THREE.Mesh(
    mesh_foot_l_15Geometry,
    materialMap["armor-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foot_l_15.name = "Left armored foot";
  if (endpoint_foot_l_15) {
    mesh_foot_l_15.position.copy(endpoint_foot_l_15.midpoint);
    mesh_foot_l_15.quaternion.copy(endpoint_foot_l_15.quaternion);
  }
  mesh_foot_l_15.castShadow = options.castShadow ?? true;
  mesh_foot_l_15.receiveShadow = options.receiveShadow ?? true;
  mesh_foot_l_15.userData.sculptComponent = {"id": "foot-l", "name": "Left armored foot", "level": "meso", "role": "foot", "importance": 0.82, "confidence": 0.76, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Left armored foot is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "shin-l", "attachment": {"parentId": "shin-l", "parentSocket": "shin-l-socket", "localStart": [-0.25, 0.1, 0.09], "localEnd": [-0.25, 0.217, 0.09], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.34, "height": 0.18, "depth": 0.48, "units": "relative", "confidence": 0.76}, "transform": {"position": [-0.25, 0.1, 0.09], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "foot", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "foot-l-socket", "localPosition": [-0.25, 0.217, 0.09], "purpose": "attachment"}], "collider": {"type": "sphere", "offset": [0, 0.054, 0], "scale": [0.255, 0.135, 0.36], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "armor-ivory"}}, "material": "armor-ivory", "materialLayers": ["armor-ivory"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["shin-l->foot-l"], "seams": ["shin-l-foot-l-overlap"], "localFeatures": [{"id": "boot-diamond-grid", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 203, 185, 1)", "secondaryAlbedo": "rgba(185, 155, 97, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.84, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(216, 203, 185, 1)"}, {"position": 1, "color": "rgba(185, 155, 97, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["boot-diamond-grid"], "fidelityTier": "structural"};
  node_foot_l_15.add(mesh_foot_l_15);
  meshes["foot-l"] = mesh_foot_l_15;
  colliders["foot-l"] = {"type": "sphere", "offset": [0, 0.054, 0], "scale": [0.255, 0.135, 0.36], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["foot-l"] ??= [];
  destructionGroups["foot-l"].push(node_foot_l_15);
  const socket_foot_l_foot_l_socket_0 = new THREE.Object3D();
  socket_foot_l_foot_l_socket_0.name = "foot-l-socket";
  socket_foot_l_foot_l_socket_0.position.set(-0.25, 0.217, 0.09);
  socket_foot_l_foot_l_socket_0.rotation.set(0, 0, 0);
  socket_foot_l_foot_l_socket_0.userData.socket = {"id": "foot-l-socket", "localPosition": [-0.25, 0.217, 0.09], "purpose": "attachment"};
  node_foot_l_15.add(socket_foot_l_foot_l_socket_0);
  sockets["foot-l:foot-l-socket"] = socket_foot_l_foot_l_socket_0;

  const attachment_foot_r_16 = {"parentId": "shin-r", "parentSocket": "shin-r-socket", "localStart": [0.25, 0.1, 0.09], "localEnd": [0.25, 0.217, 0.09], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_foot_r_16 = makeAttachmentEndpoint(attachment_foot_r_16);
  const node_foot_r_16 = new THREE.Group();
  node_foot_r_16.name = "Right armored foot__pivot";
  if (endpoint_foot_r_16) {
    node_foot_r_16.position.copy(endpoint_foot_r_16.start);
    node_foot_r_16.rotation.set(0, 0, 0);
    node_foot_r_16.scale.set(1, 1, 1);
  } else {
    node_foot_r_16.position.set(0.25, 0.1, 0.09);
    node_foot_r_16.rotation.set(0.0, 0.0, 0.0);
    node_foot_r_16.scale.set(1.0, 1.0, 1.0);
  }
  node_foot_r_16.userData.sculptComponent = {"id": "foot-r", "name": "Right armored foot", "level": "meso", "role": "foot", "importance": 0.82, "confidence": 0.76, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Right armored foot is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "shin-r", "attachment": {"parentId": "shin-r", "parentSocket": "shin-r-socket", "localStart": [0.25, 0.1, 0.09], "localEnd": [0.25, 0.217, 0.09], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.34, "height": 0.18, "depth": 0.48, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.25, 0.1, 0.09], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "foot", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "foot-r-socket", "localPosition": [0.25, 0.217, 0.09], "purpose": "attachment"}], "collider": {"type": "sphere", "offset": [0, 0.054, 0], "scale": [0.255, 0.135, 0.36], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "armor-ivory"}}, "material": "armor-ivory", "materialLayers": ["armor-ivory"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["shin-r->foot-r"], "seams": ["shin-r-foot-r-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 203, 185, 1)", "secondaryAlbedo": "rgba(185, 155, 97, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.84, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(216, 203, 185, 1)"}, {"position": 1, "color": "rgba(185, 155, 97, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_foot_r_16.userData.actionProfile = {"animationRole": "foot", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "foot-r-socket", "localPosition": [0.25, 0.217, 0.09], "purpose": "attachment"}], "collider": {"type": "sphere", "offset": [0, 0.054, 0], "scale": [0.255, 0.135, 0.36], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "armor-ivory"}};
  (nodes["shin-r"] ?? root).add(node_foot_r_16);
  nodes["foot-r"] = node_foot_r_16;
  const mesh_foot_r_16Geometry = endpoint_foot_r_16
    ? new THREE.CylinderGeometry(endpoint_foot_r_16.endRadius, endpoint_foot_r_16.baseRadius, endpoint_foot_r_16.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_foot_r_16 = new THREE.Mesh(
    mesh_foot_r_16Geometry,
    materialMap["armor-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_foot_r_16.name = "Right armored foot";
  if (endpoint_foot_r_16) {
    mesh_foot_r_16.position.copy(endpoint_foot_r_16.midpoint);
    mesh_foot_r_16.quaternion.copy(endpoint_foot_r_16.quaternion);
  }
  mesh_foot_r_16.castShadow = options.castShadow ?? true;
  mesh_foot_r_16.receiveShadow = options.receiveShadow ?? true;
  mesh_foot_r_16.userData.sculptComponent = {"id": "foot-r", "name": "Right armored foot", "level": "meso", "role": "foot", "importance": 0.82, "confidence": 0.76, "primitive": "ellipsoid", "topologyClass": "assembled-solid", "topologyRationale": "Right armored foot is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "shin-r", "attachment": {"parentId": "shin-r", "parentSocket": "shin-r-socket", "localStart": [0.25, 0.1, 0.09], "localEnd": [0.25, 0.217, 0.09], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.34, "height": 0.18, "depth": 0.48, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.25, 0.1, 0.09], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "foot", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "foot-r-socket", "localPosition": [0.25, 0.217, 0.09], "purpose": "attachment"}], "collider": {"type": "sphere", "offset": [0, 0.054, 0], "scale": [0.255, 0.135, 0.36], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "foot-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "armor-ivory"}}, "material": "armor-ivory", "materialLayers": ["armor-ivory"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["shin-r->foot-r"], "seams": ["shin-r-foot-r-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 203, 185, 1)", "secondaryAlbedo": "rgba(185, 155, 97, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.84, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(216, 203, 185, 1)"}, {"position": 1, "color": "rgba(185, 155, 97, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_foot_r_16.add(mesh_foot_r_16);
  meshes["foot-r"] = mesh_foot_r_16;
  colliders["foot-r"] = {"type": "sphere", "offset": [0, 0.054, 0], "scale": [0.255, 0.135, 0.36], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["foot-r"] ??= [];
  destructionGroups["foot-r"].push(node_foot_r_16);
  const socket_foot_r_foot_r_socket_0 = new THREE.Object3D();
  socket_foot_r_foot_r_socket_0.name = "foot-r-socket";
  socket_foot_r_foot_r_socket_0.position.set(0.25, 0.217, 0.09);
  socket_foot_r_foot_r_socket_0.rotation.set(0, 0, 0);
  socket_foot_r_foot_r_socket_0.userData.socket = {"id": "foot-r-socket", "localPosition": [0.25, 0.217, 0.09], "purpose": "attachment"};
  node_foot_r_16.add(socket_foot_r_foot_r_socket_0);
  sockets["foot-r:foot-r-socket"] = socket_foot_r_foot_r_socket_0;

  const attachment_shoulder_l_17 = {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [-0.52, 1.48, 0.02], "localEnd": [-0.52, 1.662, 0.02], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_shoulder_l_17 = makeAttachmentEndpoint(attachment_shoulder_l_17);
  const node_shoulder_l_17 = new THREE.Group();
  node_shoulder_l_17.name = "Left layered shoulder__pivot";
  if (endpoint_shoulder_l_17) {
    node_shoulder_l_17.position.copy(endpoint_shoulder_l_17.start);
    node_shoulder_l_17.rotation.set(0, 0, 0);
    node_shoulder_l_17.scale.set(1, 1, 1);
  } else {
    node_shoulder_l_17.position.set(-0.52, 1.48, 0.02);
    node_shoulder_l_17.rotation.set(0.0, 0.0, 0.0);
    node_shoulder_l_17.scale.set(1.0, 1.0, 1.0);
  }
  node_shoulder_l_17.userData.sculptComponent = {"id": "shoulder-l", "name": "Left layered shoulder", "level": "meso", "role": "armor-shell", "importance": 0.82, "confidence": 0.76, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Left layered shoulder is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "torso", "attachment": {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [-0.52, 1.48, 0.02], "localEnd": [-0.52, 1.662, 0.02], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.5, "height": 0.28, "depth": 0.34, "units": "relative", "confidence": 0.76}, "transform": {"position": [-0.52, 1.48, 0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "armor-shell", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "shoulder-l-socket", "localPosition": [-0.52, 1.662, 0.02], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.084, 0], "scale": [0.375, 0.21000000000000002, 0.255], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shoulder-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "armor-ivory"}}, "material": "armor-ivory", "materialLayers": ["armor-ivory"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["torso->shoulder-l"], "seams": ["torso-shoulder-l-overlap"], "localFeatures": [{"id": "layered-shoulder-plates", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 203, 185, 1)", "secondaryAlbedo": "rgba(185, 155, 97, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.84, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(216, 203, 185, 1)"}, {"position": 1, "color": "rgba(185, 155, 97, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["layered-shoulder-plates"], "fidelityTier": "structural"};
  node_shoulder_l_17.userData.actionProfile = {"animationRole": "armor-shell", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "shoulder-l-socket", "localPosition": [-0.52, 1.662, 0.02], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.084, 0], "scale": [0.375, 0.21000000000000002, 0.255], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shoulder-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "armor-ivory"}};
  (nodes["torso"] ?? root).add(node_shoulder_l_17);
  nodes["shoulder-l"] = node_shoulder_l_17;
  const mesh_shoulder_l_17Geometry = endpoint_shoulder_l_17
    ? new THREE.CylinderGeometry(endpoint_shoulder_l_17.endRadius, endpoint_shoulder_l_17.baseRadius, endpoint_shoulder_l_17.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  const mesh_shoulder_l_17 = new THREE.Mesh(
    mesh_shoulder_l_17Geometry,
    materialMap["armor-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shoulder_l_17.name = "Left layered shoulder";
  if (endpoint_shoulder_l_17) {
    mesh_shoulder_l_17.position.copy(endpoint_shoulder_l_17.midpoint);
    mesh_shoulder_l_17.quaternion.copy(endpoint_shoulder_l_17.quaternion);
  }
  mesh_shoulder_l_17.castShadow = options.castShadow ?? true;
  mesh_shoulder_l_17.receiveShadow = options.receiveShadow ?? true;
  mesh_shoulder_l_17.userData.sculptComponent = {"id": "shoulder-l", "name": "Left layered shoulder", "level": "meso", "role": "armor-shell", "importance": 0.82, "confidence": 0.76, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Left layered shoulder is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "torso", "attachment": {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [-0.52, 1.48, 0.02], "localEnd": [-0.52, 1.662, 0.02], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.5, "height": 0.28, "depth": 0.34, "units": "relative", "confidence": 0.76}, "transform": {"position": [-0.52, 1.48, 0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "armor-shell", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "shoulder-l-socket", "localPosition": [-0.52, 1.662, 0.02], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.084, 0], "scale": [0.375, 0.21000000000000002, 0.255], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shoulder-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "armor-ivory"}}, "material": "armor-ivory", "materialLayers": ["armor-ivory"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["torso->shoulder-l"], "seams": ["torso-shoulder-l-overlap"], "localFeatures": [{"id": "layered-shoulder-plates", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 203, 185, 1)", "secondaryAlbedo": "rgba(185, 155, 97, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.84, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(216, 203, 185, 1)"}, {"position": 1, "color": "rgba(185, 155, 97, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["layered-shoulder-plates"], "fidelityTier": "structural"};
  node_shoulder_l_17.add(mesh_shoulder_l_17);
  meshes["shoulder-l"] = mesh_shoulder_l_17;
  colliders["shoulder-l"] = {"type": "capsule", "offset": [0, 0.084, 0], "scale": [0.375, 0.21000000000000002, 0.255], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["shoulder-l"] ??= [];
  destructionGroups["shoulder-l"].push(node_shoulder_l_17);
  const socket_shoulder_l_shoulder_l_socket_0 = new THREE.Object3D();
  socket_shoulder_l_shoulder_l_socket_0.name = "shoulder-l-socket";
  socket_shoulder_l_shoulder_l_socket_0.position.set(-0.52, 1.662, 0.02);
  socket_shoulder_l_shoulder_l_socket_0.rotation.set(0, 0, 0);
  socket_shoulder_l_shoulder_l_socket_0.userData.socket = {"id": "shoulder-l-socket", "localPosition": [-0.52, 1.662, 0.02], "purpose": "attachment"};
  node_shoulder_l_17.add(socket_shoulder_l_shoulder_l_socket_0);
  sockets["shoulder-l:shoulder-l-socket"] = socket_shoulder_l_shoulder_l_socket_0;

  const attachment_shoulder_r_18 = {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0.52, 1.48, 0.02], "localEnd": [0.52, 1.662, 0.02], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_shoulder_r_18 = makeAttachmentEndpoint(attachment_shoulder_r_18);
  const node_shoulder_r_18 = new THREE.Group();
  node_shoulder_r_18.name = "Right layered shoulder__pivot";
  if (endpoint_shoulder_r_18) {
    node_shoulder_r_18.position.copy(endpoint_shoulder_r_18.start);
    node_shoulder_r_18.rotation.set(0, 0, 0);
    node_shoulder_r_18.scale.set(1, 1, 1);
  } else {
    node_shoulder_r_18.position.set(0.52, 1.48, 0.02);
    node_shoulder_r_18.rotation.set(0.0, 0.0, 0.0);
    node_shoulder_r_18.scale.set(1.0, 1.0, 1.0);
  }
  node_shoulder_r_18.userData.sculptComponent = {"id": "shoulder-r", "name": "Right layered shoulder", "level": "meso", "role": "armor-shell", "importance": 0.82, "confidence": 0.76, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Right layered shoulder is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "torso", "attachment": {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0.52, 1.48, 0.02], "localEnd": [0.52, 1.662, 0.02], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.5, "height": 0.28, "depth": 0.34, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.52, 1.48, 0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "armor-shell", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "shoulder-r-socket", "localPosition": [0.52, 1.662, 0.02], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.084, 0], "scale": [0.375, 0.21000000000000002, 0.255], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shoulder-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "armor-ivory"}}, "material": "armor-ivory", "materialLayers": ["armor-ivory"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["torso->shoulder-r"], "seams": ["torso-shoulder-r-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 203, 185, 1)", "secondaryAlbedo": "rgba(185, 155, 97, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.84, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(216, 203, 185, 1)"}, {"position": 1, "color": "rgba(185, 155, 97, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_shoulder_r_18.userData.actionProfile = {"animationRole": "armor-shell", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "shoulder-r-socket", "localPosition": [0.52, 1.662, 0.02], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.084, 0], "scale": [0.375, 0.21000000000000002, 0.255], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shoulder-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "armor-ivory"}};
  (nodes["torso"] ?? root).add(node_shoulder_r_18);
  nodes["shoulder-r"] = node_shoulder_r_18;
  const mesh_shoulder_r_18Geometry = endpoint_shoulder_r_18
    ? new THREE.CylinderGeometry(endpoint_shoulder_r_18.endRadius, endpoint_shoulder_r_18.baseRadius, endpoint_shoulder_r_18.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  const mesh_shoulder_r_18 = new THREE.Mesh(
    mesh_shoulder_r_18Geometry,
    materialMap["armor-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shoulder_r_18.name = "Right layered shoulder";
  if (endpoint_shoulder_r_18) {
    mesh_shoulder_r_18.position.copy(endpoint_shoulder_r_18.midpoint);
    mesh_shoulder_r_18.quaternion.copy(endpoint_shoulder_r_18.quaternion);
  }
  mesh_shoulder_r_18.castShadow = options.castShadow ?? true;
  mesh_shoulder_r_18.receiveShadow = options.receiveShadow ?? true;
  mesh_shoulder_r_18.userData.sculptComponent = {"id": "shoulder-r", "name": "Right layered shoulder", "level": "meso", "role": "armor-shell", "importance": 0.82, "confidence": 0.76, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Right layered shoulder is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "torso", "attachment": {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0.52, 1.48, 0.02], "localEnd": [0.52, 1.662, 0.02], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.5, "height": 0.28, "depth": 0.34, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.52, 1.48, 0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "armor-shell", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "shoulder-r-socket", "localPosition": [0.52, 1.662, 0.02], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.084, 0], "scale": [0.375, 0.21000000000000002, 0.255], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "shoulder-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "armor-ivory"}}, "material": "armor-ivory", "materialLayers": ["armor-ivory"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["torso->shoulder-r"], "seams": ["torso-shoulder-r-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 203, 185, 1)", "secondaryAlbedo": "rgba(185, 155, 97, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.84, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(216, 203, 185, 1)"}, {"position": 1, "color": "rgba(185, 155, 97, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_shoulder_r_18.add(mesh_shoulder_r_18);
  meshes["shoulder-r"] = mesh_shoulder_r_18;
  colliders["shoulder-r"] = {"type": "capsule", "offset": [0, 0.084, 0], "scale": [0.375, 0.21000000000000002, 0.255], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["shoulder-r"] ??= [];
  destructionGroups["shoulder-r"].push(node_shoulder_r_18);
  const socket_shoulder_r_shoulder_r_socket_0 = new THREE.Object3D();
  socket_shoulder_r_shoulder_r_socket_0.name = "shoulder-r-socket";
  socket_shoulder_r_shoulder_r_socket_0.position.set(0.52, 1.662, 0.02);
  socket_shoulder_r_shoulder_r_socket_0.rotation.set(0, 0, 0);
  socket_shoulder_r_shoulder_r_socket_0.userData.socket = {"id": "shoulder-r-socket", "localPosition": [0.52, 1.662, 0.02], "purpose": "attachment"};
  node_shoulder_r_18.add(socket_shoulder_r_shoulder_r_socket_0);
  sockets["shoulder-r:shoulder-r-socket"] = socket_shoulder_r_shoulder_r_socket_0;

  const attachment_mantle_19 = {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0, 1.58, -0.02], "localEnd": [0, 1.8270000000000002, -0.02], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_mantle_19 = makeAttachmentEndpoint(attachment_mantle_19);
  const node_mantle_19 = new THREE.Group();
  node_mantle_19.name = "High ivory mantle__pivot";
  if (endpoint_mantle_19) {
    node_mantle_19.position.copy(endpoint_mantle_19.start);
    node_mantle_19.rotation.set(0, 0, 0);
    node_mantle_19.scale.set(1, 1, 1);
  } else {
    node_mantle_19.position.set(0.0, 1.58, -0.02);
    node_mantle_19.rotation.set(0.0, 0.0, 0.0);
    node_mantle_19.scale.set(1.0, 1.0, 1.0);
  }
  node_mantle_19.userData.sculptComponent = {"id": "mantle", "name": "High ivory mantle", "level": "meso", "role": "armor-shell", "importance": 0.82, "confidence": 0.76, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "High ivory mantle is a thin articulated shell over the body.", "geometryDescriptor": {"topologyIntent": "conforming-shell with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "torso", "attachment": {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0, 1.58, -0.02], "localEnd": [0, 1.8270000000000002, -0.02], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.18, "height": 0.38, "depth": 0.4, "units": "relative", "confidence": 0.76}, "transform": {"position": [0, 1.58, -0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "armor-shell", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "mantle-socket", "localPosition": [0, 1.8270000000000002, -0.02], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.11399999999999999, 0], "scale": [0.885, 0.28500000000000003, 0.30000000000000004], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mantle", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "armor-ivory"}}, "material": "armor-ivory", "materialLayers": ["armor-ivory"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["torso->mantle"], "seams": ["torso-mantle-overlap"], "localFeatures": [{"id": "high-collar-gold-edge", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}, {"id": "armor-edge-chamfers", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 203, 185, 1)", "secondaryAlbedo": "rgba(185, 155, 97, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.84, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(216, 203, 185, 1)"}, {"position": 1, "color": "rgba(185, 155, 97, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["high-collar-gold-edge", "armor-edge-chamfers"], "fidelityTier": "structural"};
  node_mantle_19.userData.actionProfile = {"animationRole": "armor-shell", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "mantle-socket", "localPosition": [0, 1.8270000000000002, -0.02], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.11399999999999999, 0], "scale": [0.885, 0.28500000000000003, 0.30000000000000004], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mantle", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "armor-ivory"}};
  (nodes["torso"] ?? root).add(node_mantle_19);
  nodes["mantle"] = node_mantle_19;
  const mesh_mantle_19Geometry = endpoint_mantle_19
    ? new THREE.CylinderGeometry(endpoint_mantle_19.endRadius, endpoint_mantle_19.baseRadius, endpoint_mantle_19.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  const mesh_mantle_19 = new THREE.Mesh(
    mesh_mantle_19Geometry,
    materialMap["armor-ivory"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mantle_19.name = "High ivory mantle";
  if (endpoint_mantle_19) {
    mesh_mantle_19.position.copy(endpoint_mantle_19.midpoint);
    mesh_mantle_19.quaternion.copy(endpoint_mantle_19.quaternion);
  }
  mesh_mantle_19.castShadow = options.castShadow ?? true;
  mesh_mantle_19.receiveShadow = options.receiveShadow ?? true;
  mesh_mantle_19.userData.sculptComponent = {"id": "mantle", "name": "High ivory mantle", "level": "meso", "role": "armor-shell", "importance": 0.82, "confidence": 0.76, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "High ivory mantle is a thin articulated shell over the body.", "geometryDescriptor": {"topologyIntent": "conforming-shell with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "torso", "attachment": {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0, 1.58, -0.02], "localEnd": [0, 1.8270000000000002, -0.02], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.18, "height": 0.38, "depth": 0.4, "units": "relative", "confidence": 0.76}, "transform": {"position": [0, 1.58, -0.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "armor-shell", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "mantle-socket", "localPosition": [0, 1.8270000000000002, -0.02], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.11399999999999999, 0], "scale": [0.885, 0.28500000000000003, 0.30000000000000004], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "mantle", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "armor-ivory"}}, "material": "armor-ivory", "materialLayers": ["armor-ivory"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["torso->mantle"], "seams": ["torso-mantle-overlap"], "localFeatures": [{"id": "high-collar-gold-edge", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}, {"id": "armor-edge-chamfers", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(216, 203, 185, 1)", "secondaryAlbedo": "rgba(185, 155, 97, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.84, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(216, 203, 185, 1)"}, {"position": 1, "color": "rgba(185, 155, 97, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["high-collar-gold-edge", "armor-edge-chamfers"], "fidelityTier": "structural"};
  node_mantle_19.add(mesh_mantle_19);
  meshes["mantle"] = mesh_mantle_19;
  colliders["mantle"] = {"type": "capsule", "offset": [0, 0.11399999999999999, 0], "scale": [0.885, 0.28500000000000003, 0.30000000000000004], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["mantle"] ??= [];
  destructionGroups["mantle"].push(node_mantle_19);
  const socket_mantle_mantle_socket_0 = new THREE.Object3D();
  socket_mantle_mantle_socket_0.name = "mantle-socket";
  socket_mantle_mantle_socket_0.position.set(0.0, 1.8270000000000002, -0.02);
  socket_mantle_mantle_socket_0.rotation.set(0, 0, 0);
  socket_mantle_mantle_socket_0.userData.socket = {"id": "mantle-socket", "localPosition": [0, 1.8270000000000002, -0.02], "purpose": "attachment"};
  node_mantle_19.add(socket_mantle_mantle_socket_0);
  sockets["mantle:mantle-socket"] = socket_mantle_mantle_socket_0;

  const attachment_tabard_20 = {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0, 0.98, 0.36], "localEnd": [0, 1.5390000000000001, 0.36], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_tabard_20 = makeAttachmentEndpoint(attachment_tabard_20);
  const node_tabard_20 = new THREE.Group();
  node_tabard_20.name = "Justice tabard__pivot";
  if (endpoint_tabard_20) {
    node_tabard_20.position.copy(endpoint_tabard_20.start);
    node_tabard_20.rotation.set(0, 0, 0);
    node_tabard_20.scale.set(1, 1, 1);
  } else {
    node_tabard_20.position.set(0.0, 0.98, 0.36);
    node_tabard_20.rotation.set(0.0, 0.0, 0.0);
    node_tabard_20.scale.set(1.0, 1.0, 1.0);
  }
  node_tabard_20.userData.sculptComponent = {"id": "tabard", "name": "Justice tabard", "level": "meso", "role": "cloth-shell", "importance": 0.82, "confidence": 0.76, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "Justice tabard is a thin articulated shell over the body.", "geometryDescriptor": {"topologyIntent": "conforming-shell with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "camera projection front plus palette-continuation rear", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "torso", "attachment": {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0, 0.98, 0.36], "localEnd": [0, 1.5390000000000001, 0.36], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.48, "height": 0.86, "depth": 0.08, "units": "relative", "confidence": 0.76}, "transform": {"position": [0, 0.98, 0.36], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "cloth-shell", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "tabard-socket", "localPosition": [0, 1.5390000000000001, 0.36], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.258, 0], "scale": [0.36, 0.645, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tabard", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "projection-front"}}, "material": "projection-front", "materialLayers": ["projection-front"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["torso->tabard"], "seams": ["torso-tabard-overlap"], "localFeatures": [{"id": "justice-tabard", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(69, 75, 123, 1)", "secondaryAlbedo": "rgba(216, 203, 185, 1)", "materialClass": "fabric", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(69, 75, 123, 1)"}, {"position": 1, "color": "rgba(216, 203, 185, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["justice-tabard"], "fidelityTier": "structural"};
  node_tabard_20.userData.actionProfile = {"animationRole": "cloth-shell", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "tabard-socket", "localPosition": [0, 1.5390000000000001, 0.36], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.258, 0], "scale": [0.36, 0.645, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tabard", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "projection-front"}};
  (nodes["torso"] ?? root).add(node_tabard_20);
  nodes["tabard"] = node_tabard_20;
  const mesh_tabard_20Geometry = endpoint_tabard_20
    ? new THREE.CylinderGeometry(endpoint_tabard_20.endRadius, endpoint_tabard_20.baseRadius, endpoint_tabard_20.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  const mesh_tabard_20 = new THREE.Mesh(
    mesh_tabard_20Geometry,
    materialMap["projection-front"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabard_20.name = "Justice tabard";
  if (endpoint_tabard_20) {
    mesh_tabard_20.position.copy(endpoint_tabard_20.midpoint);
    mesh_tabard_20.quaternion.copy(endpoint_tabard_20.quaternion);
  }
  mesh_tabard_20.castShadow = options.castShadow ?? true;
  mesh_tabard_20.receiveShadow = options.receiveShadow ?? true;
  mesh_tabard_20.userData.sculptComponent = {"id": "tabard", "name": "Justice tabard", "level": "meso", "role": "cloth-shell", "importance": 0.82, "confidence": 0.76, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "Justice tabard is a thin articulated shell over the body.", "geometryDescriptor": {"topologyIntent": "conforming-shell with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "camera projection front plus palette-continuation rear", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "torso", "attachment": {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0, 0.98, 0.36], "localEnd": [0, 1.5390000000000001, 0.36], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.48, "height": 0.86, "depth": 0.08, "units": "relative", "confidence": 0.76}, "transform": {"position": [0, 0.98, 0.36], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "cloth-shell", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "tabard-socket", "localPosition": [0, 1.5390000000000001, 0.36], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.258, 0], "scale": [0.36, 0.645, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tabard", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "projection-front"}}, "material": "projection-front", "materialLayers": ["projection-front"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["torso->tabard"], "seams": ["torso-tabard-overlap"], "localFeatures": [{"id": "justice-tabard", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(69, 75, 123, 1)", "secondaryAlbedo": "rgba(216, 203, 185, 1)", "materialClass": "fabric", "materialClassConfidence": 0.86, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(69, 75, 123, 1)"}, {"position": 1, "color": "rgba(216, 203, 185, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["justice-tabard"], "fidelityTier": "structural"};
  node_tabard_20.add(mesh_tabard_20);
  meshes["tabard"] = mesh_tabard_20;
  colliders["tabard"] = {"type": "capsule", "offset": [0, 0.258, 0], "scale": [0.36, 0.645, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["tabard"] ??= [];
  destructionGroups["tabard"].push(node_tabard_20);
  const socket_tabard_tabard_socket_0 = new THREE.Object3D();
  socket_tabard_tabard_socket_0.name = "tabard-socket";
  socket_tabard_tabard_socket_0.position.set(0.0, 1.5390000000000001, 0.36);
  socket_tabard_tabard_socket_0.rotation.set(0, 0, 0);
  socket_tabard_tabard_socket_0.userData.socket = {"id": "tabard-socket", "localPosition": [0, 1.5390000000000001, 0.36], "purpose": "attachment"};
  node_tabard_20.add(socket_tabard_tabard_socket_0);
  sockets["tabard:tabard-socket"] = socket_tabard_tabard_socket_0;

  const attachment_crest_21 = {"parentId": "head", "parentSocket": "head-socket", "localStart": [0, 2.54, 0.54], "localEnd": [0, 2.852, 0.54], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_crest_21 = makeAttachmentEndpoint(attachment_crest_21);
  const node_crest_21 = new THREE.Group();
  node_crest_21.name = "Forehead crest assembly__pivot";
  if (endpoint_crest_21) {
    node_crest_21.position.copy(endpoint_crest_21.start);
    node_crest_21.rotation.set(0, 0, 0);
    node_crest_21.scale.set(1, 1, 1);
  } else {
    node_crest_21.position.set(0.0, 2.54, 0.54);
    node_crest_21.rotation.set(0.0, 0.0, 0.0);
    node_crest_21.scale.set(1.0, 1.0, 1.0);
  }
  node_crest_21.userData.sculptComponent = {"id": "crest", "name": "Forehead crest assembly", "level": "meso", "role": "armor-shell", "importance": 0.82, "confidence": 0.76, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Forehead crest assembly is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "head", "attachment": {"parentId": "head", "parentSocket": "head-socket", "localStart": [0, 2.54, 0.54], "localEnd": [0, 2.852, 0.54], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.48, "height": 0.48, "depth": 0.12, "units": "relative", "confidence": 0.76}, "transform": {"position": [0, 2.54, 0.54], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "armor-shell", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "crest-socket", "localPosition": [0, 2.852, 0.54], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.144, 0], "scale": [0.36, 0.36, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "crest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crest-metal"}}, "material": "crest-metal", "materialLayers": ["crest-metal"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["head->crest"], "seams": ["head-crest-overlap"], "localFeatures": [{"id": "crest-shield-enamel", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 155, 97, 1)", "secondaryAlbedo": "rgba(107, 85, 48, 1)", "materialClass": "metal", "materialClassConfidence": 0.82, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(185, 155, 97, 1)"}, {"position": 1, "color": "rgba(107, 85, 48, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["crest-shield-enamel"], "fidelityTier": "structural"};
  node_crest_21.userData.actionProfile = {"animationRole": "armor-shell", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "crest-socket", "localPosition": [0, 2.852, 0.54], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.144, 0], "scale": [0.36, 0.36, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "crest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crest-metal"}};
  (nodes["head"] ?? root).add(node_crest_21);
  nodes["crest"] = node_crest_21;
  const mesh_crest_21Geometry = endpoint_crest_21
    ? new THREE.CylinderGeometry(endpoint_crest_21.endRadius, endpoint_crest_21.baseRadius, endpoint_crest_21.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  const mesh_crest_21 = new THREE.Mesh(
    mesh_crest_21Geometry,
    materialMap["crest-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_crest_21.name = "Forehead crest assembly";
  if (endpoint_crest_21) {
    mesh_crest_21.position.copy(endpoint_crest_21.midpoint);
    mesh_crest_21.quaternion.copy(endpoint_crest_21.quaternion);
  }
  mesh_crest_21.castShadow = options.castShadow ?? true;
  mesh_crest_21.receiveShadow = options.receiveShadow ?? true;
  mesh_crest_21.userData.sculptComponent = {"id": "crest", "name": "Forehead crest assembly", "level": "meso", "role": "armor-shell", "importance": 0.82, "confidence": 0.76, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Forehead crest assembly is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "assembled-solid with non-degenerate three-quarter volume", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "head", "attachment": {"parentId": "head", "parentSocket": "head-socket", "localStart": [0, 2.54, 0.54], "localEnd": [0, 2.852, 0.54], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.48, "height": 0.48, "depth": 0.12, "units": "relative", "confidence": 0.76}, "transform": {"position": [0, 2.54, 0.54], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "armor-shell", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "crest-socket", "localPosition": [0, 2.852, 0.54], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.144, 0], "scale": [0.36, 0.36, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "crest", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crest-metal"}}, "material": "crest-metal", "materialLayers": ["crest-metal"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["head->crest"], "seams": ["head-crest-overlap"], "localFeatures": [{"id": "crest-shield-enamel", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 155, 97, 1)", "secondaryAlbedo": "rgba(107, 85, 48, 1)", "materialClass": "metal", "materialClassConfidence": 0.82, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(185, 155, 97, 1)"}, {"position": 1, "color": "rgba(107, 85, 48, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["crest-shield-enamel"], "fidelityTier": "structural"};
  node_crest_21.add(mesh_crest_21);
  meshes["crest"] = mesh_crest_21;
  colliders["crest"] = {"type": "capsule", "offset": [0, 0.144, 0], "scale": [0.36, 0.36, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["crest"] ??= [];
  destructionGroups["crest"].push(node_crest_21);
  const socket_crest_crest_socket_0 = new THREE.Object3D();
  socket_crest_crest_socket_0.name = "crest-socket";
  socket_crest_crest_socket_0.position.set(0.0, 2.852, 0.54);
  socket_crest_crest_socket_0.rotation.set(0, 0, 0);
  socket_crest_crest_socket_0.userData.socket = {"id": "crest-socket", "localPosition": [0, 2.852, 0.54], "purpose": "attachment"};
  node_crest_21.add(socket_crest_crest_socket_0);
  sockets["crest:crest-socket"] = socket_crest_crest_socket_0;

  const attachment_eye_l_22 = {"parentId": "head", "parentSocket": "head-socket", "localStart": [-0.3, 2.05, 0.64], "localEnd": [-0.3, 2.284, 0.64], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_eye_l_22 = makeAttachmentEndpoint(attachment_eye_l_22);
  const node_eye_l_22 = new THREE.Group();
  node_eye_l_22.name = "Left glossy eye__pivot";
  if (endpoint_eye_l_22) {
    node_eye_l_22.position.copy(endpoint_eye_l_22.start);
    node_eye_l_22.rotation.set(0, 0, 0);
    node_eye_l_22.scale.set(1, 1, 1);
  } else {
    node_eye_l_22.position.set(-0.3, 2.05, 0.64);
    node_eye_l_22.rotation.set(0.0, 0.0, 0.0);
    node_eye_l_22.scale.set(1.0, 1.0, 1.0);
  }
  node_eye_l_22.userData.sculptComponent = {"id": "eye-l", "name": "Left glossy eye", "level": "micro", "role": "sensor", "importance": 0.62, "confidence": 0.76, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Left glossy eye is a smoothly varying volume with non-planar depth.", "geometryDescriptor": {"topologyIntent": "continuous-sculpt with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "head", "attachment": {"parentId": "head", "parentSocket": "head-socket", "localStart": [-0.3, 2.05, 0.64], "localEnd": [-0.3, 2.284, 0.64], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.3, "height": 0.36, "depth": 0.16, "units": "relative", "confidence": 0.76}, "transform": {"position": [-0.3, 2.05, 0.64], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "sensor", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "eye-l-socket", "localPosition": [-0.3, 2.284, 0.64], "purpose": "attachment"}], "collider": {"type": "sphere", "offset": [0, 0.108, 0], "scale": [0.22499999999999998, 0.27, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "eye-glass"}}, "material": "eye-glass", "materialLayers": ["eye-glass"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["head->eye-l"], "seams": ["head-eye-l-overlap"], "localFeatures": [{"id": "purple-iris-gradient", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(92, 86, 140, 1)", "secondaryAlbedo": "rgba(20, 24, 45, 1)", "materialClass": "glass", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(92, 86, 140, 1)"}, {"position": 1, "color": "rgba(20, 24, 45, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["purple-iris-gradient"], "fidelityTier": "structural"};
  node_eye_l_22.userData.actionProfile = {"animationRole": "sensor", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "eye-l-socket", "localPosition": [-0.3, 2.284, 0.64], "purpose": "attachment"}], "collider": {"type": "sphere", "offset": [0, 0.108, 0], "scale": [0.22499999999999998, 0.27, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "eye-glass"}};
  (nodes["head"] ?? root).add(node_eye_l_22);
  nodes["eye-l"] = node_eye_l_22;
  const mesh_eye_l_22Geometry = endpoint_eye_l_22
    ? new THREE.CylinderGeometry(endpoint_eye_l_22.endRadius, endpoint_eye_l_22.baseRadius, endpoint_eye_l_22.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_eye_l_22 = new THREE.Mesh(
    mesh_eye_l_22Geometry,
    materialMap["eye-glass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_l_22.name = "Left glossy eye";
  if (endpoint_eye_l_22) {
    mesh_eye_l_22.position.copy(endpoint_eye_l_22.midpoint);
    mesh_eye_l_22.quaternion.copy(endpoint_eye_l_22.quaternion);
  }
  mesh_eye_l_22.castShadow = options.castShadow ?? true;
  mesh_eye_l_22.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_l_22.userData.sculptComponent = {"id": "eye-l", "name": "Left glossy eye", "level": "micro", "role": "sensor", "importance": 0.62, "confidence": 0.76, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Left glossy eye is a smoothly varying volume with non-planar depth.", "geometryDescriptor": {"topologyIntent": "continuous-sculpt with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "head", "attachment": {"parentId": "head", "parentSocket": "head-socket", "localStart": [-0.3, 2.05, 0.64], "localEnd": [-0.3, 2.284, 0.64], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.3, "height": 0.36, "depth": 0.16, "units": "relative", "confidence": 0.76}, "transform": {"position": [-0.3, 2.05, 0.64], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "sensor", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "eye-l-socket", "localPosition": [-0.3, 2.284, 0.64], "purpose": "attachment"}], "collider": {"type": "sphere", "offset": [0, 0.108, 0], "scale": [0.22499999999999998, 0.27, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "eye-glass"}}, "material": "eye-glass", "materialLayers": ["eye-glass"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["head->eye-l"], "seams": ["head-eye-l-overlap"], "localFeatures": [{"id": "purple-iris-gradient", "type": "identity-detail", "placement": "reference-observed region", "scale": "meso-or-micro", "geometryEffect": "separate mesh or relief where silhouette-relevant", "materialEffect": "reference-derived local response", "confidence": 0.8, "evidenceRefs": ["full-object"]}], "colorMaterialRecipe": {"dominantAlbedo": "rgba(92, 86, 140, 1)", "secondaryAlbedo": "rgba(20, 24, 45, 1)", "materialClass": "glass", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(92, 86, 140, 1)"}, {"position": 1, "color": "rgba(20, 24, 45, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": ["purple-iris-gradient"], "fidelityTier": "structural"};
  node_eye_l_22.add(mesh_eye_l_22);
  meshes["eye-l"] = mesh_eye_l_22;
  colliders["eye-l"] = {"type": "sphere", "offset": [0, 0.108, 0], "scale": [0.22499999999999998, 0.27, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["eye-l"] ??= [];
  destructionGroups["eye-l"].push(node_eye_l_22);
  const socket_eye_l_eye_l_socket_0 = new THREE.Object3D();
  socket_eye_l_eye_l_socket_0.name = "eye-l-socket";
  socket_eye_l_eye_l_socket_0.position.set(-0.3, 2.284, 0.64);
  socket_eye_l_eye_l_socket_0.rotation.set(0, 0, 0);
  socket_eye_l_eye_l_socket_0.userData.socket = {"id": "eye-l-socket", "localPosition": [-0.3, 2.284, 0.64], "purpose": "attachment"};
  node_eye_l_22.add(socket_eye_l_eye_l_socket_0);
  sockets["eye-l:eye-l-socket"] = socket_eye_l_eye_l_socket_0;

  const attachment_eye_r_23 = {"parentId": "head", "parentSocket": "head-socket", "localStart": [0.3, 2.05, 0.64], "localEnd": [0.3, 2.284, 0.64], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_eye_r_23 = makeAttachmentEndpoint(attachment_eye_r_23);
  const node_eye_r_23 = new THREE.Group();
  node_eye_r_23.name = "Right glossy eye__pivot";
  if (endpoint_eye_r_23) {
    node_eye_r_23.position.copy(endpoint_eye_r_23.start);
    node_eye_r_23.rotation.set(0, 0, 0);
    node_eye_r_23.scale.set(1, 1, 1);
  } else {
    node_eye_r_23.position.set(0.3, 2.05, 0.64);
    node_eye_r_23.rotation.set(0.0, 0.0, 0.0);
    node_eye_r_23.scale.set(1.0, 1.0, 1.0);
  }
  node_eye_r_23.userData.sculptComponent = {"id": "eye-r", "name": "Right glossy eye", "level": "micro", "role": "sensor", "importance": 0.62, "confidence": 0.76, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Right glossy eye is a smoothly varying volume with non-planar depth.", "geometryDescriptor": {"topologyIntent": "continuous-sculpt with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "head", "attachment": {"parentId": "head", "parentSocket": "head-socket", "localStart": [0.3, 2.05, 0.64], "localEnd": [0.3, 2.284, 0.64], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.3, "height": 0.36, "depth": 0.16, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.3, 2.05, 0.64], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "sensor", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "eye-r-socket", "localPosition": [0.3, 2.284, 0.64], "purpose": "attachment"}], "collider": {"type": "sphere", "offset": [0, 0.108, 0], "scale": [0.22499999999999998, 0.27, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "eye-glass"}}, "material": "eye-glass", "materialLayers": ["eye-glass"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["head->eye-r"], "seams": ["head-eye-r-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(92, 86, 140, 1)", "secondaryAlbedo": "rgba(20, 24, 45, 1)", "materialClass": "glass", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(92, 86, 140, 1)"}, {"position": 1, "color": "rgba(20, 24, 45, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_eye_r_23.userData.actionProfile = {"animationRole": "sensor", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "eye-r-socket", "localPosition": [0.3, 2.284, 0.64], "purpose": "attachment"}], "collider": {"type": "sphere", "offset": [0, 0.108, 0], "scale": [0.22499999999999998, 0.27, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "eye-glass"}};
  (nodes["head"] ?? root).add(node_eye_r_23);
  nodes["eye-r"] = node_eye_r_23;
  const mesh_eye_r_23Geometry = endpoint_eye_r_23
    ? new THREE.CylinderGeometry(endpoint_eye_r_23.endRadius, endpoint_eye_r_23.baseRadius, endpoint_eye_r_23.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_eye_r_23 = new THREE.Mesh(
    mesh_eye_r_23Geometry,
    materialMap["eye-glass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eye_r_23.name = "Right glossy eye";
  if (endpoint_eye_r_23) {
    mesh_eye_r_23.position.copy(endpoint_eye_r_23.midpoint);
    mesh_eye_r_23.quaternion.copy(endpoint_eye_r_23.quaternion);
  }
  mesh_eye_r_23.castShadow = options.castShadow ?? true;
  mesh_eye_r_23.receiveShadow = options.receiveShadow ?? true;
  mesh_eye_r_23.userData.sculptComponent = {"id": "eye-r", "name": "Right glossy eye", "level": "micro", "role": "sensor", "importance": 0.62, "confidence": 0.76, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Right glossy eye is a smoothly varying volume with non-planar depth.", "geometryDescriptor": {"topologyIntent": "continuous-sculpt with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "head", "attachment": {"parentId": "head", "parentSocket": "head-socket", "localStart": [0.3, 2.05, 0.64], "localEnd": [0.3, 2.284, 0.64], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.3, "height": 0.36, "depth": 0.16, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.3, 2.05, 0.64], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "sensor", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "eye-r-socket", "localPosition": [0.3, 2.284, 0.64], "purpose": "attachment"}], "collider": {"type": "sphere", "offset": [0, 0.108, 0], "scale": [0.22499999999999998, 0.27, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "eye-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "eye-glass"}}, "material": "eye-glass", "materialLayers": ["eye-glass"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["head->eye-r"], "seams": ["head-eye-r-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(92, 86, 140, 1)", "secondaryAlbedo": "rgba(20, 24, 45, 1)", "materialClass": "glass", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(92, 86, 140, 1)"}, {"position": 1, "color": "rgba(20, 24, 45, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_eye_r_23.add(mesh_eye_r_23);
  meshes["eye-r"] = mesh_eye_r_23;
  colliders["eye-r"] = {"type": "sphere", "offset": [0, 0.108, 0], "scale": [0.22499999999999998, 0.27, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["eye-r"] ??= [];
  destructionGroups["eye-r"].push(node_eye_r_23);
  const socket_eye_r_eye_r_socket_0 = new THREE.Object3D();
  socket_eye_r_eye_r_socket_0.name = "eye-r-socket";
  socket_eye_r_eye_r_socket_0.position.set(0.3, 2.284, 0.64);
  socket_eye_r_eye_r_socket_0.rotation.set(0, 0, 0);
  socket_eye_r_eye_r_socket_0.userData.socket = {"id": "eye-r-socket", "localPosition": [0.3, 2.284, 0.64], "purpose": "attachment"};
  node_eye_r_23.add(socket_eye_r_eye_r_socket_0);
  sockets["eye-r:eye-r-socket"] = socket_eye_r_eye_r_socket_0;

  const attachment_catchlight_l_24 = {"parentId": "eye-l", "parentSocket": "eye-l-socket", "localStart": [-0.34, 2.16, 0.79], "localEnd": [-0.34, 2.24, 0.79], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_catchlight_l_24 = makeAttachmentEndpoint(attachment_catchlight_l_24);
  const node_catchlight_l_24 = new THREE.Group();
  node_catchlight_l_24.name = "Left eye catchlight__pivot";
  if (endpoint_catchlight_l_24) {
    node_catchlight_l_24.position.copy(endpoint_catchlight_l_24.start);
    node_catchlight_l_24.rotation.set(0, 0, 0);
    node_catchlight_l_24.scale.set(1, 1, 1);
  } else {
    node_catchlight_l_24.position.set(-0.34, 2.16, 0.79);
    node_catchlight_l_24.rotation.set(0.0, 0.0, 0.0);
    node_catchlight_l_24.scale.set(1.0, 1.0, 1.0);
  }
  node_catchlight_l_24.userData.sculptComponent = {"id": "catchlight-l", "name": "Left eye catchlight", "level": "micro", "role": "surface-detail", "importance": 0.62, "confidence": 0.76, "primitive": "sphere", "topologyClass": "surface-relief", "topologyRationale": "Left eye catchlight is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "surface-relief with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "eye-l", "attachment": {"parentId": "eye-l", "parentSocket": "eye-l-socket", "localStart": [-0.34, 2.16, 0.79], "localEnd": [-0.34, 2.24, 0.79], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.055, "height": 0.055, "depth": 0.025, "units": "relative", "confidence": 0.76}, "transform": {"position": [-0.34, 2.16, 0.79], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "surface-detail", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "catchlight-l-socket", "localPosition": [-0.34, 2.24, 0.79], "purpose": "attachment"}], "collider": {"type": "sphere", "offset": [0, 0.0165, 0], "scale": [0.12, 0.12, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "eye-glass"}}, "material": "eye-glass", "materialLayers": ["eye-glass"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["eye-l->catchlight-l"], "seams": ["eye-l-catchlight-l-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(92, 86, 140, 1)", "secondaryAlbedo": "rgba(20, 24, 45, 1)", "materialClass": "glass", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(92, 86, 140, 1)"}, {"position": 1, "color": "rgba(20, 24, 45, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_catchlight_l_24.userData.actionProfile = {"animationRole": "surface-detail", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "catchlight-l-socket", "localPosition": [-0.34, 2.24, 0.79], "purpose": "attachment"}], "collider": {"type": "sphere", "offset": [0, 0.0165, 0], "scale": [0.12, 0.12, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "eye-glass"}};
  (nodes["eye-l"] ?? root).add(node_catchlight_l_24);
  nodes["catchlight-l"] = node_catchlight_l_24;
  const mesh_catchlight_l_24Geometry = endpoint_catchlight_l_24
    ? new THREE.CylinderGeometry(endpoint_catchlight_l_24.endRadius, endpoint_catchlight_l_24.baseRadius, endpoint_catchlight_l_24.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_catchlight_l_24 = new THREE.Mesh(
    mesh_catchlight_l_24Geometry,
    materialMap["eye-glass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_catchlight_l_24.name = "Left eye catchlight";
  if (endpoint_catchlight_l_24) {
    mesh_catchlight_l_24.position.copy(endpoint_catchlight_l_24.midpoint);
    mesh_catchlight_l_24.quaternion.copy(endpoint_catchlight_l_24.quaternion);
  }
  mesh_catchlight_l_24.castShadow = options.castShadow ?? true;
  mesh_catchlight_l_24.receiveShadow = options.receiveShadow ?? true;
  mesh_catchlight_l_24.userData.sculptComponent = {"id": "catchlight-l", "name": "Left eye catchlight", "level": "micro", "role": "surface-detail", "importance": 0.62, "confidence": 0.76, "primitive": "sphere", "topologyClass": "surface-relief", "topologyRationale": "Left eye catchlight is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "surface-relief with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "eye-l", "attachment": {"parentId": "eye-l", "parentSocket": "eye-l-socket", "localStart": [-0.34, 2.16, 0.79], "localEnd": [-0.34, 2.24, 0.79], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.055, "height": 0.055, "depth": 0.025, "units": "relative", "confidence": 0.76}, "transform": {"position": [-0.34, 2.16, 0.79], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "surface-detail", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "catchlight-l-socket", "localPosition": [-0.34, 2.24, 0.79], "purpose": "attachment"}], "collider": {"type": "sphere", "offset": [0, 0.0165, 0], "scale": [0.12, 0.12, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "eye-glass"}}, "material": "eye-glass", "materialLayers": ["eye-glass"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["eye-l->catchlight-l"], "seams": ["eye-l-catchlight-l-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(92, 86, 140, 1)", "secondaryAlbedo": "rgba(20, 24, 45, 1)", "materialClass": "glass", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(92, 86, 140, 1)"}, {"position": 1, "color": "rgba(20, 24, 45, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_catchlight_l_24.add(mesh_catchlight_l_24);
  meshes["catchlight-l"] = mesh_catchlight_l_24;
  colliders["catchlight-l"] = {"type": "sphere", "offset": [0, 0.0165, 0], "scale": [0.12, 0.12, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["catchlight-l"] ??= [];
  destructionGroups["catchlight-l"].push(node_catchlight_l_24);
  const socket_catchlight_l_catchlight_l_socket_0 = new THREE.Object3D();
  socket_catchlight_l_catchlight_l_socket_0.name = "catchlight-l-socket";
  socket_catchlight_l_catchlight_l_socket_0.position.set(-0.34, 2.24, 0.79);
  socket_catchlight_l_catchlight_l_socket_0.rotation.set(0, 0, 0);
  socket_catchlight_l_catchlight_l_socket_0.userData.socket = {"id": "catchlight-l-socket", "localPosition": [-0.34, 2.24, 0.79], "purpose": "attachment"};
  node_catchlight_l_24.add(socket_catchlight_l_catchlight_l_socket_0);
  sockets["catchlight-l:catchlight-l-socket"] = socket_catchlight_l_catchlight_l_socket_0;

  const attachment_catchlight_r_25 = {"parentId": "eye-r", "parentSocket": "eye-r-socket", "localStart": [0.26, 2.16, 0.79], "localEnd": [0.26, 2.24, 0.79], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_catchlight_r_25 = makeAttachmentEndpoint(attachment_catchlight_r_25);
  const node_catchlight_r_25 = new THREE.Group();
  node_catchlight_r_25.name = "Right eye catchlight__pivot";
  if (endpoint_catchlight_r_25) {
    node_catchlight_r_25.position.copy(endpoint_catchlight_r_25.start);
    node_catchlight_r_25.rotation.set(0, 0, 0);
    node_catchlight_r_25.scale.set(1, 1, 1);
  } else {
    node_catchlight_r_25.position.set(0.26, 2.16, 0.79);
    node_catchlight_r_25.rotation.set(0.0, 0.0, 0.0);
    node_catchlight_r_25.scale.set(1.0, 1.0, 1.0);
  }
  node_catchlight_r_25.userData.sculptComponent = {"id": "catchlight-r", "name": "Right eye catchlight", "level": "micro", "role": "surface-detail", "importance": 0.62, "confidence": 0.76, "primitive": "sphere", "topologyClass": "surface-relief", "topologyRationale": "Right eye catchlight is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "surface-relief with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "eye-r", "attachment": {"parentId": "eye-r", "parentSocket": "eye-r-socket", "localStart": [0.26, 2.16, 0.79], "localEnd": [0.26, 2.24, 0.79], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.055, "height": 0.055, "depth": 0.025, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.26, 2.16, 0.79], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "surface-detail", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "catchlight-r-socket", "localPosition": [0.26, 2.24, 0.79], "purpose": "attachment"}], "collider": {"type": "sphere", "offset": [0, 0.0165, 0], "scale": [0.12, 0.12, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "eye-glass"}}, "material": "eye-glass", "materialLayers": ["eye-glass"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["eye-r->catchlight-r"], "seams": ["eye-r-catchlight-r-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(92, 86, 140, 1)", "secondaryAlbedo": "rgba(20, 24, 45, 1)", "materialClass": "glass", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(92, 86, 140, 1)"}, {"position": 1, "color": "rgba(20, 24, 45, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_catchlight_r_25.userData.actionProfile = {"animationRole": "surface-detail", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "catchlight-r-socket", "localPosition": [0.26, 2.24, 0.79], "purpose": "attachment"}], "collider": {"type": "sphere", "offset": [0, 0.0165, 0], "scale": [0.12, 0.12, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "eye-glass"}};
  (nodes["eye-r"] ?? root).add(node_catchlight_r_25);
  nodes["catchlight-r"] = node_catchlight_r_25;
  const mesh_catchlight_r_25Geometry = endpoint_catchlight_r_25
    ? new THREE.CylinderGeometry(endpoint_catchlight_r_25.endRadius, endpoint_catchlight_r_25.baseRadius, endpoint_catchlight_r_25.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_catchlight_r_25 = new THREE.Mesh(
    mesh_catchlight_r_25Geometry,
    materialMap["eye-glass"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_catchlight_r_25.name = "Right eye catchlight";
  if (endpoint_catchlight_r_25) {
    mesh_catchlight_r_25.position.copy(endpoint_catchlight_r_25.midpoint);
    mesh_catchlight_r_25.quaternion.copy(endpoint_catchlight_r_25.quaternion);
  }
  mesh_catchlight_r_25.castShadow = options.castShadow ?? true;
  mesh_catchlight_r_25.receiveShadow = options.receiveShadow ?? true;
  mesh_catchlight_r_25.userData.sculptComponent = {"id": "catchlight-r", "name": "Right eye catchlight", "level": "micro", "role": "surface-detail", "importance": 0.62, "confidence": 0.76, "primitive": "sphere", "topologyClass": "surface-relief", "topologyRationale": "Right eye catchlight is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "surface-relief with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "eye-r", "attachment": {"parentId": "eye-r", "parentSocket": "eye-r-socket", "localStart": [0.26, 2.16, 0.79], "localEnd": [0.26, 2.24, 0.79], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.055, "height": 0.055, "depth": 0.025, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.26, 2.16, 0.79], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "surface-detail", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "catchlight-r-socket", "localPosition": [0.26, 2.24, 0.79], "purpose": "attachment"}], "collider": {"type": "sphere", "offset": [0, 0.0165, 0], "scale": [0.12, 0.12, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "catchlight-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "eye-glass"}}, "material": "eye-glass", "materialLayers": ["eye-glass"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["eye-r->catchlight-r"], "seams": ["eye-r-catchlight-r-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(92, 86, 140, 1)", "secondaryAlbedo": "rgba(20, 24, 45, 1)", "materialClass": "glass", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(92, 86, 140, 1)"}, {"position": 1, "color": "rgba(20, 24, 45, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_catchlight_r_25.add(mesh_catchlight_r_25);
  meshes["catchlight-r"] = mesh_catchlight_r_25;
  colliders["catchlight-r"] = {"type": "sphere", "offset": [0, 0.0165, 0], "scale": [0.12, 0.12, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["catchlight-r"] ??= [];
  destructionGroups["catchlight-r"].push(node_catchlight_r_25);
  const socket_catchlight_r_catchlight_r_socket_0 = new THREE.Object3D();
  socket_catchlight_r_catchlight_r_socket_0.name = "catchlight-r-socket";
  socket_catchlight_r_catchlight_r_socket_0.position.set(0.26, 2.24, 0.79);
  socket_catchlight_r_catchlight_r_socket_0.rotation.set(0, 0, 0);
  socket_catchlight_r_catchlight_r_socket_0.userData.socket = {"id": "catchlight-r-socket", "localPosition": [0.26, 2.24, 0.79], "purpose": "attachment"};
  node_catchlight_r_25.add(socket_catchlight_r_catchlight_r_socket_0);
  sockets["catchlight-r:catchlight-r-socket"] = socket_catchlight_r_catchlight_r_socket_0;

  const attachment_bracer_l_26 = {"parentId": "forearm-l", "parentSocket": "forearm-l-socket", "localStart": [-0.62, 1.04, 0.05], "localEnd": [-0.62, 1.209, 0.05], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_bracer_l_26 = makeAttachmentEndpoint(attachment_bracer_l_26);
  const node_bracer_l_26 = new THREE.Group();
  node_bracer_l_26.name = "Left gold lattice bracer__pivot";
  if (endpoint_bracer_l_26) {
    node_bracer_l_26.position.copy(endpoint_bracer_l_26.start);
    node_bracer_l_26.rotation.set(0, 0, 0);
    node_bracer_l_26.scale.set(1, 1, 1);
  } else {
    node_bracer_l_26.position.set(-0.62, 1.04, 0.05);
    node_bracer_l_26.rotation.set(0.0, 0.0, 0.0);
    node_bracer_l_26.scale.set(1.0, 1.0, 1.0);
  }
  node_bracer_l_26.userData.sculptComponent = {"id": "bracer-l", "name": "Left gold lattice bracer", "level": "micro", "role": "surface-detail", "importance": 0.62, "confidence": 0.76, "primitive": "cylinder", "topologyClass": "surface-relief", "topologyRationale": "Left gold lattice bracer is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "surface-relief with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "forearm-l", "attachment": {"parentId": "forearm-l", "parentSocket": "forearm-l-socket", "localStart": [-0.62, 1.04, 0.05], "localEnd": [-0.62, 1.209, 0.05], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.23, "height": 0.26, "depth": 0.23, "units": "relative", "confidence": 0.76}, "transform": {"position": [-0.62, 1.04, 0.05], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "surface-detail", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "bracer-l-socket", "localPosition": [-0.62, 1.209, 0.05], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.078, 0], "scale": [0.17250000000000001, 0.195, 0.17250000000000001], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "bracer-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crest-metal"}}, "material": "crest-metal", "materialLayers": ["crest-metal"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["forearm-l->bracer-l"], "seams": ["forearm-l-bracer-l-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 155, 97, 1)", "secondaryAlbedo": "rgba(107, 85, 48, 1)", "materialClass": "metal", "materialClassConfidence": 0.82, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(185, 155, 97, 1)"}, {"position": 1, "color": "rgba(107, 85, 48, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_bracer_l_26.userData.actionProfile = {"animationRole": "surface-detail", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "bracer-l-socket", "localPosition": [-0.62, 1.209, 0.05], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.078, 0], "scale": [0.17250000000000001, 0.195, 0.17250000000000001], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "bracer-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crest-metal"}};
  (nodes["forearm-l"] ?? root).add(node_bracer_l_26);
  nodes["bracer-l"] = node_bracer_l_26;
  const mesh_bracer_l_26Geometry = endpoint_bracer_l_26
    ? new THREE.CylinderGeometry(endpoint_bracer_l_26.endRadius, endpoint_bracer_l_26.baseRadius, endpoint_bracer_l_26.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  const mesh_bracer_l_26 = new THREE.Mesh(
    mesh_bracer_l_26Geometry,
    materialMap["crest-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_bracer_l_26.name = "Left gold lattice bracer";
  if (endpoint_bracer_l_26) {
    mesh_bracer_l_26.position.copy(endpoint_bracer_l_26.midpoint);
    mesh_bracer_l_26.quaternion.copy(endpoint_bracer_l_26.quaternion);
  }
  mesh_bracer_l_26.castShadow = options.castShadow ?? true;
  mesh_bracer_l_26.receiveShadow = options.receiveShadow ?? true;
  mesh_bracer_l_26.userData.sculptComponent = {"id": "bracer-l", "name": "Left gold lattice bracer", "level": "micro", "role": "surface-detail", "importance": 0.62, "confidence": 0.76, "primitive": "cylinder", "topologyClass": "surface-relief", "topologyRationale": "Left gold lattice bracer is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "surface-relief with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "forearm-l", "attachment": {"parentId": "forearm-l", "parentSocket": "forearm-l-socket", "localStart": [-0.62, 1.04, 0.05], "localEnd": [-0.62, 1.209, 0.05], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.23, "height": 0.26, "depth": 0.23, "units": "relative", "confidence": 0.76}, "transform": {"position": [-0.62, 1.04, 0.05], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "surface-detail", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "bracer-l-socket", "localPosition": [-0.62, 1.209, 0.05], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.078, 0], "scale": [0.17250000000000001, 0.195, 0.17250000000000001], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "bracer-l", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crest-metal"}}, "material": "crest-metal", "materialLayers": ["crest-metal"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["forearm-l->bracer-l"], "seams": ["forearm-l-bracer-l-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 155, 97, 1)", "secondaryAlbedo": "rgba(107, 85, 48, 1)", "materialClass": "metal", "materialClassConfidence": 0.82, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(185, 155, 97, 1)"}, {"position": 1, "color": "rgba(107, 85, 48, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_bracer_l_26.add(mesh_bracer_l_26);
  meshes["bracer-l"] = mesh_bracer_l_26;
  colliders["bracer-l"] = {"type": "capsule", "offset": [0, 0.078, 0], "scale": [0.17250000000000001, 0.195, 0.17250000000000001], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["bracer-l"] ??= [];
  destructionGroups["bracer-l"].push(node_bracer_l_26);
  const socket_bracer_l_bracer_l_socket_0 = new THREE.Object3D();
  socket_bracer_l_bracer_l_socket_0.name = "bracer-l-socket";
  socket_bracer_l_bracer_l_socket_0.position.set(-0.62, 1.209, 0.05);
  socket_bracer_l_bracer_l_socket_0.rotation.set(0, 0, 0);
  socket_bracer_l_bracer_l_socket_0.userData.socket = {"id": "bracer-l-socket", "localPosition": [-0.62, 1.209, 0.05], "purpose": "attachment"};
  node_bracer_l_26.add(socket_bracer_l_bracer_l_socket_0);
  sockets["bracer-l:bracer-l-socket"] = socket_bracer_l_bracer_l_socket_0;

  const attachment_bracer_r_27 = {"parentId": "forearm-r", "parentSocket": "forearm-r-socket", "localStart": [0.62, 1.04, 0.05], "localEnd": [0.62, 1.209, 0.05], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_bracer_r_27 = makeAttachmentEndpoint(attachment_bracer_r_27);
  const node_bracer_r_27 = new THREE.Group();
  node_bracer_r_27.name = "Right gold lattice bracer__pivot";
  if (endpoint_bracer_r_27) {
    node_bracer_r_27.position.copy(endpoint_bracer_r_27.start);
    node_bracer_r_27.rotation.set(0, 0, 0);
    node_bracer_r_27.scale.set(1, 1, 1);
  } else {
    node_bracer_r_27.position.set(0.62, 1.04, 0.05);
    node_bracer_r_27.rotation.set(0.0, 0.0, 0.0);
    node_bracer_r_27.scale.set(1.0, 1.0, 1.0);
  }
  node_bracer_r_27.userData.sculptComponent = {"id": "bracer-r", "name": "Right gold lattice bracer", "level": "micro", "role": "surface-detail", "importance": 0.62, "confidence": 0.76, "primitive": "cylinder", "topologyClass": "surface-relief", "topologyRationale": "Right gold lattice bracer is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "surface-relief with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "forearm-r", "attachment": {"parentId": "forearm-r", "parentSocket": "forearm-r-socket", "localStart": [0.62, 1.04, 0.05], "localEnd": [0.62, 1.209, 0.05], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.23, "height": 0.26, "depth": 0.23, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.62, 1.04, 0.05], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "surface-detail", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "bracer-r-socket", "localPosition": [0.62, 1.209, 0.05], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.078, 0], "scale": [0.17250000000000001, 0.195, 0.17250000000000001], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "bracer-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crest-metal"}}, "material": "crest-metal", "materialLayers": ["crest-metal"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["forearm-r->bracer-r"], "seams": ["forearm-r-bracer-r-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 155, 97, 1)", "secondaryAlbedo": "rgba(107, 85, 48, 1)", "materialClass": "metal", "materialClassConfidence": 0.82, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(185, 155, 97, 1)"}, {"position": 1, "color": "rgba(107, 85, 48, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_bracer_r_27.userData.actionProfile = {"animationRole": "surface-detail", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "bracer-r-socket", "localPosition": [0.62, 1.209, 0.05], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.078, 0], "scale": [0.17250000000000001, 0.195, 0.17250000000000001], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "bracer-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crest-metal"}};
  (nodes["forearm-r"] ?? root).add(node_bracer_r_27);
  nodes["bracer-r"] = node_bracer_r_27;
  const mesh_bracer_r_27Geometry = endpoint_bracer_r_27
    ? new THREE.CylinderGeometry(endpoint_bracer_r_27.endRadius, endpoint_bracer_r_27.baseRadius, endpoint_bracer_r_27.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  const mesh_bracer_r_27 = new THREE.Mesh(
    mesh_bracer_r_27Geometry,
    materialMap["crest-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_bracer_r_27.name = "Right gold lattice bracer";
  if (endpoint_bracer_r_27) {
    mesh_bracer_r_27.position.copy(endpoint_bracer_r_27.midpoint);
    mesh_bracer_r_27.quaternion.copy(endpoint_bracer_r_27.quaternion);
  }
  mesh_bracer_r_27.castShadow = options.castShadow ?? true;
  mesh_bracer_r_27.receiveShadow = options.receiveShadow ?? true;
  mesh_bracer_r_27.userData.sculptComponent = {"id": "bracer-r", "name": "Right gold lattice bracer", "level": "micro", "role": "surface-detail", "importance": 0.62, "confidence": 0.76, "primitive": "cylinder", "topologyClass": "surface-relief", "topologyRationale": "Right gold lattice bracer is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "surface-relief with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "forearm-r", "attachment": {"parentId": "forearm-r", "parentSocket": "forearm-r-socket", "localStart": [0.62, 1.04, 0.05], "localEnd": [0.62, 1.209, 0.05], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.23, "height": 0.26, "depth": 0.23, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.62, 1.04, 0.05], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "surface-detail", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "bracer-r-socket", "localPosition": [0.62, 1.209, 0.05], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.078, 0], "scale": [0.17250000000000001, 0.195, 0.17250000000000001], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "bracer-r", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crest-metal"}}, "material": "crest-metal", "materialLayers": ["crest-metal"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["forearm-r->bracer-r"], "seams": ["forearm-r-bracer-r-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 155, 97, 1)", "secondaryAlbedo": "rgba(107, 85, 48, 1)", "materialClass": "metal", "materialClassConfidence": 0.82, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(185, 155, 97, 1)"}, {"position": 1, "color": "rgba(107, 85, 48, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_bracer_r_27.add(mesh_bracer_r_27);
  meshes["bracer-r"] = mesh_bracer_r_27;
  colliders["bracer-r"] = {"type": "capsule", "offset": [0, 0.078, 0], "scale": [0.17250000000000001, 0.195, 0.17250000000000001], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["bracer-r"] ??= [];
  destructionGroups["bracer-r"].push(node_bracer_r_27);
  const socket_bracer_r_bracer_r_socket_0 = new THREE.Object3D();
  socket_bracer_r_bracer_r_socket_0.name = "bracer-r-socket";
  socket_bracer_r_bracer_r_socket_0.position.set(0.62, 1.209, 0.05);
  socket_bracer_r_bracer_r_socket_0.rotation.set(0, 0, 0);
  socket_bracer_r_bracer_r_socket_0.userData.socket = {"id": "bracer-r-socket", "localPosition": [0.62, 1.209, 0.05], "purpose": "attachment"};
  node_bracer_r_27.add(socket_bracer_r_bracer_r_socket_0);
  sockets["bracer-r:bracer-r-socket"] = socket_bracer_r_bracer_r_socket_0;

  const attachment_gold_chain_28 = {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0.16, 1.4, 0.41], "localEnd": [0.16, 1.5819999999999999, 0.41], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_gold_chain_28 = makeAttachmentEndpoint(attachment_gold_chain_28);
  const node_gold_chain_28 = new THREE.Group();
  node_gold_chain_28.name = "Gold chain drape__pivot";
  if (endpoint_gold_chain_28) {
    node_gold_chain_28.position.copy(endpoint_gold_chain_28.start);
    node_gold_chain_28.rotation.set(0, 0, 0);
    node_gold_chain_28.scale.set(1, 1, 1);
  } else {
    node_gold_chain_28.position.set(0.16, 1.4, 0.41);
    node_gold_chain_28.rotation.set(0.0, 0.0, 0.0);
    node_gold_chain_28.scale.set(1.0, 1.0, 1.0);
  }
  node_gold_chain_28.userData.sculptComponent = {"id": "gold-chain", "name": "Gold chain drape", "level": "micro", "role": "cable", "importance": 0.62, "confidence": 0.76, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Gold chain drape follows a rooted curved path.", "geometryDescriptor": {"topologyIntent": "fiber-strand with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "torso", "attachment": {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0.16, 1.4, 0.41], "localEnd": [0.16, 1.5819999999999999, 0.41], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.42, "height": 0.28, "depth": 0.04, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.16, 1.4, 0.41], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "cable", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "gold-chain-socket", "localPosition": [0.16, 1.5819999999999999, 0.41], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.084, 0], "scale": [0.315, 0.21000000000000002, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "gold-chain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crest-metal"}}, "material": "crest-metal", "materialLayers": ["crest-metal"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["torso->gold-chain"], "seams": ["torso-gold-chain-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 155, 97, 1)", "secondaryAlbedo": "rgba(107, 85, 48, 1)", "materialClass": "metal", "materialClassConfidence": 0.82, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(185, 155, 97, 1)"}, {"position": 1, "color": "rgba(107, 85, 48, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_gold_chain_28.userData.actionProfile = {"animationRole": "cable", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "gold-chain-socket", "localPosition": [0.16, 1.5819999999999999, 0.41], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.084, 0], "scale": [0.315, 0.21000000000000002, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "gold-chain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crest-metal"}};
  (nodes["torso"] ?? root).add(node_gold_chain_28);
  nodes["gold-chain"] = node_gold_chain_28;
  const mesh_gold_chain_28Geometry = endpoint_gold_chain_28
    ? new THREE.CylinderGeometry(endpoint_gold_chain_28.endRadius, endpoint_gold_chain_28.baseRadius, endpoint_gold_chain_28.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  const mesh_gold_chain_28 = new THREE.Mesh(
    mesh_gold_chain_28Geometry,
    materialMap["crest-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_gold_chain_28.name = "Gold chain drape";
  if (endpoint_gold_chain_28) {
    mesh_gold_chain_28.position.copy(endpoint_gold_chain_28.midpoint);
    mesh_gold_chain_28.quaternion.copy(endpoint_gold_chain_28.quaternion);
  }
  mesh_gold_chain_28.castShadow = options.castShadow ?? true;
  mesh_gold_chain_28.receiveShadow = options.receiveShadow ?? true;
  mesh_gold_chain_28.userData.sculptComponent = {"id": "gold-chain", "name": "Gold chain drape", "level": "micro", "role": "cable", "importance": 0.62, "confidence": 0.76, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Gold chain drape follows a rooted curved path.", "geometryDescriptor": {"topologyIntent": "fiber-strand with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "torso", "attachment": {"parentId": "torso", "parentSocket": "torso-socket", "localStart": [0.16, 1.4, 0.41], "localEnd": [0.16, 1.5819999999999999, 0.41], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.42, "height": 0.28, "depth": 0.04, "units": "relative", "confidence": 0.76}, "transform": {"position": [0.16, 1.4, 0.41], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "cable", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "gold-chain-socket", "localPosition": [0.16, 1.5819999999999999, 0.41], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.084, 0], "scale": [0.315, 0.21000000000000002, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "gold-chain", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crest-metal"}}, "material": "crest-metal", "materialLayers": ["crest-metal"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["torso->gold-chain"], "seams": ["torso-gold-chain-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 155, 97, 1)", "secondaryAlbedo": "rgba(107, 85, 48, 1)", "materialClass": "metal", "materialClassConfidence": 0.82, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(185, 155, 97, 1)"}, {"position": 1, "color": "rgba(107, 85, 48, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_gold_chain_28.add(mesh_gold_chain_28);
  meshes["gold-chain"] = mesh_gold_chain_28;
  colliders["gold-chain"] = {"type": "capsule", "offset": [0, 0.084, 0], "scale": [0.315, 0.21000000000000002, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["gold-chain"] ??= [];
  destructionGroups["gold-chain"].push(node_gold_chain_28);
  const socket_gold_chain_gold_chain_socket_0 = new THREE.Object3D();
  socket_gold_chain_gold_chain_socket_0.name = "gold-chain-socket";
  socket_gold_chain_gold_chain_socket_0.position.set(0.16, 1.5819999999999999, 0.41);
  socket_gold_chain_gold_chain_socket_0.rotation.set(0, 0, 0);
  socket_gold_chain_gold_chain_socket_0.userData.socket = {"id": "gold-chain-socket", "localPosition": [0.16, 1.5819999999999999, 0.41], "purpose": "attachment"};
  node_gold_chain_28.add(socket_gold_chain_gold_chain_socket_0);
  sockets["gold-chain:gold-chain-socket"] = socket_gold_chain_gold_chain_socket_0;

  const attachment_cape_border_29 = {"parentId": "cape", "parentSocket": "cape-socket", "localStart": [0, 0.94, -0.34], "localEnd": [0, 1.7069999999999999, -0.34], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]};
  const endpoint_cape_border_29 = makeAttachmentEndpoint(attachment_cape_border_29);
  const node_cape_border_29 = new THREE.Group();
  node_cape_border_29.name = "Cape gold border__pivot";
  if (endpoint_cape_border_29) {
    node_cape_border_29.position.copy(endpoint_cape_border_29.start);
    node_cape_border_29.rotation.set(0, 0, 0);
    node_cape_border_29.scale.set(1, 1, 1);
  } else {
    node_cape_border_29.position.set(0.0, 0.94, -0.34);
    node_cape_border_29.rotation.set(0.0, 0.0, 0.0);
    node_cape_border_29.scale.set(1.0, 1.0, 1.0);
  }
  node_cape_border_29.userData.sculptComponent = {"id": "cape-border", "name": "Cape gold border", "level": "micro", "role": "surface-detail", "importance": 0.62, "confidence": 0.76, "primitive": "extrude", "topologyClass": "surface-relief", "topologyRationale": "Cape gold border is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "surface-relief with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "cape", "attachment": {"parentId": "cape", "parentSocket": "cape-socket", "localStart": [0, 0.94, -0.34], "localEnd": [0, 1.7069999999999999, -0.34], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.5, "height": 1.18, "depth": 0.04, "units": "relative", "confidence": 0.76}, "transform": {"position": [0, 0.94, -0.34], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "surface-detail", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "cape-border-socket", "localPosition": [0, 1.7069999999999999, -0.34], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.354, 0], "scale": [1.125, 0.885, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cape-border", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crest-metal"}}, "material": "crest-metal", "materialLayers": ["crest-metal"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["cape->cape-border"], "seams": ["cape-cape-border-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 155, 97, 1)", "secondaryAlbedo": "rgba(107, 85, 48, 1)", "materialClass": "metal", "materialClassConfidence": 0.82, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(185, 155, 97, 1)"}, {"position": 1, "color": "rgba(107, 85, 48, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_cape_border_29.userData.actionProfile = {"animationRole": "surface-detail", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "cape-border-socket", "localPosition": [0, 1.7069999999999999, -0.34], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.354, 0], "scale": [1.125, 0.885, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cape-border", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crest-metal"}};
  (nodes["cape"] ?? root).add(node_cape_border_29);
  nodes["cape-border"] = node_cape_border_29;
  const mesh_cape_border_29Geometry = endpoint_cape_border_29
    ? new THREE.CylinderGeometry(endpoint_cape_border_29.endRadius, endpoint_cape_border_29.baseRadius, endpoint_cape_border_29.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  const mesh_cape_border_29 = new THREE.Mesh(
    mesh_cape_border_29Geometry,
    materialMap["crest-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cape_border_29.name = "Cape gold border";
  if (endpoint_cape_border_29) {
    mesh_cape_border_29.position.copy(endpoint_cape_border_29.midpoint);
    mesh_cape_border_29.quaternion.copy(endpoint_cape_border_29.quaternion);
  }
  mesh_cape_border_29.castShadow = options.castShadow ?? true;
  mesh_cape_border_29.receiveShadow = options.receiveShadow ?? true;
  mesh_cape_border_29.userData.sculptComponent = {"id": "cape-border", "name": "Cape gold border", "level": "micro", "role": "surface-detail", "importance": 0.62, "confidence": 0.76, "primitive": "extrude", "topologyClass": "surface-relief", "topologyRationale": "Cape gold border is a discrete runtime-addressable assembly.", "geometryDescriptor": {"topologyIntent": "surface-relief with non-degenerate three-quarter volume", "edgeTreatment": {"type": "soft", "bevelRadius": 0.025, "segments": 3}, "deformationStack": ["skeletal-joint deformation"], "uvStrategy": "generated UV", "normalStrategy": "smooth vertex normals with independent normal map"}, "parent": "cape", "attachment": {"parentId": "cape", "parentSocket": "cape-socket", "localStart": [0, 0.94, -0.34], "localEnd": [0, 1.7069999999999999, -0.34], "baseRadius": 0.12, "endRadius": 0.09, "embedDepth": 0.035, "overlap": 0.04, "contactType": "socket", "gapTolerance": 0.012, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.5, "height": 1.18, "depth": 0.04, "units": "relative", "confidence": 0.76}, "transform": {"position": [0, 0.94, -0.34], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "surface-detail", "pivot": {"mode": "joint-root", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.82}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [{"id": "cape-border-socket", "localPosition": [0, 1.7069999999999999, -0.34], "purpose": "attachment"}], "collider": {"type": "capsule", "offset": [0, 0.354, 0], "scale": [1.125, 0.885, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "cape-border", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crest-metal"}}, "material": "crest-metal", "materialLayers": ["crest-metal"], "deformations": ["idle-breathe", "locomotion", "cast-recoil", "hit-reaction"], "joints": ["cape->cape-border"], "seams": ["cape-cape-border-overlap"], "localFeatures": [], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 155, 97, 1)", "secondaryAlbedo": "rgba(107, 85, 48, 1)", "materialClass": "metal", "materialClassConfidence": 0.82, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(185, 155, 97, 1)"}, {"position": 1, "color": "rgba(107, 85, 48, 1)"}]}, "evidenceRefs": ["full-object"]}, "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.06, "bumpAmplitude": 0.02, "normalPattern": "independent reference-derived normal", "displacementPattern": "none", "occlusionPattern": "cavity-biased AO", "edgeWearPattern": "restrained contact wear", "notes": "No PBR channel aliases albedo."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural"};
  node_cape_border_29.add(mesh_cape_border_29);
  meshes["cape-border"] = mesh_cape_border_29;
  colliders["cape-border"] = {"type": "capsule", "offset": [0, 0.354, 0], "scale": [1.125, 0.885, 0.12], "isTrigger": false, "notes": "Physics proxy is separate from visual mesh."};
  destructionGroups["cape-border"] ??= [];
  destructionGroups["cape-border"].push(node_cape_border_29);
  const socket_cape_border_cape_border_socket_0 = new THREE.Object3D();
  socket_cape_border_cape_border_socket_0.name = "cape-border-socket";
  socket_cape_border_cape_border_socket_0.position.set(0.0, 1.7069999999999999, -0.34);
  socket_cape_border_cape_border_socket_0.rotation.set(0, 0, 0);
  socket_cape_border_cape_border_socket_0.userData.socket = {"id": "cape-border-socket", "localPosition": [0, 1.7069999999999999, -0.34], "purpose": "attachment"};
  node_cape_border_29.add(socket_cape_border_cape_border_socket_0);
  sockets["cape-border:cape-border-socket"] = socket_cape_border_cape_border_socket_0;

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createNyxaluneZukanFighterRigFamilyLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Nyxalune Zukan fighter rig family look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"id": "key-light", "type": "directional key light", "colorTemperatureK": 5200, "intensity": 3.2, "direction": [-3, 7, 5], "shadow": "soft PCF contact shadow"}, {"id": "fill-light", "type": "hemisphere fill light", "colorTemperatureK": 6800, "intensity": 0.85, "direction": [2, 4, -2], "note": "cool sky fill preserves indigo separation"}, {"id": "rim-environment", "type": "PMREM environment and warm rim light", "intensity": 1.2, "direction": [4, 3, -5], "note": "ACES Filmic tone mapping, exposure 1.05, pale porcelain background, dynamic contact shadow and AO"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createNyxaluneZukanFighterRigFamilyEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameNyxaluneZukanFighterRigFamilyCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createNyxaluneZukanFighterRigFamilyPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureNyxaluneZukanFighterRigFamilyRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createNyxaluneZukanFighterRigFamilyInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
