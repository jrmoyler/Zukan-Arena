import type { Vector3 } from 'three';

export type ElementKind = 'earth' | 'hydro' | 'gale' | 'plasma' | 'nature' | 'void';
export type FighterRole = 'Builder' | 'Creator' | 'Strategist';
export type RigArchetype = 'biped' | 'quadruped' | 'avian' | 'serpentine' | 'construct' | 'swarm';
export type TeamKind = 'signal' | 'rift';
export type MatchResult = 'win' | 'loss';

export interface FighterDefinition {
  id: string;
  index: number;
  name: string;
  epithet: string;
  element: ElementKind;
  role: FighterRole;
  archetype: RigArchetype;
  portrait: string;
  maxHp: number;
  speed: number;
  power: number;
}

export interface AbilityDefinition {
  element: ElementKind;
  label: string;
  cooldown: number;
  energy: number;
  damage: number;
  radius: number;
  range: number;
  impactDelay: number;
  description: string;
}

export interface CastEvent {
  casterId: string;
  element: ElementKind;
  origin: Vector3;
  target: Vector3;
  team: TeamKind;
  power: number;
}
