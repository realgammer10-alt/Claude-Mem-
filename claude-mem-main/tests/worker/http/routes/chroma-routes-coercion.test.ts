import { describe, expect, it } from 'bun:test';
import { isDeepProbeEnabled } from '../../../../src/services/worker/http/routes/ChromaRoutes.js';

describe('ChromaRoutes query coercion', () => {
  it('disables deep probing for repeated false values', () => {
    expect(isDeepProbeEnabled(['false', 'false'])).toBe(false);
  });

  it('preserves scalar deep flag behavior', () => {
    expect(isDeepProbeEnabled(undefined)).toBe(false);
    expect(isDeepProbeEnabled('false')).toBe(false);
    expect(isDeepProbeEnabled('0')).toBe(false);
    expect(isDeepProbeEnabled('true')).toBe(true);
  });
});