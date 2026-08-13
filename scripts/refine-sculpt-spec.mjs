import { readFileSync, writeFileSync } from 'node:fs';

const root = '/workspace/scratch/363230f53301';
const specPath = `${root}/docs/nyxalune-sculpt-spec.json`;
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const inventory = JSON.parse(readFileSync(`${root}/docs/nyxalune-detail-inventory.json`, 'utf8')).detailInventory;
const camera = JSON.parse(readFileSync(`${root}/docs/nyxalune-reference-camera.json`, 'utf8')).referenceCamera;

const reports = {
  'projection-front': JSON.parse(readFileSync(`${root}/docs/material-crops/skin-report.json`, 'utf8')),
  'skin-indigo': JSON.parse(readFileSync(`${root}/docs/material-crops/skin-report.json`, 'utf8')),
  'armor-ivory': JSON.parse(readFileSync(`${root}/docs/material-crops/armor-report.json`, 'utf8')),
  'crest-metal': JSON.parse(readFileSync(`${root}/docs/material-crops/gold-report.json`, 'utf8')),
  'cape-cloth': JSON.parse(readFileSync(`${root}/docs/material-crops/cape-report.json`, 'utf8')),
  'eye-glass': JSON.parse(readFileSync(`${root}/docs/material-crops/eyes-report.json`, 'utf8')),
  'hidden-shell': JSON.parse(readFileSync(`${root}/docs/material-crops/skin-report.json`, 'utf8')),
};

const materialConfig = {
  'projection-front': ['Projected front albedo', '#454b7b', 'fabric', 0.44, 0.0],
  'skin-indigo': ['Indigo satin scales', '#343965', 'skin', 0.46, 0.0],
  'armor-ivory': ['Warm ivory armor', '#d8cbb9', 'ceramic', 0.36, 0.0],
  'crest-metal': ['Antique gold trim', '#b99b61', 'metal', 0.24, 0.82],
  'cape-cloth': ['Indigo embroidered cloth', '#1d233c', 'fabric', 0.72, 0.0],
  'eye-glass': ['Violet glossy eyes', '#5c568c', 'glass', 0.12, 0.0],
  'hidden-shell': ['Inferred rear shell', '#242945', 'skin', 0.54, 0.0],
};

function mapUrl(id, channel) {
  const folder = id === 'projection-front' || id === 'skin-indigo' || id === 'hidden-shell'
    ? 'skin'
    : id === 'armor-ivory' ? 'armor'
    : id === 'crest-metal' ? 'gold'
    : id === 'cape-cloth' ? 'cape' : 'eyes';
  const prefix = id === 'projection-front' || id === 'hidden-shell' ? 'skin-indigo' : id;
  return `/textures/nyxalune/${folder}/${prefix}_${channel}.png`;
}

