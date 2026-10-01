/**
 * Per-portrait staging notes for the HD-2D cutouts.
 *
 * FACING: the direction the creature's head points in its source art
 * (-1 = screen left, 1 = screen right; omitted = front-facing). Sprites mirror
 * themselves so creatures always look where they are moving or aiming.
 *
 * FLOATERS: creatures painted airborne; they hover and bob instead of hopping.
 */

export const ART_FACING: Readonly<Record<number, -1 | 1>> = {
  9: -1, 10: -1, 11: -1, 12: -1, 13: -1, 14: 1, 15: -1, 18: -1, 19: -1, 20: -1,
  21: -1, 23: -1, 25: -1, 27: -1, 44: 1, 46: -1, 53: 1, 57: 1,
};

export const FLOATERS: ReadonlySet<number> = new Set([27, 44, 49, 53, 54, 57, 58, 63, 66, 68]);
