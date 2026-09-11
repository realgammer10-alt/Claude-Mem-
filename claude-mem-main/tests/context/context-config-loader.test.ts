import { describe, expect, it } from 'bun:test';
import { parseContextCount } from '../../src/services/context/ContextConfigLoader.js';

describe('context count parsing', () => {
  it('rejects partially parsed and unsafe values while allowing zero', () => {
    expect(parseContextCount('25', 50)).toBe(25);
    expect(parseContextCount('25junk', 50)).toBe(50);
    expect(parseContextCount('-1', 50)).toBe(50);
    expect(parseContextCount('0', 50)).toBe(0);
    expect(parseContextCount('9007199254740992', 50)).toBe(50);
  });
});