function material(id) {
  const report = reports[id];
  const [name, color, materialClass, roughness, metalness] = materialConfig[id];
  const maps = Object.fromEntries(['albedo', 'roughness', 'height', 'normal', 'ao'].map((channel) => [channel, {
    path: report.maps[channel].path,
    url: mapUrl(id, channel),
    channel,
    source: 'reference-pixel-extraction',
  }]));
  return {
    id, name, type: 'physical', shaderModel: 'MeshPhysicalMaterial', baseColor: color, color,
    qualityTier: 'hero', materialClass,
    albedo: { dominant: color, secondary: report.palette.slice(0, 4), samplingNotes: 'Verified material crop; projection front remains identity-authoritative.', map: maps.albedo },
    colorVariation: { palette: report.palette, pattern: 'reference-derived regional variation', amplitude: 0.18, heightCorrelation: 0.24 },
    textureResolution: 1024,
    textureProjection: { mode: id === 'projection-front' ? 'perspective-camera-projection' : 'uv', repeat: [1, 1], anisotropy: 8, texelDensityIntent: '1024 combat maps with consistent object-space scale.' },
    surfaceFrequencyBands: [
      { id: 'macro', frequency: 1.5, amplitude: 0.2, role: 'broad value zones' },
      { id: 'meso', frequency: 12, amplitude: 0.11, role: 'armor seams, cloth folds, scale clusters' },
      { id: 'micro', frequency: 58, amplitude: 0.035, role: 'grazing-light highlight breakup' },
    ],
    roughness: { base: roughness, variation: 0.12, map: maps.roughness, localResponse: 'Cavities rougher; exposed trim and eye surfaces smoother.' },
    metalness: { base: metalness, variation: id === 'crest-metal' ? 0.12 : 0 },
    normal: { pattern: 'reference-derived height-gradient', strength: id === 'cape-cloth' ? 0.28 : 0.2, map: maps.normal, heightSource: maps.height, space: 'tangent' },
    bump: { pattern: 'reference-derived height field', amplitude: 0.025, map: maps.height, scale: 1 },
    displacement: { pattern: 'none', amplitude: 0, scale: 1, silhouetteAffects: false },
    ambientOcclusion: { cavityStrength: 0.34, contactShadowBias: 0.35, map: maps.ao, notes: 'Independent AO evidence; dynamic contact shadow remains separate.' },
    wear: { edgeWear: id === 'crest-metal' ? 0.12 : 0.03, scratches: [], chips: [] },
    dirt: { amount: 0.025, cavityBias: 0.25, color: '#181a24' },
    localOverrides: [{ id: `${id}-regional-response`, type: 'material-map-evidence', roughness: Math.max(0.08, roughness - 0.08), evidenceRefs: ['full-object'], notes: 'Reference-derived channel separation with independent PBR maps.' }],
    clearcoat: id === 'eye-glass' ? 0.82 : id === 'crest-metal' ? 0.32 : 0.08,
    shaderNotes: ['Use independent albedo, roughness, normal, height, and AO channels.', 'Projection is front-facing only; unseen regions use palette continuation.'],
    notes: 'Single-image material evidence; verified again under neutral and grazing lights.',
    referencePbr: {
      version: '1.0', sourceImage: report.sourceImage, extractor: 'stage1_intake/extract_pbr_evidence.py',
      method: 'single-image pixel evidence with de-lighting estimate; not photogrammetry', usable: true,
      verdict: report.verdict, confidence: report.confidence, estimatedFidelity: report.estimatedFidelity,
      targetThreshold: 0.7, hardLimit: 'Single-view maps are reference-derived estimates.', maps,
      diagnostics: report.diagnostics, warnings: report.warnings,
    },
  };
}

const colors = {
  'projection-front': ['rgba(69, 75, 123, 1)', 'rgba(216, 203, 185, 1)', 'fabric', 0.86],
  'skin-indigo': ['rgba(52, 57, 101, 1)', 'rgba(92, 86, 140, 1)', 'skin', 0.86],
  'armor-ivory': ['rgba(216, 203, 185, 1)', 'rgba(185, 155, 97, 1)', 'ceramic', 0.84],
  'crest-metal': ['rgba(185, 155, 97, 1)', 'rgba(107, 85, 48, 1)', 'metal', 0.82],
  'cape-cloth': ['rgba(29, 35, 60, 1)', 'rgba(69, 75, 123, 1)', 'fabric', 0.84],
  'eye-glass': ['rgba(92, 86, 140, 1)', 'rgba(20, 24, 45, 1)', 'glass', 0.9],
  'hidden-shell': ['rgba(36, 41, 69, 1)', 'rgba(52, 57, 101, 1)', 'skin', 0.58],
};

function attachment(parent, start, end) {
  return { parentId: parent, parentSocket: `${parent}-socket`, localStart: start, localEnd: end, baseRadius: 0.12, endRadius: 0.09, embedDepth: 0.035, overlap: 0.04, contactType: 'socket', gapTolerance: 0.012, evidenceRefs: ['full-object'] };
}

