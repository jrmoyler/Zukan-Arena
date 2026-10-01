import { ABILITIES } from './abilities';
import type { ElementKind, FighterDefinition, FighterRole } from '../types';

/**
 * Every fighter carries a four-slot kit: a rapid basic bolt shaped by role, the
 * canonical elemental signature (see abilities.ts), a dash, and an ultimate
 * that amplifies the signature. Numbers live here so balance can be tuned in
 * one place and asserted in tests.
 */

export interface BasicAttackDefinition {
  label: string;
  damage: number;
  cooldown: number;
  speed: number;
  range: number;
  radius: number;
  pierce: boolean;
}

export interface DashDefinition {
  distance: number;
  duration: number;
  invulnerability: number;
  cooldown: number;
}

export interface UltimateDefinition {
  label: string;
  description: string;
  damageMultiplier: number;
  radiusMultiplier: number;
  impactDelay: number;
  /** Ultimate charge needed, gained from damage dealt and received. */
  charge: number;
}

export const ROLE_BASIC: Readonly<Record<FighterRole, BasicAttackDefinition>> = {
  Builder: { label: 'Bulwark Bolt', damage: 7, cooldown: 0.55, speed: 12.5, range: 7.2, radius: 0.42, pierce: false },
  Creator: { label: 'Flicker Shot', damage: 4.5, cooldown: 0.32, speed: 17, range: 8.2, radius: 0.32, pierce: false },
  Strategist: { label: 'Piercing Glyph', damage: 5.5, cooldown: 0.45, speed: 15, range: 9.4, radius: 0.34, pierce: true },
};

export const ROLE_DASH: Readonly<Record<FighterRole, DashDefinition>> = {
  Builder: { distance: 2.6, duration: 0.2, invulnerability: 0.24, cooldown: 3.1 },
  Creator: { distance: 3.4, duration: 0.18, invulnerability: 0.24, cooldown: 2.2 },
  Strategist: { distance: 3, duration: 0.19, invulnerability: 0.24, cooldown: 2.6 },
};

export const ROLE_SUMMARY: Readonly<Record<FighterRole, string>> = {
  Builder: 'Durable bruiser. Heavy bolts, short dash, extra vitality.',
  Creator: 'Agile skirmisher. Rapid bolts and a long, quick dash.',
  Strategist: 'Long-range tactician. Bolts pierce through every foe in line.',
};

export const ULTIMATES: Readonly<Record<ElementKind, UltimateDefinition>> = {
  earth: {
    label: 'Tectonic Coronation',
    description: 'Raise a colossal fault crown that stuns everything inside for 1.2s.',
    damageMultiplier: 2.3, radiusMultiplier: 1.7, impactDelay: 0.8, charge: 100,
  },
  hydro: {
    label: 'Moonpool Deluge',
    description: 'Drop a tidal column that crushes and heavily slows for 3s.',
    damageMultiplier: 2.2, radiusMultiplier: 1.8, impactDelay: 0.78, charge: 100,
  },
  gale: {
    label: 'Heaven-Silk Tempest',
    description: 'Unspool a tempest that hurls foes far away and grounds them.',
    damageMultiplier: 2.1, radiusMultiplier: 1.75, impactDelay: 0.72, charge: 100,
  },
  plasma: {
    label: 'Sixfold Arc Storm',
    description: 'Chain a storm of filaments through up to six targets.',
    damageMultiplier: 2.2, radiusMultiplier: 2.2, impactDelay: 0.55, charge: 100,
  },
  nature: {
    label: 'First Garden Snare',
    description: 'Erupt an ancient grove that roots for 2.4s and mends allies.',
    damageMultiplier: 2.0, radiusMultiplier: 1.85, impactDelay: 0.9, charge: 100,
  },
  void: {
    label: 'Eventide Collapse',
    description: 'Collapse a dark star that drains life to heal the whole team.',
    damageMultiplier: 2.5, radiusMultiplier: 1.6, impactDelay: 0.85, charge: 100,
  },
};

/**
 * Elemental resonance: two triangles. Earth grounds Plasma, Plasma boils Hydro,
 * Hydro erodes Earth; Gale scatters Nature, Nature anchors Void, Void swallows
 * Gale. Attacks across triangles are neutral.
 */
export const ELEMENT_ADVANTAGE: Readonly<Record<ElementKind, ElementKind>> = {
  earth: 'plasma',
  plasma: 'hydro',
  hydro: 'earth',
  gale: 'nature',
  nature: 'void',
  void: 'gale',
};

export const RESONANT_MULTIPLIER = 1.25;
export const RESISTED_MULTIPLIER = 0.8;

export type Effectiveness = 'resonant' | 'neutral' | 'resisted';

export function effectivenessOf(attacker: ElementKind, defender: ElementKind): Effectiveness {
  if (ELEMENT_ADVANTAGE[attacker] === defender) return 'resonant';
  if (ELEMENT_ADVANTAGE[defender] === attacker) return 'resisted';
  return 'neutral';
}

export function effectivenessMultiplier(effectiveness: Effectiveness): number {
  if (effectiveness === 'resonant') return RESONANT_MULTIPLIER;
  if (effectiveness === 'resisted') return RESISTED_MULTIPLIER;
  return 1;
}

export function weakAgainst(element: ElementKind): ElementKind {
  return (Object.keys(ELEMENT_ADVANTAGE) as ElementKind[]).find((key) => ELEMENT_ADVANTAGE[key] === element) ?? element;
}

export interface FighterKit {
  basic: BasicAttackDefinition;
  skill: (typeof ABILITIES)[ElementKind];
  dash: DashDefinition;
  ultimate: UltimateDefinition;
}

export function kitFor(fighter: Pick<FighterDefinition, 'element' | 'role'>): FighterKit {
  return {
    basic: ROLE_BASIC[fighter.role],
    skill: ABILITIES[fighter.element],
    dash: ROLE_DASH[fighter.role],
    ultimate: ULTIMATES[fighter.element],
  };
}

export const ELEMENT_LABEL: Readonly<Record<ElementKind, string>> = {
  earth: 'Earth',
  hydro: 'Hydro',
  gale: 'Gale',
  plasma: 'Plasma',
  nature: 'Nature',
  void: 'Void',
};

export const ELEMENT_HEX: Readonly<Record<ElementKind, number>> = {
  earth: 0xd4a467,
  hydro: 0x4fd1e8,
  gale: 0xa9eedf,
  plasma: 0xf4cf4a,
  nature: 0x74d277,
  void: 0xad8cf5,
};
