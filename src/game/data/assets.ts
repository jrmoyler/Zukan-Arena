/** Resolves a public asset path against the deployment base so the game works
 * from any sub-path and every file can be precached by the service worker. */
export function assetUrl(path: string): string {
  const base = import.meta.env?.BASE_URL ?? '/';
  const normalized = path.startsWith('/') ? path.slice(1) : path;
  return `${base.endsWith('/') ? base : `${base}/`}${normalized}`;
}

export function cutoutUrl(fighterId: string): string {
  return assetUrl(`characters/cutout/${fighterId}.webp`);
}
