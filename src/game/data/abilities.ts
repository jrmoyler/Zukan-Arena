import type { AbilityDefinition, ElementKind } from '../types';

export const ELEMENT_ORDER = [
  'earth',
  'hydro',
  'gale',
  'plasma',
  'nature',
  'void',
] as const satisfies readonly ElementKind[];

export const ABILITIES: Readonly<Record<ElementKind, Readonly<AbilityDefinition>>> = {
  earth: {
    element: 'earth',
    label: 'Fault Crown',
    cooldown: 5.6,
    energy: 24,
    damage: 27,
    radius: 2.1,
    range: 6.7,
    impactDelay: 0.46,
    description: 'Heave crust plates and boulder towers from a slowing seismic crown.',
  },
  hydro: {
    element: 'hydro',
    label: 'Tidal Lens',
    cooldown: 4.9,
    energy: 21,
    damage: 21,
    radius: 2.6,
    range: 7.4,
    impactDelay: 0.48,
    description: 'Drive a refracting tide and foam lens that slows caught opponents.',
  },
  gale: {
    element: 'gale',
    label: 'Silk Cyclone',
    cooldown: 4.2,
    energy: 18,
    damage: 17,
    radius: 3,
    range: 8,
    impactDelay: 0.5,
    description: 'Comb the air into silk ribbons and a cyclone that knocks enemies back.',
  },
  plasma: {
    element: 'plasma',
    label: 'Arc Filament',
    cooldown: 3.8,
    energy: 20,
    damage: 23,
    radius: 1.9,
    range: 8.8,
    impactDelay: 0.23,
    description: 'Snap high-frequency energy filaments through as many as three targets.',
  },
  nature: {
    element: 'nature',
    label: 'Verdant Bind',
    cooldown: 5.1,
    energy: 22,
    damage: 19,
    radius: 2.4,
    range: 7.2,
    impactDelay: 0.66,
    description: 'Grow procedural tendrils that root opponents inside their living bind.',
  },
  void: {
    element: 'void',
    label: 'Eventide Well',
    cooldown: 6.4,
    energy: 28,
    damage: 31,
    radius: 2.25,
    range: 6.5,
    impactDelay: 0.58,
    description: 'Open a dark tendril well that drains the opposition and restores its caster.',
  },
};

export function abilityFor(element: ElementKind): Readonly<AbilityDefinition> {
  return ABILITIES[element];
}
