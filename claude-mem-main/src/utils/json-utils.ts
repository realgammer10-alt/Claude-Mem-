
import { existsSync, readFileSync } from 'fs';
import { logger } from './logger.js';

export function readJsonSafe<T>(filePath: string, defaultValue: T): T {
  if (!existsSync(filePath)) return defaultValue;
  try {
    const content = readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
    return JSON.parse(content);
  } catch (error: unknown) {
    throw new Error(`Corrupt JSON file, refusing to overwrite: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
