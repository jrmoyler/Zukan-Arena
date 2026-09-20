import { assetUrl } from '../data/assets';

export const REQUIRED_ACTIONS = ['idle', 'run', 'cast', 'hit', 'ko'] as const;
export type FighterAnimation = typeof REQUIRED_ACTIONS[number];
export interface CharacterAsset {
  id: string;
  model: string;
  status: 'pending' | 'review' | 'approved';
  reference: string;
}

// Approval records are checked in beside the actual GLBs. A missing model must
// never silently become a capsule, a shared creature, or a portrait billboard.
import approvals from '../../../public/characters/model-approvals.json';
export function characterAsset(id: string): CharacterAsset {
  const record = (approvals as Record<string, { status: CharacterAsset['status'] }>)[id];
  return {
    id,
    model: assetUrl(`/characters/models/${id}.glb`),
    reference: assetUrl(`/characters/optimized/${id}.webp`),
    status: record?.status ?? 'pending',
  };
}

export class CharacterAssetError extends Error {
  constructor(public readonly fighterId: string, message: string) {
    super(`${fighterId}: ${message}`);
    this.name = 'CharacterAssetError';
  }
}
