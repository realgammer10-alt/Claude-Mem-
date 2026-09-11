import { describe, expect, it } from 'bun:test';
import { logger } from '../../src/utils/logger.js';

describe('logger.formatTool', () => {
  it('handles JSON strings that parse to null or primitives', () => {
    expect(logger.formatTool('Read', 'null')).toBe('Read');
    expect(logger.formatTool('Read', '12345')).toBe('Read');
    expect(logger.formatTool('Read', '"text"')).toBe('Read');
  });
});