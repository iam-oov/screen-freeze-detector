import type { Bbox } from './domain.ts';

export interface ZonePrefs {
  name: string;
  bbox: Bbox;
  enabled: boolean;
  soundEnabled: boolean;
  injectEnabled: boolean;
  telegramEnabled: boolean;
  photoBbox: Bbox | null;
}

export interface Prefs {
  threshold: number;
  intervalMs: number;
  consec: number;
  volume: number;
  defocusPoint: { x: number; y: number } | null;
  zones: ZonePrefs[];
}

export interface PreferencesStore {
  load(): Promise<Prefs | null>;
  save(prefs: Prefs): Promise<void>;
}

export class DiskPreferencesStore implements PreferencesStore {
  async load(): Promise<Prefs | null> {
    return (await window.spike.getSettings()) as Prefs | null;
  }
  async save(prefs: Prefs): Promise<void> {
    await window.spike.saveSettings(prefs);
  }
}
