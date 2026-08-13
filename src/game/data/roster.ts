import { archetypeFor } from './archetypes';
import type { ElementKind, FighterDefinition, FighterRole } from '../types';

interface ElementStats {
  maxHp: number;
  speed: number;
  power: number;
}

const ELEMENT_STATS: Readonly<Record<ElementKind, ElementStats>> = {
  earth: { maxHp: 128, speed: 3.7, power: 0.96 },
  hydro: { maxHp: 112, speed: 4.25, power: 0.97 },
  gale: { maxHp: 102, speed: 4.8, power: 0.88 },
  plasma: { maxHp: 104, speed: 4.45, power: 1.04 },
  nature: { maxHp: 120, speed: 3.95, power: 0.95 },
  void: { maxHp: 108, speed: 4.3, power: 1.02 },
};

const ROLE_STATS: Readonly<Record<FighterRole, ElementStats>> = {
  Builder: { maxHp: 6, speed: -0.12, power: 0.02 },
  Creator: { maxHp: -2, speed: 0.12, power: 0.04 },
  Strategist: { maxHp: 1, speed: 0, power: 0 },
};

type RosterRow = readonly [
  index: number,
  name: string,
  epithet: string,
  element: ElementKind,
  role: FighterRole,
];

const ROSTER_ROWS = [
  [1, 'Nyxalune', 'The Abyss Oracle', 'void', 'Builder'],
  [2, 'Coralyn', 'Bloomstar of the First Garden', 'nature', 'Creator'],
  [3, 'Mallowkin', 'The Cloudstep Familiar', 'gale', 'Strategist'],
  [4, 'Tidel Pip', 'Keeper of the Moonpool', 'hydro', 'Builder'],
  [5, 'Cirru Bluebell', 'The Rain-Song Herald', 'hydro', 'Creator'],
  [6, 'Mossprig', 'Seedling of the Green Signal', 'nature', 'Strategist'],
  [7, 'Prism Chorus', 'The Sixty-Eightfold Spark', 'plasma', 'Builder'],
  [8, 'Vesper Talon', 'Watcher Beyond the Lantern', 'void', 'Creator'],
  [9, 'Sylva Crown', 'Antlered Spirit of Dawn', 'nature', 'Strategist'],
  [10, 'Aeris Nightwing', 'Navigator of Pale Skies', 'gale', 'Builder'],
  [11, 'Tigris Undertow', 'The Reefsteel Prowler', 'hydro', 'Creator'],
  [12, 'Brassburrow', 'Delver Beneath the Arena', 'earth', 'Strategist'],
  [13, 'Gaiadorn', 'Bearer of the Living Mesa', 'earth', 'Builder'],
  [14, 'Umbra Thread', 'Spinner of Silent Orbits', 'void', 'Creator'],
  [15, 'Axolume', 'The Luminous Current', 'hydro', 'Strategist'],
  [16, 'Oakenhart', 'Warden of Root and Ring', 'nature', 'Builder'],
  [17, 'Onyx Mane', 'The Rift-Crowned Colossus', 'earth', 'Creator'],
  [18, 'Cairnhoof', 'Ram of the Deep Foundation', 'earth', 'Strategist'],
  [19, 'Terra Shell', 'Garden on the Moving Stone', 'earth', 'Builder'],
  [20, 'Zephyra Flare', 'Petalblade of the Jetstream', 'gale', 'Creator'],
  [21, 'Rax Embercoil', 'The Red Arc Unbound', 'plasma', 'Strategist'],
  [22, 'Pebbleward', 'The Patient Rampart', 'earth', 'Builder'],
  [23, 'Riptide Wyrm', 'Serpent of the Glass Sea', 'hydro', 'Creator'],
  [24, 'Briar Owl', 'Sage of the Hollow Grove', 'nature', 'Strategist'],
  [25, 'Lunavex', 'Dreamfox of the Violet Elsewhere', 'void', 'Builder'],
  [26, 'Dunehop', 'The Sandglass Courier', 'earth', 'Creator'],
  [27, 'Sirocco Ink', 'Skyrider of the Black Current', 'gale', 'Strategist'],
  [28, 'Bublune', 'Heart of the Joyful Tide', 'hydro', 'Builder'],
  [29, 'Rosette Drift', 'The Cottonwind Dancer', 'gale', 'Creator'],
  [30, 'Helix Sprout', 'Gardener of Living Code', 'nature', 'Strategist'],
  [31, 'Verdant Drake', 'Leafscale of the Canopy', 'nature', 'Builder'],
  [32, 'Volt Sentinel', 'The Cerulean Dynamo', 'plasma', 'Creator'],
  [33, 'Marshal Amp', 'Keeper of the Signal Law', 'plasma', 'Strategist'],
  [34, 'Solspark', 'The Laughing Supernova', 'plasma', 'Builder'],
  [35, 'Copperwing', 'Ace of the Endless Updraft', 'gale', 'Creator'],
  [36, 'Glacielle', 'Facet of the Frozen Deep', 'hydro', 'Strategist'],
  [37, 'Arcloom', 'Weaver of Electric Constellations', 'plasma', 'Builder'],
  [38, 'Auric Tinker', 'Clocksmith of the Golden Strata', 'earth', 'Creator'],
  [39, 'Thornkin', 'The Bramblebound Artisan', 'nature', 'Strategist'],
  [40, 'Redline Ravager', 'Breaker of the Voltage Limit', 'plasma', 'Builder'],
  [41, 'Amethyst Rift', 'Crystal Born Between Worlds', 'void', 'Creator'],
  [42, 'Bastion Block', 'Fortress of the Blue Quarry', 'earth', 'Strategist'],
  [43, 'Circuit Cub', 'The Teal Pulse Engine', 'plasma', 'Builder'],
  [44, 'Skyglass', 'Silent Blade of the Upper Air', 'gale', 'Creator'],
  [45, 'Maris Bell', 'Jellylight of the Shallows', 'hydro', 'Strategist'],
  [46, 'Basalt Claw', 'The Magma-Ridge Vanguard', 'earth', 'Builder'],
  [47, 'Astra Owl', 'Golden Eye of the Zenith', 'gale', 'Creator'],
  [48, 'Nullstar', 'Radiance at the Edge of Nothing', 'void', 'Strategist'],
  [49, 'Glitchwisp', 'The Unresolved Signal', 'void', 'Builder'],
  [50, 'Luminor Loam', 'The Gentle Earthen Light', 'earth', 'Creator'],
  [51, 'Gilded Bud', 'Small Keeper of Great Forests', 'nature', 'Strategist'],
  [52, 'Crimson Surge', 'Spirit of the Scarlet Circuit', 'plasma', 'Builder'],
  [53, 'Viridian Skyrake', 'The Archive Wind', 'gale', 'Creator'],
  [54, 'Shardshade', 'Fox of the Fractured Veil', 'void', 'Strategist'],
  [55, 'Relay-01', 'First Node of the New Network', 'plasma', 'Builder'],
  [56, 'Aquavine', 'Tendril of the Azure Delta', 'hydro', 'Creator'],
  [57, 'Velocity Veil', 'The White Horizon Swift', 'gale', 'Strategist'],
  [58, 'Quiet Mint', 'Whisper from the Soft Beyond', 'void', 'Builder'],
  [59, 'Sunstone Scout', 'Pathfinder of the Bright Mesa', 'earth', 'Creator'],
  [60, 'Nimbus Drop', 'The Little Monsoon', 'hydro', 'Strategist'],
  [61, 'Pale Rose Revenant', 'Thorn of the Forgotten Moon', 'void', 'Builder'],
  [62, 'Trealin Tide', 'Dancer of the Spiral Current', 'hydro', 'Creator'],
  [63, 'Cloverling', 'The Hope That Took Root', 'nature', 'Strategist'],
  [64, 'Kora-9', 'Wayfinder of the White Circuit', 'plasma', 'Builder'],
  [65, 'Starlace Warden', 'Guardian of the Upper Quiet', 'gale', 'Creator'],
  [66, 'Coral Pollen', 'The Blooming Signal', 'nature', 'Strategist'],
  [67, 'Hushcloak', 'The Unseen Pilgrim', 'void', 'Builder'],
  [68, 'Longevita Aqua', 'Memory of the First Ocean', 'hydro', 'Creator'],
] as const satisfies readonly RosterRow[];

function createFighter([index, name, epithet, element, role]: RosterRow): FighterDefinition {
  const elementStats = ELEMENT_STATS[element];
  const roleStats = ROLE_STATS[role];
  const paddedIndex = String(index).padStart(3, '0');

  return {
    id: `zukan-${paddedIndex}`,
    index,
    name,
    epithet,
    element,
    role,
    archetype: archetypeFor(index),
    portrait: `/characters/optimized/zukan-${paddedIndex}.webp`,
    maxHp: elementStats.maxHp + roleStats.maxHp,
    speed: elementStats.speed + roleStats.speed,
    power: elementStats.power + roleStats.power,
  };
}

export const ROSTER: readonly FighterDefinition[] = ROSTER_ROWS.map(createFighter);

export const FIGHTER_BY_ID: ReadonlyMap<string, FighterDefinition> = new Map(
  ROSTER.map((fighter) => [fighter.id, fighter]),
);

export function getFighterById(id: string): FighterDefinition | undefined {
  return FIGHTER_BY_ID.get(id);
}
