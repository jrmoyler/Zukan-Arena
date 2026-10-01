/** Shared arena geometry used by the simulation, AI and renderer. */

export const ARENA_BOUNDS = Object.freeze({ x: 9.2, z: 5.6 });

export const PICKUP_RADIUS = 0.75;

/** Porcelain plinths: block movement and projectiles, giving cover to play around. */
export const PILLARS: readonly { readonly x: number; readonly z: number; readonly radius: number }[] = Object.freeze([
  { x: -3.3, z: -2.35, radius: 0.62 },
  { x: 3.3, z: -2.35, radius: 0.62 },
  { x: -3.3, z: 2.35, radius: 0.62 },
  { x: 3.3, z: 2.35, radius: 0.62 },
]);
