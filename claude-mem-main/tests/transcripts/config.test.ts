import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CODEX_SAMPLE_SCHEMA,
  SAMPLE_CONFIG,
  filterNativeHookBackedCodexWatches,
  loadTranscriptWatchConfig,
  isNativeHookBackedCodexWatch,
  shouldSuppressNativeCodexAgentsContext,
} from '../../src/services/transcripts/config.js';
import type { TranscriptWatchConfig } from '../../src/services/transcripts/types.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeConfig(value: unknown): string {
  const directory = join(tmpdir(), `transcript-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(directory, { recursive: true });
  tempDirs.push(directory);
  const configPath = join(directory, 'watch.json');
  writeFileSync(configPath, JSON.stringify(value), 'utf8');
  return configPath;
}

describe('transcript watcher config', () => {
  it('rejects a config whose watches field is not an array', () => {
    expect(() => loadTranscriptWatchConfig(writeConfig({ version: 1, watches: {} }))).toThrow(/Invalid transcript watch config/);
  });

  it('rejects configs with an unsupported version', () => {
    expect(() => loadTranscriptWatchConfig(writeConfig({ version: 2, watches: [] }))).toThrow(/Invalid transcript watch config/);
  });

  it('loads a valid config and supplies the default state path', () => {
    const config = loadTranscriptWatchConfig(writeConfig({ version: 1, watches: [] }));
    expect(config.version).toBe(1);
    expect(config.watches).toEqual([]);
    expect(config.stateFile).toBeTruthy();
  });

  it('does not auto-watch Codex transcripts in the sample config', () => {
    expect(SAMPLE_CONFIG.watches).toEqual([]);
  });

  it('recognizes the legacy Codex session transcript watch', () => {
    expect(isNativeHookBackedCodexWatch({
      name: 'codex',
      path: '~/.codex/sessions/**/*.jsonl',
      schema: 'codex',
    })).toBe(true);

    expect(isNativeHookBackedCodexWatch({
      name: 'codex',
      path: join(homedir(), '.codex', 'sessions', '**', '*.jsonl'),
      schema: CODEX_SAMPLE_SCHEMA,
    })).toBe(true);
  });

  it('does not treat custom transcript watches as native Codex hooks', () => {
    expect(isNativeHookBackedCodexWatch({
      name: 'codex-archive',
      path: '~/custom-codex-export/**/*.jsonl',
      schema: 'codex',
    })).toBe(false);

    expect(isNativeHookBackedCodexWatch({
      name: 'other',
      path: '~/.codex/sessions/**/*.jsonl',
      schema: 'other',
    })).toBe(false);
  });

  it('still treats canonical Codex paths as hook-backed when either name or schema is Codex', () => {
    expect(isNativeHookBackedCodexWatch({
      name: 'other',
      path: '~/.codex/sessions/**/*.jsonl',
      schema: 'codex',
    })).toBe(true);

    expect(isNativeHookBackedCodexWatch({
      name: 'codex',
      path: '~/.codex/sessions/**/*.jsonl',
      schema: 'custom-schema',
    })).toBe(true);
  });

  it('suppresses native Codex transcript AGENTS context updates', () => {
    expect(shouldSuppressNativeCodexAgentsContext({
      name: 'codex',
      schema: 'codex',
      path: '~/.codex/sessions/**/*.jsonl',
      context: {
        mode: 'agents',
      },
    })).toBe(true);
  });

  it('does not suppress non-native or non-Codex AGENTS context updates', () => {
    expect(shouldSuppressNativeCodexAgentsContext({
      name: 'codex-archive',
      schema: 'codex',
      path: '~/custom-codex-export/**/*.jsonl',
      context: {
        mode: 'agents',
      },
    })).toBe(false);

    expect(shouldSuppressNativeCodexAgentsContext({
      name: 'other',
      schema: 'codex',
      path: '~/.codex/sessions/**/*.jsonl',
      context: {
        mode: 'agents',
      },
    })).toBe(false);

    expect(shouldSuppressNativeCodexAgentsContext({
      name: 'codex',
      schema: 'codex',
      path: '~/.codex/sessions/**/*.jsonl',
      context: {
        mode: 'agents-legacy',
      },
    })).toBe(false);
  });

  it('strips legacy Codex watches unless explicitly opted in', () => {
    const config: TranscriptWatchConfig = {
      version: 1,
      schemas: {
        codex: CODEX_SAMPLE_SCHEMA,
      },
      watches: [
        {
          name: 'codex',
          path: '~/.codex/sessions/**/*.jsonl',
          schema: 'codex',
          startAtEnd: true,
        },
        {
          name: 'custom',
          path: '~/custom/**/*.jsonl',
          schema: 'codex',
          startAtEnd: true,
        },
      ],
    };

    const filtered = filterNativeHookBackedCodexWatches(config, false);
    expect(filtered.removed).toBe(1);
    expect(filtered.config.watches.map(watch => watch.name)).toEqual(['custom']);

    const allowed = filterNativeHookBackedCodexWatches(config, true);
    expect(allowed.removed).toBe(0);
    expect(allowed.config.watches).toHaveLength(2);
  });
});