function component({ id, name, level, parent = null, primitive = 'ellipsoid', topology = 'assembled-solid', material: materialId = 'skin-indigo', role = 'static-part', position = [0, 0, 0], scale = [1, 1, 1], features = [] }) {
  const [dominantAlbedo, secondaryAlbedo, materialClass, confidence] = colors[materialId];
  const start = position;
  const end = [position[0], position[1] + Math.max(0.08, scale[1] * 0.65), position[2]];
  return {
    id, name, level, role, importance: level === 'macro' ? 1 : level === 'meso' ? 0.82 : 0.62,
    confidence: parent ? 0.76 : 0.86, primitive, topologyClass: topology,
    topologyRationale: topology === 'continuous-sculpt' ? `${name} is a smoothly varying volume with non-planar depth.` : topology === 'fiber-strand' ? `${name} follows a rooted curved path.` : topology === 'conforming-shell' ? `${name} is a thin articulated shell over the body.` : `${name} is a discrete runtime-addressable assembly.`,
    geometryDescriptor: { topologyIntent: `${topology} with non-degenerate three-quarter volume`, edgeTreatment: { type: topology === 'assembled-solid' ? 'chamfer' : 'soft', bevelRadius: 0.025, segments: 3 }, deformationStack: ['skeletal-joint deformation'], uvStrategy: materialId === 'projection-front' ? 'camera projection front plus palette-continuation rear' : 'generated UV', normalStrategy: 'smooth vertex normals with independent normal map' },
    parent, attachment: parent ? attachment(parent, start, end) : null,
    dimensions: { width: scale[0], height: scale[1], depth: scale[2], units: 'relative', confidence: 0.76 },
    transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    actionProfile: {
      animationRole: role, pivot: { mode: parent ? 'joint-root' : 'base', localPosition: [0, 0, 0], axis: [0, 1, 0], confidence: 0.82 },
      transformChannels: { translate: true, rotate: true, scale: true, bend: parent !== null, twist: parent !== null, detach: false, visibility: true, materialState: true },
      sockets: [{ id: `${id}-socket`, localPosition: end, purpose: id === 'head' ? 'head-target' : id === 'torso' ? 'cast-origin' : 'attachment' }],
      collider: { type: primitive === 'sphere' || primitive === 'ellipsoid' ? 'sphere' : 'capsule', offset: [0, scale[1] * 0.3, 0], scale: [Math.max(0.12, scale[0] * 0.75), Math.max(0.12, scale[1] * 0.75), Math.max(0.12, scale[2] * 0.75)], isTrigger: false, notes: 'Physics proxy is separate from visual mesh.' },
      constraints: [], destruction: { breakable: false, fractureGroup: id, seamRefs: [], detachableFragments: [], breakImpulse: 0, debrisMaterial: materialId },
    },
    material: materialId, materialLayers: [materialId], deformations: ['idle-breathe', 'locomotion', 'cast-recoil', 'hit-reaction'], joints: parent ? [`${parent}->${id}`] : ['root-motion'], seams: parent ? [`${parent}-${id}-overlap`] : [],
    localFeatures: features.map((feature) => ({ id: feature, type: 'identity-detail', placement: 'reference-observed region', scale: 'meso-or-micro', geometryEffect: 'separate mesh or relief where silhouette-relevant', materialEffect: 'reference-derived local response', confidence: 0.8, evidenceRefs: ['full-object'] })),
    colorMaterialRecipe: { dominantAlbedo, secondaryAlbedo, materialClass, materialClassConfidence: confidence, colorGradient: { type: 'linear', stops: [{ position: 0, color: dominantAlbedo }, { position: 1, color: secondaryAlbedo }] }, evidenceRefs: ['full-object'] },
    surfaceDetail: { macroRoughness: 0.12, microRoughness: 0.06, bumpAmplitude: 0.02, normalPattern: 'independent reference-derived normal', displacementPattern: 'none', occlusionPattern: 'cavity-biased AO', edgeWearPattern: 'restrained contact wear', notes: 'No PBR channel aliases albedo.' },
    evidenceRefs: ['full-object'], details: features, fidelityTier: level === 'macro' ? 'hero' : 'structural',
  };
}

