import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CorpusStore } from '../../../src/services/worker/knowledge/CorpusStore.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): { store: CorpusStore; directory: string } {
  const directory = join(tmpdir(), `corpus-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(directory, { recursive: true });
  tempDirs.push(directory);

  const store = new CorpusStore();
  (store as unknown as { corporaDir: string }).corporaDir = directory;
  return { store, directory };
}

describe('CorpusStore', () => {
  it('returns null for a valid JSON file with an invalid corpus shape', () => {
    const { store, directory } = createStore();
    writeFileSync(join(directory, 'broken.corpus.json'), JSON.stringify({ observations: 'not-an-array' }), 'utf8');

    expect(store.read('broken')).toBeNull();
  });

  it('skips malformed corpus shapes when listing files', () => {
    const { store, directory } = createStore();
    writeFileSync(join(directory, 'broken.corpus.json'), JSON.stringify({ version: 1, name: 'broken' }), 'utf8');

    expect(store.list()).toEqual([]);
  });
});
