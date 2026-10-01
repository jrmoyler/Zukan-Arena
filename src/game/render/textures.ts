import * as THREE from 'three';

/** Small procedural textures shared across effects (generated once, cached). */

const cache = new Map<string, THREE.Texture>();

function canvasTexture(key: string, size: number, draw: (context: CanvasRenderingContext2D, size: number) => void): THREE.Texture {
  const existing = cache.get(key);
  if (existing) return existing;
  let texture: THREE.Texture;
  if (typeof document === 'undefined') {
    texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    texture.needsUpdate = true;
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    if (context) draw(context, size);
    texture = new THREE.CanvasTexture(canvas);
  }
  texture.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, texture);
  return texture;
}

/** Soft white radial falloff — glows, particles, projectile cores. */
export function glowTexture(): THREE.Texture {
  return canvasTexture('glow', 128, (context, size) => {
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.18, 'rgba(255,255,255,0.85)');
    gradient.addColorStop(0.45, 'rgba(255,255,255,0.28)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  });
}

/** Dark contact-shadow blob for under fighters and props. */
export function shadowTexture(): THREE.Texture {
  return canvasTexture('shadow', 128, (context, size) => {
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(20,16,30,0.62)');
    gradient.addColorStop(0.5, 'rgba(20,16,30,0.34)');
    gradient.addColorStop(1, 'rgba(20,16,30,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  });
}

/** Four-point star used for sparkles and stun halos. */
export function sparkleTexture(): THREE.Texture {
  return canvasTexture('sparkle', 128, (context, size) => {
    const c = size / 2;
    const glow = context.createRadialGradient(c, c, 0, c, c, c);
    glow.addColorStop(0, 'rgba(255,255,255,0.9)');
    glow.addColorStop(0.25, 'rgba(255,255,255,0.25)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = glow;
    context.fillRect(0, 0, size, size);
    context.fillStyle = 'rgba(255,255,255,1)';
    context.beginPath();
    const arm = c * 0.95;
    const waist = c * 0.1;
    context.moveTo(c, c - arm);
    context.quadraticCurveTo(c + waist, c - waist, c + arm, c);
    context.quadraticCurveTo(c + waist, c + waist, c, c + arm);
    context.quadraticCurveTo(c - waist, c + waist, c - arm, c);
    context.quadraticCurveTo(c - waist, c - waist, c, c - arm);
    context.fill();
  });
}

/** Elongated comet streak (bright head on +x) for projectile trails. */
export function streakTexture(): THREE.Texture {
  return canvasTexture('streak', 256, (context, size) => {
    const gradient = context.createLinearGradient(0, 0, size, 0);
    gradient.addColorStop(0, 'rgba(255,255,255,0)');
    gradient.addColorStop(0.7, 'rgba(255,255,255,0.35)');
    gradient.addColorStop(0.94, 'rgba(255,255,255,1)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    const band = context.createLinearGradient(0, 0, 0, size);
    band.addColorStop(0, 'rgba(0,0,0,1)');
    band.addColorStop(0.5, 'rgba(0,0,0,0)');
    band.addColorStop(1, 'rgba(0,0,0,1)');
    context.fillRect(0, 0, size, size);
    context.globalCompositeOperation = 'destination-out';
    context.fillStyle = band;
    context.fillRect(0, 0, size, size);
  });
}

export function disposeSharedTextures(): void {
  for (const texture of cache.values()) texture.dispose();
  cache.clear();
}
