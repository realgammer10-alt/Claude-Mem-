import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../../utils/logger.js';

export interface TranscriptWatchState {
  offsets: Record<string, number>;
}

export function loadWatchState(statePath: string): TranscriptWatchState {
  try {
    if (!existsSync(statePath)) {
      return { offsets: {} };
    }
    const raw = readFileSync(statePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { offsets: {} };
    }

    const offsets = (parsed as { offsets?: unknown }).offsets;
    if (!offsets || typeof offsets !== 'object' || Array.isArray(offsets)) {
      return { offsets: {} };
    }

    const normalized: Record<string, number> = {};
    for (const [filePath, value] of Object.entries(offsets)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        normalized[filePath] = value;
      }
    }
    return { offsets: normalized };
  } catch (error) {
    logger.warn('TRANSCRIPT', 'Failed to load watch state, starting fresh', {
      statePath,
      error: error instanceof Error ? error.message : String(error)
    });
    return { offsets: {} };
  }
}

export function saveWatchState(statePath: string, state: TranscriptWatchState): void {
  try {
    const dir = dirname(statePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch (error) {
    logger.warn('TRANSCRIPT', 'Failed to save watch state', {
      statePath,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
