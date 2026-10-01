import type { Difficulty } from '../simulation/CombatSimulation';
import { Store } from './storage';

export type QualitySetting = 'auto' | 'high' | 'medium' | 'low';
export type QualityTier = Exclude<QualitySetting, 'auto'>;
export type MotionSetting = 'system' | 'reduced' | 'full';

export interface Settings {
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  quality: QualitySetting;
  screenShake: number;
  damageNumbers: boolean;
  motion: MotionSetting;
  aimAssist: boolean;
  difficulty: Difficulty;
  showFps: boolean;
  /** Swaps team colours to a blue / orange pair that survives common colour-vision deficiencies. */
  colorSafeTeams: boolean;
  hudScale: number;
}

export const DEFAULT_SETTINGS: Settings = {
  masterVolume: 0.8,
  musicVolume: 0.6,
  sfxVolume: 0.9,
  quality: 'auto',
  screenShake: 1,
  damageNumbers: true,
  motion: 'system',
  aimAssist: true,
  difficulty: 'adept',
  showFps: false,
  colorSafeTeams: false,
  hudScale: 1,
};

export const settings = new Store<Settings>('settings', DEFAULT_SETTINGS);

export function prefersReducedMotion(value: Readonly<Settings> = settings.get()): boolean {
  if (value.motion === 'reduced') return true;
  if (value.motion === 'full') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Picks a starting tier from device hints; the renderer adapts further at runtime. */
export function detectQuality(): QualityTier {
  if (typeof navigator === 'undefined') return 'medium';
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  if (memory <= 3 || cores <= 4) return 'low';
  if (coarse || memory <= 6) return 'medium';
  return 'high';
}

export function resolveQuality(value: Readonly<Settings> = settings.get()): QualityTier {
  return value.quality === 'auto' ? detectQuality() : value.quality;
}
