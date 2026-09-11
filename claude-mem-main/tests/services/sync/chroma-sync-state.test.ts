import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ChromaSyncState } from '../../../src/services/sync/ChromaSyncState.js';

const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
const tempDataDirs: string[] = [];

function createTempDataDir(): string {
  const dataDir = join(tmpdir(), `chroma-sync-state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dataDir, { recursive: true });
  tempDataDirs.push(dataDir);
  process.env.CLAUDE_MEM_DATA_DIR = dataDir;
  ChromaSyncState.resetCache();
  return dataDir;
}

afterEach(() => {
  ChromaSyncState.resetCache();
  for (const dataDir of tempDataDirs.splice(0)) {
    rmSync(dataDir, { recursive: true, force: true });
  }
  if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
});

describe('ChromaSyncState', () => {
  it('falls back to zero watermarks when the state file is malformed', () => {
    const dataDir = createTempDataDir();
    writeFileSync(join(dataDir, 'chroma-sync-state.json'), '{not-json', 'utf8');

    expect(() => ChromaSyncState.get('project')).not.toThrow();
    expect(ChromaSyncState.get('project')).toEqual({ observations: 0, summaries: 0, prompts: 0 });
  });

  it('falls back to zero watermarks when the state file is not an object', () => {
    const dataDir = createTempDataDir();
    writeFileSync(join(dataDir, 'chroma-sync-state.json'), '[]', 'utf8');

    expect(ChromaSyncState.get('project')).toEqual({ observations: 0, summaries: 0, prompts: 0 });
  });
});
