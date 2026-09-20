import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader';
import type { AssetContainer } from '@babylonjs/core/assetContainer';
import '@babylonjs/loaders/glTF';
import { ROSTER } from './game/data/roster';
import { characterAsset } from './game/assets/characterAssets';

const select = document.querySelector<HTMLSelectElement>('#character')!;
const animation = document.querySelector<HTMLSelectElement>('#animation')!;
const reference = document.querySelector<HTMLImageElement>('#reference')!;
const canvas = document.querySelector<HTMLCanvasElement>('#model')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
for (const fighter of ROSTER) select.add(new Option(`${fighter.index}. ${fighter.name}`, fighter.id));
const engine = new Engine(canvas, true);
const scene = new Scene(engine);
scene.clearColor = new Color4(0.88, 0.86, 0.81, 1);
const camera = new ArcRotateCamera('ReviewCamera', Math.PI / 2, 1.3, 6, Vector3.Zero(), scene);
camera.attachControl(canvas, true);
camera.minZ = 0.01;
camera.wheelPrecision = 40;
const light = new HemisphericLight('Studio', new Vector3(0, 1, 1), scene);
light.intensity = 1.3;
let container: AssetContainer | undefined;
let request = 0;
async function load(): Promise<void> {
  const token = ++request;
  container?.dispose(); container = undefined;
  const asset = characterAsset(select.value);
  reference.src = asset.reference;
  reference.alt = `${ROSTER.find((fighter) => fighter.id === select.value)?.name} — original reference`;
  animation.disabled = true;
  if (asset.status === 'pending') { status.textContent = 'No replacement model has been supplied. Visual acceptance remains open.'; return; }
  status.textContent = 'Loading model…';
  try {
    const loaded = await LoadAssetContainerAsync(asset.model, scene);
    if (token !== request) { loaded.dispose(); return; }
    container = loaded;
    loaded.addAllToScene();
    let min = new Vector3(Infinity, Infinity, Infinity);
    let max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const mesh of loaded.meshes) {
      if (!mesh.getTotalVertices()) continue;
      mesh.computeWorldMatrix(true);
      const box = mesh.getBoundingInfo().boundingBox;
      min = Vector3.Minimize(min, box.minimumWorld); max = Vector3.Maximize(max, box.maximumWorld);
    }
    camera.setTarget(min.add(max).scale(0.5));
    camera.radius = Math.max(1, max.subtract(min).length() * 1.5);
    animation.disabled = false;
    play();
    status.textContent = `${loaded.meshes.filter((mesh) => mesh.getTotalVertices()).length} meshes · ${loaded.skeletons.length} skeletons · ${loaded.animationGroups.map((group) => group.name).join(', ')}. Compare silhouette, face, costume, palette, appendages and deformation before recording approval.`;
  } catch (error) { if (token === request) status.textContent = `Cannot review model: ${error instanceof Error ? error.message : String(error)}`; }
}
function play(): void {
  for (const group of container?.animationGroups ?? []) {
    group.stop();
    if (group.name === animation.value) group.start(animation.value === 'idle' || animation.value === 'run');
  }
}
select.addEventListener('change', () => void load());
animation.addEventListener('change', play);
window.addEventListener('resize', () => engine.resize());
window.addEventListener('pagehide', () => { request++; container?.dispose(); scene.dispose(); engine.dispose(); }, { once: true });
engine.runRenderLoop(() => scene.render());
void load();
