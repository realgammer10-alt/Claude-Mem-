import { describe, expect, it } from 'bun:test';

const { getNpmCommand, getMarketplaceDir } = await import('../scripts/dev-sync.cjs');

describe('dev sync helper', () => {
  it('uses npm.cmd on Windows and npm elsewhere', () => {
    expect(getNpmCommand()).toBe(process.platform === 'win32' ? 'npm.cmd' : 'npm');
  });

  it('resolves the marketplace path under the user home directory', () => {
    const home = process.env.USERPROFILE || process.env.HOME || 'C:/Users/Sony';
    expect(getMarketplaceDir(home)).toBe(`${home.replace(/\\/g, '/')}/.claude/plugins/marketplaces/thedotmack`.replace(/\/+$/g, '').replace(/\//g, '\\'));
  });
});