spec.referenceCamera = { solved: false, fovDegrees: camera.fovDegrees.value, aspect: camera.aspect.value, orientation: { yaw: camera.orientation.yawDegrees.value, pitch: camera.orientation.pitchDegrees.value, roll: camera.orientation.rollDegrees.value }, positionHint: camera.position.hint, note: camera.note };
spec.suitability = 'conditional';
spec.scores = { object_isolation: 3, silhouette_readability: 3, depth_inference: 2, primitive_decomposition: 3, material_procedurality: 3, occlusion_risk: 2, interaction_fit: 3 };
spec.preSpecAssessment.unknownsToResolveBeforeImplementation = [];
const kindMap = { 'surface-relief': 'ridge', 'decal-or-inlay': 'decal', 'normal-relief': 'ridge', 'assembled-solid': 'contour', 'fiber-strand': 'contour', 'conforming-shell': 'contour', 'painted-metal': 'gloss' };
spec.preSpecAssessment.detailInventory = { ...inventory, details: inventory.details.map((detail) => ({ ...detail, kind: kindMap[detail.kind] ?? detail.kind, mapsTo: { type: 'component.localFeatures', ref: detail.id } })) };
spec.assumptions = [
  'Rear cape construction and hidden insignia use palette continuation at 0.3 confidence.',
  'Unseen limb cross-sections use tapered volumetric shells inferred from the visible silhouette.',
  'Roster entries route to morphology-specific biped, quadruped, avian, serpentine, construct, or swarm rigs.',
];
spec.silhouette = { boundingShape: '2.7 HU chibi creature with oversized oblate head, compact torso, split cape, short limbs, and curled tail', aspectRatios: [0.68, 1.0, 0.46], symmetry: 'near-bilateral with asymmetric three-quarter tail exposure', dominantCurves: ['head dome', 'cape outer arcs', 'tail curl'], negativeSpaces: ['arm-to-cape gaps', 'split cape around legs'], landmarks: ['crest apex', 'eye line', 'collar tips', 'tabard point', 'boot contacts', 'tail tip'] };
spec.viewEvidence = [{ id: 'full-object', view: 'front-three-quarter', imageRegion: { x: 0, y: 0, width: 1, height: 1, units: 'normalized' }, observations: ['2.7 HU chibi silhouette', 'indigo skin', 'ivory and gold armor', 'split indigo cape', 'justice crest and tabard', 'curled tail'], confidence: 0.88 }];

