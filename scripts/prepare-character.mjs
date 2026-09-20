import { NodeIO } from '@gltf-transform/core';
import { dedup, prune, textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';
const [input, output] = process.argv.slice(2);
if (!input || !output || input === output) throw new Error('Usage: node scripts/prepare-character.mjs input.glb output.glb (retain the source)');
const io = new NodeIO();
const doc = await io.read(input);
// Preserve authored topology and all animation/skeleton data. No automatic
// decimation: silhouettes and costume details need per-character review.
await doc.transform(dedup(), prune(), textureCompress({ encoder: sharp, targetFormat: 'png', resize: [2048, 2048] }));
await io.write(output, doc);
console.log(`Prepared ${output}; reference comparison and approval are still required.`);
