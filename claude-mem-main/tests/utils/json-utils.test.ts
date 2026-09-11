import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { readJsonSafe } from '../../src/utils/json-utils.js';

describe('readJsonSafe', () => {
  it('returns the default for a missing file', () => {
    expect(readJsonSafe(path.join(tmpdir(), 'missing-claude-mem.json'), { enabled: false })).toEqual({ enabled: false });
  });

  it('parses JSON files with a UTF-8 BOM', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'cm-json-'));
    const filePath = path.join(directory, 'settings.json');

    try {
      writeFileSync(filePath, '\uFEFF{"enabled":true}', 'utf-8');
      expect(readJsonSafe(filePath, { enabled: false })).toEqual({ enabled: true });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('throws without overwriting corrupt JSON', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'cm-json-'));
    const filePath = path.join(directory, 'settings.json');

    try {
      writeFileSync(filePath, '{not-json}', 'utf-8');
      expect(() => readJsonSafe(filePath, { enabled: false })).toThrow(/Corrupt JSON file/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});