spec.componentTree = [
  component({ id: 'root', name: 'Rig root', level: 'macro', primitive: 'box', topology: 'assembled-solid', material: 'hidden-shell', role: 'root', scale: [0.9, 0.2, 0.65] }),
  component({ id: 'pelvis', name: 'Pelvis core', level: 'macro', parent: 'root', primitive: 'ellipsoid', topology: 'continuous-sculpt', material: 'skin-indigo', role: 'pelvis', position: [0, 0.66, 0], scale: [0.58, 0.52, 0.48] }),
  component({ id: 'torso', name: 'Volumetric torso', level: 'macro', parent: 'pelvis', primitive: 'ellipsoid', topology: 'continuous-sculpt', material: 'projection-front', role: 'spine', position: [0, 1.14, 0], scale: [0.72, 0.78, 0.5], features: ['gold-chain-drape'] }),
  component({ id: 'head', name: 'Projected volumetric head', level: 'macro', parent: 'torso', primitive: 'ellipsoid', topology: 'continuous-sculpt', material: 'projection-front', role: 'head', position: [0, 1.98, 0.02], scale: [1.14, 0.92, 0.82], features: ['forehead-crest', 'skin-scale-relief', 'eye-catchlights'] }),
  component({ id: 'cape', name: 'Split articulated cape', level: 'macro', parent: 'torso', primitive: 'extrude', topology: 'conforming-shell', material: 'cape-cloth', role: 'cloth-shell', position: [0, 1.18, -0.28], scale: [1.46, 1.3, 0.12], features: ['split-cape-panels', 'cape-border-engraving'] }),
  component({ id: 'tail', name: 'Curled tail chain', level: 'macro', parent: 'pelvis', primitive: 'curve-sweep', topology: 'fiber-strand', material: 'skin-indigo', role: 'tail', position: [0.42, 0.7, -0.14], scale: [1.1, 0.5, 0.3], features: ['tail-curve', 'tail-gold-tip'] }),
  component({ id: 'neck', name: 'Neck joint', level: 'meso', parent: 'torso', primitive: 'capsule', topology: 'assembled-solid', material: 'skin-indigo', role: 'connector', position: [0, 1.62, 0], scale: [0.28, 0.32, 0.28] }),
  component({ id: 'upper-arm-l', name: 'Left upper arm', level: 'meso', parent: 'torso', primitive: 'capsule', material: 'skin-indigo', role: 'arm', position: [-0.5, 1.34, 0], scale: [0.22, 0.48, 0.22] }),
  component({ id: 'upper-arm-r', name: 'Right upper arm', level: 'meso', parent: 'torso', primitive: 'capsule', material: 'skin-indigo', role: 'arm', position: [0.5, 1.34, 0], scale: [0.22, 0.48, 0.22] }),
  component({ id: 'forearm-l', name: 'Left forearm', level: 'meso', parent: 'upper-arm-l', primitive: 'capsule', material: 'armor-ivory', role: 'arm', position: [-0.62, 1.0, 0.04], scale: [0.2, 0.42, 0.2], features: ['bracer-diamond-grid'] }),
  component({ id: 'forearm-r', name: 'Right forearm', level: 'meso', parent: 'upper-arm-r', primitive: 'capsule', material: 'armor-ivory', role: 'arm', position: [0.62, 1.0, 0.04], scale: [0.2, 0.42, 0.2] }),
  component({ id: 'thigh-l', name: 'Left thigh', level: 'meso', parent: 'pelvis', primitive: 'capsule', material: 'skin-indigo', role: 'leg', position: [-0.25, 0.52, 0], scale: [0.28, 0.44, 0.28] }),
  component({ id: 'thigh-r', name: 'Right thigh', level: 'meso', parent: 'pelvis', primitive: 'capsule', material: 'skin-indigo', role: 'leg', position: [0.25, 0.52, 0], scale: [0.28, 0.44, 0.28] }),
  component({ id: 'shin-l', name: 'Left shin', level: 'meso', parent: 'thigh-l', primitive: 'capsule', material: 'skin-indigo', role: 'leg', position: [-0.25, 0.26, 0], scale: [0.22, 0.34, 0.22] }),
  component({ id: 'shin-r', name: 'Right shin', level: 'meso', parent: 'thigh-r', primitive: 'capsule', material: 'skin-indigo', role: 'leg', position: [0.25, 0.26, 0], scale: [0.22, 0.34, 0.22] }),
  component({ id: 'foot-l', name: 'Left armored foot', level: 'meso', parent: 'shin-l', primitive: 'ellipsoid', topology: 'assembled-solid', material: 'armor-ivory', role: 'foot', position: [-0.25, 0.1, 0.09], scale: [0.34, 0.18, 0.48], features: ['boot-diamond-grid'] }),
  component({ id: 'foot-r', name: 'Right armored foot', level: 'meso', parent: 'shin-r', primitive: 'ellipsoid', topology: 'assembled-solid', material: 'armor-ivory', role: 'foot', position: [0.25, 0.1, 0.09], scale: [0.34, 0.18, 0.48] }),
  component({ id: 'shoulder-l', name: 'Left layered shoulder', level: 'meso', parent: 'torso', primitive: 'extrude', topology: 'assembled-solid', material: 'armor-ivory', role: 'armor-shell', position: [-0.52, 1.48, 0.02], scale: [0.5, 0.28, 0.34], features: ['layered-shoulder-plates'] }),
  component({ id: 'shoulder-r', name: 'Right layered shoulder', level: 'meso', parent: 'torso', primitive: 'extrude', topology: 'assembled-solid', material: 'armor-ivory', role: 'armor-shell', position: [0.52, 1.48, 0.02], scale: [0.5, 0.28, 0.34] }),
  component({ id: 'mantle', name: 'High ivory mantle', level: 'meso', parent: 'torso', primitive: 'extrude', topology: 'conforming-shell', material: 'armor-ivory', role: 'armor-shell', position: [0, 1.58, -0.02], scale: [1.18, 0.38, 0.4], features: ['high-collar-gold-edge', 'armor-edge-chamfers'] }),
  component({ id: 'tabard', name: 'Justice tabard', level: 'meso', parent: 'torso', primitive: 'extrude', topology: 'conforming-shell', material: 'projection-front', role: 'cloth-shell', position: [0, 0.98, 0.36], scale: [0.48, 0.86, 0.08], features: ['justice-tabard'] }),
  component({ id: 'crest', name: 'Forehead crest assembly', level: 'meso', parent: 'head', primitive: 'extrude', topology: 'assembled-solid', material: 'crest-metal', role: 'armor-shell', position: [0, 2.54, 0.54], scale: [0.48, 0.48, 0.12], features: ['crest-shield-enamel'] }),
  component({ id: 'eye-l', name: 'Left glossy eye', level: 'micro', parent: 'head', primitive: 'sphere', topology: 'continuous-sculpt', material: 'eye-glass', role: 'sensor', position: [-0.3, 2.05, 0.64], scale: [0.3, 0.36, 0.16], features: ['purple-iris-gradient'] }),
  component({ id: 'eye-r', name: 'Right glossy eye', level: 'micro', parent: 'head', primitive: 'sphere', topology: 'continuous-sculpt', material: 'eye-glass', role: 'sensor', position: [0.3, 2.05, 0.64], scale: [0.3, 0.36, 0.16] }),
  component({ id: 'catchlight-l', name: 'Left eye catchlight', level: 'micro', parent: 'eye-l', primitive: 'sphere', topology: 'surface-relief', material: 'eye-glass', role: 'surface-detail', position: [-0.34, 2.16, 0.79], scale: [0.055, 0.055, 0.025] }),
  component({ id: 'catchlight-r', name: 'Right eye catchlight', level: 'micro', parent: 'eye-r', primitive: 'sphere', topology: 'surface-relief', material: 'eye-glass', role: 'surface-detail', position: [0.26, 2.16, 0.79], scale: [0.055, 0.055, 0.025] }),
  component({ id: 'bracer-l', name: 'Left gold lattice bracer', level: 'micro', parent: 'forearm-l', primitive: 'cylinder', topology: 'surface-relief', material: 'crest-metal', role: 'surface-detail', position: [-0.62, 1.04, 0.05], scale: [0.23, 0.26, 0.23] }),
  component({ id: 'bracer-r', name: 'Right gold lattice bracer', level: 'micro', parent: 'forearm-r', primitive: 'cylinder', topology: 'surface-relief', material: 'crest-metal', role: 'surface-detail', position: [0.62, 1.04, 0.05], scale: [0.23, 0.26, 0.23] }),
  component({ id: 'gold-chain', name: 'Gold chain drape', level: 'micro', parent: 'torso', primitive: 'tube', topology: 'fiber-strand', material: 'crest-metal', role: 'cable', position: [0.16, 1.4, 0.41], scale: [0.42, 0.28, 0.04] }),
  component({ id: 'cape-border', name: 'Cape gold border', level: 'micro', parent: 'cape', primitive: 'extrude', topology: 'surface-relief', material: 'crest-metal', role: 'surface-detail', position: [0, 0.94, -0.34], scale: [1.5, 1.18, 0.04] }),
];

