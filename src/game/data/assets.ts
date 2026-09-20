/** Version assets together with the deployed application, including PR previews. */
export function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL ?? '/'}${path.replace(/^\/+/, '')}`;
}
