import * as THREE from 'three';

import { PILLARS } from '../simulation/arena';

/**
 * Paints the combat court: honed slate tiles with marbling, champagne seams,
 * faint team tints on each half and a central resonance medallion. Drawn once
 * into a canvas so the arena stays asset-free.
 */
export function createCourtTexture(width: number, depth: number, pixelsPerMetre = 110): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * pixelsPerMetre);
  canvas.height = Math.round(depth * pixelsPerMetre);
  const context = canvas.getContext('2d');
  if (!context) return new THREE.CanvasTexture(canvas);
  const w = canvas.width;
  const h = canvas.height;
  const m = pixelsPerMetre;
  let seed = 0x2f6e2b1;
  const random = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };

  const base = context.createLinearGradient(0, 0, w, 0);
  base.addColorStop(0, '#2f3e57');
  base.addColorStop(0.5, '#3a4862');
  base.addColorStop(1, '#4a3a55');
  context.fillStyle = base;
  context.fillRect(0, 0, w, h);

  // Individual tiles with slight tone variation and soft marble veins.
  const tile = 1.15 * m;
  const columns = Math.ceil(w / tile);
  const rows = Math.ceil(h / tile);
  const offsetX = (w - columns * tile) / 2;
  const offsetY = (h - rows * tile) / 2;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = offsetX + column * tile;
      const y = offsetY + row * tile;
      const tone = (random() - 0.5) * 0.08;
      context.fillStyle = tone > 0 ? `rgba(255,255,255,${tone})` : `rgba(0,0,0,${-tone})`;
      context.fillRect(x, y, tile, tile);
      context.save();
      context.beginPath();
      context.rect(x, y, tile, tile);
      context.clip();
      context.strokeStyle = 'rgba(220,226,240,0.06)';
      context.lineWidth = 1.2;
      for (let vein = 0; vein < 2; vein += 1) {
        context.beginPath();
        let vx = x + random() * tile;
        let vy = y;
        context.moveTo(vx, vy);
        while (vy < y + tile) {
          vx += (random() - 0.5) * tile * 0.35;
          vy += tile * (0.12 + random() * 0.15);
          context.lineTo(vx, vy);
        }
        context.stroke();
      }
      context.restore();
    }
  }

  // Champagne seams.
  context.strokeStyle = 'rgba(232,194,122,0.28)';
  context.lineWidth = 2;
  for (let column = 0; column <= columns; column += 1) {
    const x = offsetX + column * tile;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, h);
    context.stroke();
  }
  for (let row = 0; row <= rows; row += 1) {
    const y = offsetY + row * tile;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(w, y);
    context.stroke();
  }

  // Team halves.
  const signal = context.createLinearGradient(0, 0, w * 0.5, 0);
  signal.addColorStop(0, 'rgba(95,230,255,0.13)');
  signal.addColorStop(1, 'rgba(95,230,255,0)');
  context.fillStyle = signal;
  context.fillRect(0, 0, w * 0.5, h);
  const rift = context.createLinearGradient(w, 0, w * 0.5, 0);
  rift.addColorStop(0, 'rgba(255,90,122,0.12)');
  rift.addColorStop(1, 'rgba(255,90,122,0)');
  context.fillStyle = rift;
  context.fillRect(w * 0.5, 0, w * 0.5, h);

  // Central medallion where the Resonance Bloom surfaces.
  const cx = w / 2;
  const cy = h / 2;
  const gold = 'rgba(232,194,122,0.55)';
  context.strokeStyle = gold;
  context.lineWidth = 3;
  for (const radius of [1.05, 1.55, 2.4]) {
    context.beginPath();
    context.arc(cx, cy, radius * m, 0, Math.PI * 2);
    context.stroke();
  }
  context.lineWidth = 1.5;
  for (let ray = 0; ray < 24; ray += 1) {
    const angle = (ray / 24) * Math.PI * 2;
    const inner = ray % 2 === 0 ? 1.6 : 1.85;
    context.beginPath();
    context.moveTo(cx + Math.cos(angle) * inner * m, cy + Math.sin(angle) * inner * m);
    context.lineTo(cx + Math.cos(angle) * 2.35 * m, cy + Math.sin(angle) * 2.35 * m);
    context.stroke();
  }
  const glow = context.createRadialGradient(cx, cy, 0, cx, cy, 1.05 * m);
  glow.addColorStop(0, 'rgba(255,214,140,0.22)');
  glow.addColorStop(1, 'rgba(255,214,140,0)');
  context.fillStyle = glow;
  context.beginPath();
  context.arc(cx, cy, 1.05 * m, 0, Math.PI * 2);
  context.fill();

  // Pillar footprints.
  for (const pillar of PILLARS) {
    const px = cx + pillar.x * m;
    const py = cy + pillar.z * m;
    context.strokeStyle = 'rgba(232,194,122,0.35)';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(px, py, (pillar.radius + 0.35) * m, 0, Math.PI * 2);
    context.stroke();
  }

  // Centre line and boundary.
  context.strokeStyle = 'rgba(232,194,122,0.5)';
  context.lineWidth = 3;
  context.setLineDash([m * 0.35, m * 0.22]);
  context.beginPath();
  context.moveTo(cx, 0);
  context.lineTo(cx, cy - 2.45 * m);
  context.moveTo(cx, cy + 2.45 * m);
  context.lineTo(cx, h);
  context.stroke();
  context.setLineDash([]);
  context.strokeStyle = 'rgba(248,230,184,0.6)';
  context.lineWidth = 6;
  context.strokeRect(10, 10, w - 20, h - 20);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}
