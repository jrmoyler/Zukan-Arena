/**
 * Minimal Node.js type declarations for the build-time PWA plugin.
 *
 * The project intentionally does not depend on @types/node, but `tsc --noEmit`
 * type-checks vite.config.ts (and therefore build/pwa.ts). These declarations
 * cover exactly the Node APIs that plugin uses. They are written as function
 * overloads / interfaces only, so they merge harmlessly if @types/node is ever
 * added to the project.
 */

declare module 'node:fs' {
  interface PwaDirent {
    name: string;
    isFile(): boolean;
    isDirectory(): boolean;
  }
  export function readFileSync(path: string): Uint8Array;
  export function readdirSync(path: string, options: { withFileTypes: true }): PwaDirent[];
  export function writeFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
}

declare module 'node:path' {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function relative(from: string, to: string): string;
}

declare module 'node:crypto' {
  interface PwaHash {
    update(data: string | Uint8Array): PwaHash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: string): PwaHash;
}
