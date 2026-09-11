
import { DatabaseManager } from './DatabaseManager.js';
import { logger } from '../../utils/logger.js';
import type { ViewerSettings } from '../worker-types.js';

function isViewerSettingValue(key: keyof ViewerSettings, value: unknown): boolean {
  if (key === 'sidebarOpen') return typeof value === 'boolean';
  if (key === 'selectedProject') return value === null || typeof value === 'string';
  return value === 'light' || value === 'dark' || value === 'system';
}

export class SettingsManager {
  private dbManager: DatabaseManager;
  private readonly defaultSettings: ViewerSettings = {
    sidebarOpen: true,
    selectedProject: null,
    theme: 'system'
  };

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  getSettings(): ViewerSettings {
    const db = this.dbManager.getSessionStore().db;

    try {
      const stmt = db.prepare('SELECT key, value FROM viewer_settings');
      const rows = stmt.all() as Array<{ key: string; value: string }>;

      const settings: ViewerSettings = { ...this.defaultSettings };
      for (const row of rows) {
        const key = row.key as keyof ViewerSettings;
        if (key in settings) {
          try {
            const value: unknown = JSON.parse(row.value);
            if (isViewerSettingValue(key, value)) {
              if (key === 'sidebarOpen') {
                settings.sidebarOpen = value as boolean;
              } else if (key === 'selectedProject') {
                settings.selectedProject = value as string | null;
              } else {
                settings.theme = value as ViewerSettings['theme'];
              }
            }
          } catch (error) {
            logger.debug('WORKER', 'Ignoring malformed viewer setting', {
              key,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }

      return settings;
    } catch (error) {
      if (error instanceof Error) {
        logger.debug('WORKER', 'Failed to load settings, using defaults', {}, error);
      } else {
        logger.debug('WORKER', 'Failed to load settings, using defaults', { rawError: String(error) });
      }
      return { ...this.defaultSettings };
    }
  }

  updateSettings(updates: Partial<ViewerSettings>): ViewerSettings {
    const db = this.dbManager.getSessionStore().db;

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO viewer_settings (key, value)
      VALUES (?, ?)
    `);

    for (const [key, value] of Object.entries(updates)) {
      stmt.run(key, JSON.stringify(value));
    }

    return this.getSettings();
  }
}
