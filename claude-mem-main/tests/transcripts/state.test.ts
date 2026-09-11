import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadWatchState } from '../../src/services/transcripts/state.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeState(value: unknown): string {
  const directory = join(tmpdir(), `transcript-state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(directory, { recursive: true });
  tempDirs.push(directory);
  const statePath = join(directory, 'state.json');
  writeFileSync(statePath, JSON.stringify(value), 'utf8');
  return statePath;
}

describe('transcript watch state', () => {
  it('keeps finite nonnegative offsets and drops malformed values', () => {
    const statePath = writeState({
      offsets: {
        '/valid.jsonl': 42,
        '/negative.jsonl': -1,
        '/string.jsonl': '43',
        '/infinite.jsonl': null,
        '/object.jsonl': {}
      }
    });

    expect(loadWatchState(statePath)).toEqual({
      offsets: { '/valid.jsonl': 42 }
    });
  });

  it('falls back to an empty state when offsets is not an object', () => {
    expect(loadWatchState(writeState({ offsets: 'invalid' }))).toEqual({ offsets: {} });
    expect(loadWatchState(writeState([]))).toEqual({ offsets: {} });
  });
});
