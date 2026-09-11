import { describe, expect, it } from 'bun:test';
import {
  getServerBetaPort,
  parseBoundedInteger,
} from '../../../src/server/runtime/ServerBetaService.js';

describe('server beta port configuration', () => {
  it('rejects malformed and out-of-range values', () => {
    const previous = process.env.CLAUDE_MEM_SERVER_PORT;
    const fallback = 37877 + ((process.getuid?.() ?? 77) % 100);
    try {
      process.env.CLAUDE_MEM_SERVER_PORT = '37877';
      expect(getServerBetaPort()).toBe(37877);
      process.env.CLAUDE_MEM_SERVER_PORT = '37877junk';
      expect(getServerBetaPort()).toBe(fallback);
      process.env.CLAUDE_MEM_SERVER_PORT = '65536';
      expect(getServerBetaPort()).toBe(fallback);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MEM_SERVER_PORT;
      else process.env.CLAUDE_MEM_SERVER_PORT = previous;
    }
  });

  it('rejects partially parsed pagination values', () => {
    expect(parseBoundedInteger('25', 50, 1, 500)).toBe(25);
    expect(parseBoundedInteger('25junk', 50, 1, 500)).toBe(50);
    expect(parseBoundedInteger('0', 50, 1, 500)).toBe(50);
    expect(parseBoundedInteger('501', 50, 1, 500)).toBe(50);
  });
});