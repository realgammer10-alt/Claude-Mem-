import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { writeAgentsMd } from '../../src/utils/agents-md-utils.js';

describe('writeAgentsMd', () => {
  it('writes BMP-safe context content', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'cm-agents-'));
    const filePath = path.join(directory, 'AGENTS.md');

    try {
      writeAgentsMd(filePath, 'memory 🔴 and 🦄');
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, 'utf-8')).toContain('memory ● and •');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});