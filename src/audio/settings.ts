import calibration from './calibration.json' with { type: 'json' };
import type { ProfileStorage } from '../gamepad.ts';

export const audioChannels = ['motor', 'gear', 'belt', 'main', 'tail'] as const;
export type AudioChannel = typeof audioChannels[number];
export interface AudioProfile {
  soundEnabled: boolean;
  volume: number;
  channelVolumes: Record<AudioChannel, number>;
  enabled: Record<AudioChannel, boolean>;
  mainTransients: boolean; mainImpact: number; mainCrisp: number;
  transients: boolean; impact: number; dynamic: number; pitchShift: number;
  tailBurstPitch: number; tailVoice: 'hybrid' | 'recording'; tailDecay: number;
  mainDirectivity: number;
}
export const audioStorageKey = 'heli-lab.audio.v1';
export const defaultAudioProfile = (): AudioProfile => structuredClone(calibration.profile) as AudioProfile;
const bounds = {
  volume: [0, 100], mainImpact: [0, 100], mainCrisp: [0, 100], impact: [0, 200],
  dynamic: [0, 100], pitchShift: [-2, 2], tailBurstPitch: [-4, 12], tailDecay: [.1, 2], mainDirectivity: [0, 100],
} as const;
export function readAudioProfile(value: unknown): AudioProfile {
  const result = defaultAudioProfile();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const source = value as Record<string, unknown>;
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const n = source[key];
    if (typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max) (result as unknown as Record<string, unknown>)[key] = n;
  }
  for (const key of ['soundEnabled', 'mainTransients', 'transients'] as const) if (typeof source[key] === 'boolean') result[key] = source[key];
  if (source.tailVoice === 'hybrid' || source.tailVoice === 'recording') result.tailVoice = source.tailVoice;
  for (const name of audioChannels) {
    const gain = (source.channelVolumes as Record<string, unknown> | undefined)?.[name];
    if (typeof gain === 'number' && Number.isFinite(gain) && gain >= 0 && gain <= 200) result.channelVolumes[name] = gain;
    const enabled = (source.enabled as Record<string, unknown> | undefined)?.[name];
    if (typeof enabled === 'boolean') result.enabled[name] = enabled;
  }
  return result;
}
export function loadAudioProfile(storage: ProfileStorage | null): AudioProfile {
  try { return readAudioProfile(JSON.parse(storage?.getItem(audioStorageKey) ?? 'null')); }
  catch { return defaultAudioProfile(); }
}
export function saveAudioProfile(storage: ProfileStorage | null, profile: AudioProfile) {
  try { if (storage) { storage.setItem(audioStorageKey, JSON.stringify(profile)); return true; } }
  catch { /* Keep the current session usable when storage is unavailable. */ }
  return false;
}
