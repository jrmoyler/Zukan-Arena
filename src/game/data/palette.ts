import type { TeamKind } from '../types';

/** Team identity colours. The colour-safe pair (blue / orange) stays distinct
 * under protanopia, deuteranopia and tritanopia. */
const TEAM_COLORS: Readonly<Record<'standard' | 'safe', Record<TeamKind, number>>> = {
  standard: { signal: 0x5fe6ff, rift: 0xff5a7a },
  safe: { signal: 0x4aa3ff, rift: 0xffa02e },
};

export function teamColor(team: TeamKind, colorSafe = false): number {
  return TEAM_COLORS[colorSafe ? 'safe' : 'standard'][team];
}
