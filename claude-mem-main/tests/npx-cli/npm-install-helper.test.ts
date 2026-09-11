import { describe, expect, it } from 'bun:test';
import {
  extractEresolveBlock,
  isEresolve,
  resolveInstallTimeoutMs,
} from '../../src/npx-cli/install/npm-install-helper.js';

describe('npm install helper policy', () => {
  it('detects ERESOLVE conflicts from npm stderr', () => {
    expect(isEresolve('npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree')).toBe(true);
    expect(isEresolve('npm error code ENETUNREACH')).toBe(false);
  });

  it('extracts the readable ERESOLVE conflict block', () => {
    const stderr = [
      'npm error code ERESOLVE',
      'npm error While resolving: claude-mem@13.5.0',
      'npm error Found: tree-sitter@0.24.0',
      'npm error Could not resolve dependency:',
    ].join('\n');

    expect(extractEresolveBlock(stderr)).toBe([
      'While resolving: claude-mem@13.5.0',
      'Found: tree-sitter@0.24.0',
      'Could not resolve dependency:',
    ].join('\n'));
  });

  it('returns all stderr when npm omits the standard conflict marker', () => {
    expect(extractEresolveBlock('npm error ERESOLVE unable to resolve')).toBe(
      'npm error ERESOLVE unable to resolve',
    );
  });

  it('uses the first-run timeout by default and honors the override', () => {
    const original = process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS;
    delete process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS;

    try {
      expect(resolveInstallTimeoutMs(true)).toBe(5 * 60 * 1000);
      expect(resolveInstallTimeoutMs(false)).toBe(2 * 60 * 1000);

      process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = '1500';
      expect(resolveInstallTimeoutMs(true)).toBe(1500);
      expect(resolveInstallTimeoutMs(false)).toBe(1500);
    } finally {
      if (original === undefined) {
        delete process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS;
      } else {
        process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = original;
      }
    }
  });
});