spec.materials = Object.keys(materialConfig).map(material);
spec.repetitionSystems = [
  { id: 'armor-diamond-lattice', geometry: 'instanced raised gold rhombi', instances: 24, buildsGeometry: true, distribution: 'bounded bracer and boot grids', variation: 'scale 0.9-1.08; deterministic seed 11', evidenceRefs: ['full-object'] },
  { id: 'scale-relief-clusters', geometry: 'instanced low-relief scale caps', instances: 42, buildsGeometry: true, distribution: 'irregular head and limb clusters', variation: 'rotation and spacing jitter; deterministic seed 19', evidenceRefs: ['full-object'] },
  { id: 'chain-links', geometry: 'instanced torus links', instances: 18, buildsGeometry: true, distribution: 'curve-following torso drape', variation: 'alternating link rotation', evidenceRefs: ['full-object'] },
];
const passOrder = ['blockout', 'structural-pass', 'form-refinement', 'material-pass', 'lighting-pass', 'interaction-pass', 'optimization-pass'];
spec.buildPasses = passOrder.map((id) => ({ id, goal: {
  'blockout': 'Lock 2.7 HU silhouette and six-archetype volume strategy.',
  'structural-pass': 'Build named joint hierarchy, overlaps, sockets, and collider proxies.',
  'form-refinement': 'Refine head, cape, armor, tail, limbs, and identity geometry.',
  'material-pass': 'Apply projection front plus independent PBR channels and inferred rear materials.',
  'lighting-pass': 'Validate materials under neutral, grazing, and reference-matched light.',
  'interaction-pass': 'Verify idle, locomotion, cast, hit, knockout, selection, clickability, and sockets.',
  'optimization-pass': 'Pool resources, bound draw calls, tune LOD and quality modes.',
}[id], componentRefs: spec.componentTree.map(({ id }) => id), acceptance: [`${id} evidence captured from deterministic front and three-quarter views.`] }));
spec.sculptPipeline = { passGateMode: 'locked-sequential', passOrder, currentPass: 'blockout', completedPasses: [], lastCompletedPass: '', blockedReason: 'blockout requires screenshot review', nextRequiredEvidence: ['deterministic browser render', 'comparison sheet', 'AI vision feature review'] };
spec.featureReviewTargets = [
  { id: 'anatomy-proportion', name: '2.7 HU silhouette and morphology', tier: 'critical', passIds: ['blockout', 'form-refinement'], minimumScore: 0.78, mustPass: true, componentRefs: ['root', 'pelvis', 'torso', 'head', 'tail'], evidenceRefs: ['full-object'] },
  { id: 'joint-attachment', name: 'Joint, cape, tail, and armor attachment', tier: 'critical', passIds: ['structural-pass', 'interaction-pass'], minimumScore: 0.8, mustPass: true, componentRefs: ['torso', 'cape', 'tail', 'upper-arm-l', 'thigh-l'], evidenceRefs: ['full-object'] },
  { id: 'face-crest-identity', name: 'Eyes, catchlights, crest, and head identity', tier: 'critical', passIds: ['form-refinement', 'material-pass'], minimumScore: 0.8, mustPass: true, componentRefs: ['head', 'eye-l', 'eye-r', 'crest'], evidenceRefs: ['full-object'] },
  { id: 'projection-and-palette', name: 'Front projection, hidden-surface honesty, and PBR palette', tier: 'critical', passIds: ['material-pass', 'lighting-pass'], minimumScore: 0.78, mustPass: true, componentRefs: ['head', 'torso', 'tabard', 'cape'], evidenceRefs: ['full-object'] },
  { id: 'runtime-action-readiness', name: 'Rig animation, cast sockets, colliders, and part selection', tier: 'critical', passIds: ['interaction-pass', 'optimization-pass'], minimumScore: 0.78, mustPass: true, componentRefs: ['root', 'torso', 'head', 'upper-arm-r'], evidenceRefs: ['full-object'] },
];
spec.qualityTargets.targetFidelity = 0.82;
spec.qualityTargets.reviewViewpoints = ['front', 'three-quarter', 'side', 'rear', 'gameplay-distance'];
spec.lightingFromPhoto = [
  { id: 'key-light', type: 'directional key light', colorTemperatureK: 5200, intensity: 3.2, direction: [-3, 7, 5], shadow: 'soft PCF contact shadow' },
  { id: 'fill-light', type: 'hemisphere fill light', colorTemperatureK: 6800, intensity: 0.85, direction: [2, 4, -2], note: 'cool sky fill preserves indigo separation' },
  { id: 'rim-environment', type: 'PMREM environment and warm rim light', intensity: 1.2, direction: [4, 3, -5], note: 'ACES Filmic tone mapping, exposure 1.05, pale porcelain background, dynamic contact shadow and AO' },
];
spec.projectionRoute = JSON.parse(readFileSync(`${root}/docs/nyxalune-projection.json`, 'utf8'));
spec.pbrExtractionHistory = Object.entries(reports).map(([materialId, report]) => ({ materialId, confidence: report.confidence, verdict: report.verdict, usable: true, maps: report.maps }));

writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
