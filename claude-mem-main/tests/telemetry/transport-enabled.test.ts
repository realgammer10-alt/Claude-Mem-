import { describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const captures = mock(() => {});
const shutdown = mock(async () => {});

class MockPostHog {
  capture = captures;
  shutdown = shutdown;
}

mock.module('posthog-node', () => ({ PostHog: MockPostHog }));

const { captureEvent, shutdownTelemetry } = await import('../../src/services/telemetry/telemetry');

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return { lines, restore: () => { process.stderr.write = originalWrite; } };
}

describe('enabled telemetry transport lifecycle', () => {
  it('refreshes consent, flushes, and drops events after shutdown', async () => {
    const now = spyOn(Date, 'now').mockReturnValue(1_000_000);
    const previousConsent = process.env.CLAUDE_MEM_TELEMETRY;
    const previousDebug = process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
    const previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    const dataDir = join(tmpdir(), `telemetry-enabled-${Date.now()}`);
    mkdirSync(dataDir, { recursive: true });
    process.env.CLAUDE_MEM_TELEMETRY = '0';
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;

    try {
      captureEvent('worker_started');
      expect(captures).not.toHaveBeenCalled();

      process.env.CLAUDE_MEM_TELEMETRY = '1';
      now.mockReturnValue(1_030_001);
      captureEvent('worker_started');
      expect(captures).toHaveBeenCalledTimes(1);
      expect(existsSync(join(dataDir, 'telemetry.json'))).toBe(false);
      expect(existsSync(join(dataDir, 'telemetry-install-id.json'))).toBe(true);

      process.env.CLAUDE_MEM_TELEMETRY_DEBUG = '1';
      const stderr = captureStderr();
      try {
        captureEvent('search_performed', { query: '/private/path', outcome: 'ok' });
      } finally {
        stderr.restore();
      }
      const debugPayload = JSON.parse(stderr.lines[0].replace('[telemetry] ', '')) as {
        distinct_id: string;
        properties: Record<string, unknown>;
      };
      expect(debugPayload.distinct_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(debugPayload.properties.outcome).toBe('ok');
      expect(debugPayload.properties.query).toBeUndefined();
      expect(existsSync(join(dataDir, 'telemetry.json'))).toBe(false);

      await shutdownTelemetry();
      expect(shutdown).toHaveBeenCalledTimes(1);

      captureEvent('worker_started');
      expect(captures).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
      if (previousConsent === undefined) delete process.env.CLAUDE_MEM_TELEMETRY;
      else process.env.CLAUDE_MEM_TELEMETRY = previousConsent;
      if (previousDebug === undefined) delete process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
      else process.env.CLAUDE_MEM_TELEMETRY_DEBUG = previousDebug;
      if (previousDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
      else process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
