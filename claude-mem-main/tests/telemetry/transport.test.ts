import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { captureEvent } from '../../src/services/telemetry/telemetry';

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  return {
    lines,
    restore: () => {
      process.stderr.write = originalWrite;
    },
  };
}

describe('telemetry transports', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let previousConsent: string | undefined;
  let previousDebug: string | undefined;

  beforeEach(() => {
    dataDir = join(tmpdir(), `telemetry-transport-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dataDir, { recursive: true });
    previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    previousConsent = process.env.CLAUDE_MEM_TELEMETRY;
    previousDebug = process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
    process.env.CLAUDE_MEM_DATA_DIR = dataDir;
    delete process.env.CLAUDE_MEM_TELEMETRY;
    delete process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
    if (previousConsent === undefined) delete process.env.CLAUDE_MEM_TELEMETRY;
    else process.env.CLAUDE_MEM_TELEMETRY = previousConsent;
    if (previousDebug === undefined) delete process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
    else process.env.CLAUDE_MEM_TELEMETRY_DEBUG = previousDebug;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps the worker transport silent by default', () => {
    const stderr = captureStderr();

    try {
      captureEvent('worker_started');
    } finally {
      stderr.restore();
    }

    expect(stderr.lines).toEqual([]);
  });
});
