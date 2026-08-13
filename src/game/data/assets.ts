const REPOSITORY_ASSET_ROOT = 'https://raw.githubusercontent.com/jrmoyler/Zukan-Arena/main/public';

/** Public art is served from the source repository so Vercel deployments stay
 * cacheable and the canonical asset files remain independently inspectable. */
export function assetUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${REPOSITORY_ASSET_ROOT}${normalized}`;
}

