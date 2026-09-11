import { describe, expect, it } from 'bun:test';
import { SettingsManager } from '../../src/services/worker/SettingsManager.js';

function createManager(rows: Array<{ key: string; value: string }>): SettingsManager {
  const dbManager = {
    getSessionStore: () => ({
      db: {
        prepare: () => ({ all: () => rows })
      }
    })
  };
  return new SettingsManager(dbManager as any);
}

describe('SettingsManager', () => {
  it('preserves valid settings when another stored value is malformed', () => {
    const manager = createManager([
      { key: 'theme', value: '"dark"' },
      { key: 'sidebarOpen', value: 'not-json' },
      { key: 'selectedProject', value: '"project-a"' }
    ]);

    expect(manager.getSettings()).toEqual({
      sidebarOpen: true,
      selectedProject: 'project-a',
      theme: 'dark'
    });
  });

  it('ignores values with the wrong type', () => {
    const manager = createManager([
      { key: 'sidebarOpen', value: '"yes"' },
      { key: 'selectedProject', value: '42' },
      { key: 'theme', value: '"blue"' }
    ]);

    expect(manager.getSettings()).toEqual({
      sidebarOpen: true,
      selectedProject: null,
      theme: 'system'
    });
  });
});
