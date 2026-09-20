import { readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateBytes } from 'gltf-validator';
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('public/characters/rig-manifest.json', root), 'utf8'));
const approvals = JSON.parse(await readFile(new URL('public/characters/model-approvals.json', root), 'utf8'));
const requireApproved = process.argv.includes('--require-approved');
const hashes = new Set();
let verified = 0;
const pending = [];
for (const fighter of manifest.fighters) {
  const approval = approvals[fighter.id];
  if (fighter.runtime.status !== 'approved') { pending.push(fighter.id); continue; }
  const bytes = await readFile(new URL(`public${fighter.runtime.model}`, root));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hashes.has(hash)) throw new Error(`${fighter.id}: duplicate model bytes; each character needs its own reconstruction`);
  hashes.add(hash);
  if (approval.modelSha256 !== hash || approval.referenceSha256 !== fighter.sourceSha256) throw new Error(`${fighter.id}: approval hashes do not match the model and reference`);
  if (!approval.reviewer || !approval.reviewedAt || !approval.evidence?.length) throw new Error(`${fighter.id}: missing visual review evidence`);
  for (const path of approval.evidence) {
    if (!/^docs\/character-review\/[\w./-]+$/.test(path) || path.includes('..')) throw new Error('Invalid evidence path');
    await access(new URL(path, root));
  }
  const report = await validateBytes(new Uint8Array(bytes), { maxIssues: 100 });
  if (report.issues.numErrors) throw new Error(`${fighter.id}: ${report.issues.numErrors} glTF validation errors\n${JSON.stringify(report.issues.messages)}`);
  const length = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + length).toString());
  if (gltf.buffers?.some((b) => b.uri) || gltf.images?.some((image) => image.uri)) throw new Error(`${fighter.id}: GLB must embed all buffers and images`);
  if (!gltf.skins?.length) throw new Error(`${fighter.id}: no skin`);
  for (const action of fighter.runtime.actions) if (!gltf.animations?.some((clip) => clip.name === action && clip.channels?.length)) throw new Error(`${fighter.id}: missing ${action}`);
  for (const socket of fighter.runtime.sockets) if (!gltf.nodes?.some((node) => node.name === socket)) throw new Error(`${fighter.id}: missing ${socket}`);
  verified++;
}
console.log(`${verified}/68 approved assets verified; ${pending.length} pending.`);
if (requireApproved && pending.length) {
  console.error(`RELEASE BLOCKED: ${pending.join(', ')}`);
  process.exitCode = 1;
}
