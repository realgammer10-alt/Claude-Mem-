import { describe, expect, it } from 'bun:test';
import { isStrictIntegerInRange } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';

describe('SettingsRoutes numeric validation', () => {
  it('rejects partially parsed and unsafe values', () => {
    expect(isStrictIntegerInRange('50', 1, 200)).toBe(true);
    expect(isStrictIntegerInRange('50items', 1, 200)).toBe(false);
    expect(isStrictIntegerInRange('-1', 0, 20)).toBe(false);
    expect(isStrictIntegerInRange('201', 1, 200)).toBe(false);
    expect(isStrictIntegerInRange('9007199254740992', 1, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});