import { describe, expect, it } from 'bun:test';
import { logger } from '../../src/utils/logger.js';

describe('logger circular data handling', () => {
  it('does not throw when logging a circular object', () => {
    const data: { name: string; self?: unknown } = { name: 'circular' };
    data.self = data;

    expect(() => logger.info('SYSTEM', 'circular payload', undefined, data)).not.toThrow();
  });
});