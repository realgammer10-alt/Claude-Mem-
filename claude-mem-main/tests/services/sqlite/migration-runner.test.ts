import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { EXPECTED_SCHEMA_VERSIONS, MigrationRunner } from '../../../src/services/sqlite/migrations/runner.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { logger } from '../../../src/utils/logger.js';
import { spyOn } from 'bun:test';

interface TableNameRow {
  name: string;
}

interface TableColumnInfo {
  name: string;
  type: string;
  notnull: number;
}

interface IndexInfo {
  name: string;
}

interface SchemaVersion {
  version: number;
}

interface ForeignKeyInfo {
  table: string;
  on_update: string;
  on_delete: string;
}

function getTableNames(db: Database): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as TableNameRow[];
  return rows.map(r => r.name);
}

function getColumns(db: Database, table: string): TableColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as TableColumnInfo[];
}

function getSchemaVersions(db: Database): number[] {
  const rows = db.prepare('SELECT version FROM schema_versions ORDER BY version').all() as SchemaVersion[];
  return rows.map(r => r.version);
}

function getIndexNames(db: Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA index_list(${table})`).all() as IndexInfo[];
  return rows.map(r => r.name);
}

describe('MigrationRunner', () => {
  let db: Database;
  let infoSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    db = new Database(':memory:');
    infoSpy = spyOn(logger, 'info').mockImplementation(() => {});
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    infoSpy.mockRestore();
    db.close();
  });

  describe('fresh database initialization', () => {
    it('should create all core tables on a fresh database', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const tables = getTableNames(db);
      expect(tables).toContain('schema_versions');
      expect(tables).toContain('sdk_sessions');
      expect(tables).toContain('observations');
      expect(tables).toContain('session_summaries');
      expect(tables).toContain('user_prompts');
      expect(tables).toContain('pending_messages');
      expect(tables).toContain('projects');
      expect(tables).toContain('server_sessions');
      expect(tables).toContain('agent_events');
      expect(tables).toContain('memory_items');
      expect(tables).toContain('memory_sources');
      expect(tables).toContain('teams');
      expect(tables).toContain('team_members');
      expect(tables).toContain('api_keys');
      expect(tables).toContain('audit_log');
    });

    it('logs a schema-version audit after migrations complete', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      expect(infoSpy).toHaveBeenCalledWith(
        'DB',
        'Schema migration audit complete',
        expect.objectContaining({
          expectedLatestVersion: 34,
          missingVersions: [],
        }),
      );
      expect(EXPECTED_SCHEMA_VERSIONS).toContain(33);
    });

    it('should create sdk_sessions with all expected columns', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const columns = getColumns(db, 'sdk_sessions');
      const columnNames = columns.map(c => c.name);

      expect(columnNames).toContain('id');
      expect(columnNames).toContain('content_session_id');
      expect(columnNames).toContain('memory_session_id');
      expect(columnNames).toContain('project');
      expect(columnNames).toContain('status');
      expect(columnNames).toContain('worker_port');
      expect(columnNames).toContain('prompt_counter');
    });

    it('should create observations with all expected columns including content_hash', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const columns = getColumns(db, 'observations');
      const columnNames = columns.map(c => c.name);

      expect(columnNames).toContain('id');
      expect(columnNames).toContain('memory_session_id');
      expect(columnNames).toContain('project');
      expect(columnNames).toContain('type');
      expect(columnNames).toContain('title');
      expect(columnNames).toContain('narrative');
      expect(columnNames).toContain('prompt_number');
      expect(columnNames).toContain('discovery_tokens');
      expect(columnNames).toContain('content_hash');
    });

    it('should record all migration versions', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const versions = getSchemaVersions(db);
      expect(versions).toContain(4);   
      expect(versions).toContain(5);   
      expect(versions).toContain(6);   
      expect(versions).toContain(7);   
      expect(versions).toContain(8);   
      expect(versions).toContain(9);   
      expect(versions).toContain(10);  
      expect(versions).toContain(11);  
      expect(versions).toContain(16);  
      expect(versions).toContain(17);  
      expect(versions).toContain(20);  
      expect(versions).toContain(21);  
      expect(versions).toContain(22);  
      expect(versions).toContain(30);  
      expect(versions).toContain(33);
      expect(versions).toContain(34);
    });

    it('should create server-owned storage tables without changing legacy readability', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const now = new Date().toISOString();
      const epoch = Date.now();

      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('content-readable', 'memory-readable', 'legacy-project', now, epoch, 'active');

      db.prepare(`
        INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('memory-readable', 'legacy-project', 'learned', 'Legacy observation', 'Still queryable', now, epoch);

      const observation = db.prepare('SELECT title, narrative FROM observations WHERE memory_session_id = ?').get('memory-readable') as { title: string; narrative: string };
      expect(observation.title).toBe('Legacy observation');
      expect(observation.narrative).toBe('Still queryable');

      const memoryItems = db.prepare('SELECT COUNT(*) as count FROM memory_items').get() as { count: number };
      expect(memoryItems.count).toBe(0);
    });

    it('should tighten legacy pending_messages status checks from old migration 28 databases', () => {
      db.run(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);

      db.run(`
        CREATE TABLE sdk_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content_session_id TEXT UNIQUE NOT NULL,
          memory_session_id TEXT UNIQUE,
          project TEXT NOT NULL,
          platform_source TEXT NOT NULL DEFAULT 'claude',
          user_prompt TEXT,
          started_at TEXT NOT NULL,
          started_at_epoch INTEGER NOT NULL,
          completed_at TEXT,
          completed_at_epoch INTEGER,
          status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active'
        )
      `);

      db.run(`
        CREATE TABLE pending_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_db_id INTEGER NOT NULL,
          content_session_id TEXT NOT NULL,
          tool_use_id TEXT,
          message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
          retry_count INTEGER NOT NULL DEFAULT 0,
          created_at_epoch INTEGER NOT NULL,
          completed_at_epoch INTEGER,
          worker_pid INTEGER
        )
      `);

      const now = new Date().toISOString();
      db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(28, now);
      const sessionId = Number(db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch)
        VALUES ('legacy-content', 'legacy-project', ?, ?)
      `).run(now, Date.now()).lastInsertRowid);
      db.prepare(`
        INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch)
        VALUES (?, 'legacy-content', 'observation', 'pending', ?)
      `).run(sessionId, Date.now());
      db.prepare(`
        INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch)
        VALUES (?, 'legacy-content', 'observation', 'failed', ?)
      `).run(sessionId, Date.now());

      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const pendingRows = db.prepare('SELECT COUNT(*) AS count FROM pending_messages').get() as { count: number };
      expect(pendingRows.count).toBe(1);
      const columns = getColumns(db, 'pending_messages').map(column => column.name);
      expect(columns).not.toContain('retry_count');
      expect(columns).not.toContain('completed_at_epoch');
      expect(columns).not.toContain('worker_pid');

      expect(() => db.prepare(`
        INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch)
        VALUES (?, 'legacy-content', 'observation', 'failed', ?)
      `).run(sessionId, Date.now())).toThrow();
    });

    it('should restore tool_use_id even when migration 28 is already marked applied', { timeout: 30000 }, () => {
      const directory = mkdtempSync(path.join(tmpdir(), 'pending-schema-'));
      const dbPath = path.join(directory, 'claude-mem.db');
      const legacyDb = new Database(dbPath);
      legacyDb.run(`
        CREATE TABLE schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      legacyDb.run(`
        CREATE TABLE pending_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_db_id INTEGER NOT NULL,
          content_session_id TEXT NOT NULL,
          message_type TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL
        )
      `);
      legacyDb.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)')
        .run(28, new Date().toISOString());
      legacyDb.close();

      const store = new SessionStore(dbPath);

      const columns = getColumns(store.db, 'pending_messages').map(column => column.name);
      expect(columns).toContain('tool_use_id');
      store.close();
    });

    it('should repair tool_use_id when migration 29 is recorded but migration 28 was skipped', { timeout: 30000 }, () => {
      const directory = mkdtempSync(path.join(tmpdir(), 'pending-schema-v29-'));
      const dbPath = path.join(directory, 'claude-mem.db');
      const legacyDb = new Database(dbPath);
      legacyDb.run(`
        CREATE TABLE schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      legacyDb.run(`
        CREATE TABLE pending_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_db_id INTEGER NOT NULL,
          content_session_id TEXT NOT NULL,
          message_type TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL
        )
      `);
      legacyDb.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)')
        .run(29, new Date().toISOString());
      legacyDb.close();

      const store = new SessionStore(dbPath);

      const columns = getColumns(store.db, 'pending_messages').map(column => column.name);
      expect(columns).toContain('tool_use_id');
      expect(columns).not.toContain('worker_pid');
      expect(getIndexNames(store.db, 'pending_messages')).toContain('ux_pending_session_tool');
      store.close();
    });

    it('should restore tool_use_id when migration 28 is already marked applied', () => {
      db.run(`
        CREATE TABLE schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      db.run(`
        CREATE TABLE pending_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_db_id INTEGER NOT NULL,
          content_session_id TEXT NOT NULL,
          message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing')),
          created_at_epoch INTEGER NOT NULL
        )
      `);
      db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)')
        .run(28, new Date().toISOString());

      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const columns = getColumns(db, 'pending_messages').map(column => column.name);
      expect(columns).toContain('tool_use_id');
    });

    it('should restore the pending-message uniqueness index when migration 34 is already marked applied', () => {
      db.run(`
        CREATE TABLE schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      db.run(`
        CREATE TABLE pending_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_db_id INTEGER NOT NULL,
          content_session_id TEXT NOT NULL,
          tool_use_id TEXT,
          message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing')),
          created_at_epoch INTEGER NOT NULL
        )
      `);
      db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)')
        .run(34, new Date().toISOString());

      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const indexes = getIndexNames(db, 'pending_messages');
      expect(indexes).toContain('ux_pending_session_tool');

      const now = new Date().toISOString();
      const sessionId = Number(db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch)
        VALUES ('index-content', 'index-project', ?, ?)
      `).run(now, Date.now()).lastInsertRowid);
      const insert = db.prepare(`
        INSERT INTO pending_messages (session_db_id, content_session_id, tool_use_id, message_type, created_at_epoch)
        VALUES (?, 'index-content', 'tool-1', 'observation', ?)
      `);
      insert.run(sessionId, Date.now());
      expect(() => insert.run(sessionId, Date.now())).toThrow();
    });

    it('should restore the pending-message cascade foreign key when migrations 28 and 34 are already marked applied', () => {
      db.run(`
        CREATE TABLE schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      db.run(`
        CREATE TABLE pending_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_db_id INTEGER NOT NULL,
          content_session_id TEXT NOT NULL,
          tool_use_id TEXT,
          message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing')),
          created_at_epoch INTEGER NOT NULL
        )
      `);
      const now = new Date().toISOString();
      db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(28, now);
      db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(34, now);

      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const foreignKeys = db.query('PRAGMA foreign_key_list(pending_messages)').all() as ForeignKeyInfo[];
      expect(foreignKeys).toContainEqual(expect.objectContaining({
        table: 'sdk_sessions',
        from: 'session_db_id',
        to: 'id',
        on_delete: 'CASCADE',
      }));
    });

    it('should keep retired pending-message columns out of the current schema', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const columns = getColumns(db, 'pending_messages').map(column => column.name);
      expect(columns).toContain('tool_use_id');
      expect(columns).not.toContain('worker_pid');
      expect(columns).not.toContain('retry_count');
      expect(columns).not.toContain('failed_at_epoch');
      expect(columns).not.toContain('completed_at_epoch');
    });
  });

  describe('idempotency — running migrations twice', () => {
    it('should succeed when run twice on the same database', () => {
      const runner = new MigrationRunner(db);

      runner.runAllMigrations();

      expect(() => runner.runAllMigrations()).not.toThrow();
    });

    it('should produce identical schema when run twice', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const tablesAfterFirst = getTableNames(db);
      const versionsAfterFirst = getSchemaVersions(db);

      runner.runAllMigrations();

      const tablesAfterSecond = getTableNames(db);
      const versionsAfterSecond = getSchemaVersions(db);

      expect(tablesAfterSecond).toEqual(tablesAfterFirst);
      expect(versionsAfterSecond).toEqual(versionsAfterFirst);
    });
  });

  describe('migration 29 legacy NULL content_hash handling', () => {
    it('should restore the content-hash uniqueness index when migration 29 is already marked applied', () => {
      db.run(`
        CREATE TABLE schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      db.run(`
        CREATE TABLE observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          text TEXT,
          type TEXT NOT NULL,
          content_hash TEXT,
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL
        )
      `);
      db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)')
        .run(29, new Date().toISOString());

      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const indexes = getIndexNames(db, 'observations');
      expect(indexes).toContain('ux_observations_session_hash');
    });

    it('should preserve legacy NULL-hash observations while deduplicating non-NULL duplicates', () => {
      db.run(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS sdk_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content_session_id TEXT UNIQUE NOT NULL,
          memory_session_id TEXT UNIQUE,
          project TEXT NOT NULL,
          platform_source TEXT NOT NULL DEFAULT 'claude',
          user_prompt TEXT,
          started_at TEXT NOT NULL,
          started_at_epoch INTEGER NOT NULL,
          completed_at TEXT,
          completed_at_epoch INTEGER,
          status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active'
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          text TEXT,
          type TEXT NOT NULL,
          title TEXT,
          subtitle TEXT,
          facts TEXT,
          narrative TEXT,
          concepts TEXT,
          files_read TEXT,
          files_modified TEXT,
          prompt_number INTEGER,
          discovery_tokens INTEGER DEFAULT 0,
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          content_hash TEXT,
          FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
        )
      `);

      const now = new Date().toISOString();
      const epoch = Date.now();
      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run('content-a', 'session-a', 'legacy-project', now, epoch);
      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, 'active')
      `).run('content-b', 'session-b', 'legacy-project', now, epoch + 1);

      db.prepare(`
        INSERT INTO schema_versions (version, applied_at)
        VALUES (22, ?)
      `).run(now);

      db.prepare(`
        INSERT INTO observations (memory_session_id, project, type, created_at, created_at_epoch, content_hash)
        VALUES (?, ?, 'discovery', ?, ?, ?)
      `).run('session-a', 'legacy-project', now, epoch, null);
      db.prepare(`
        INSERT INTO observations (memory_session_id, project, type, created_at, created_at_epoch, content_hash)
        VALUES (?, ?, 'discovery', ?, ?, ?)
      `).run('session-a', 'legacy-project', now, epoch + 1, null);
      db.prepare(`
        INSERT INTO observations (memory_session_id, project, type, created_at, created_at_epoch, content_hash)
        VALUES (?, ?, 'discovery', ?, ?, ?)
      `).run('session-a', 'legacy-project', now, epoch + 2, null);
      db.prepare(`
        INSERT INTO observations (memory_session_id, project, type, created_at, created_at_epoch, content_hash)
        VALUES (?, ?, 'discovery', ?, ?, ?)
      `).run('session-b', 'legacy-project', now, epoch + 3, null);
      db.prepare(`
        INSERT INTO observations (memory_session_id, project, type, created_at, created_at_epoch, content_hash)
        VALUES (?, ?, 'discovery', ?, ?, ?)
      `).run('session-b', 'legacy-project', now, epoch + 4, null);
      db.prepare(`
        INSERT INTO observations (memory_session_id, project, type, created_at, created_at_epoch, content_hash)
        VALUES (?, ?, 'discovery', ?, ?, ?)
      `).run('session-a', 'legacy-project', now, epoch + 5, 'non-null-duplicate');
      db.prepare(`
        INSERT INTO observations (memory_session_id, project, type, created_at, created_at_epoch, content_hash)
        VALUES (?, ?, 'discovery', ?, ?, ?)
      `).run('session-a', 'legacy-project', now, epoch + 6, 'non-null-duplicate');

      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const totals = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
      expect(totals.count).toBe(6);

      const remainingNulls = db.prepare('SELECT COUNT(*) as count FROM observations WHERE content_hash IS NULL').get() as { count: number };
      expect(remainingNulls.count).toBe(0);

      const sessionANulls = db.prepare(`
        SELECT COUNT(*) as count
          FROM observations
         WHERE memory_session_id = 'session-a'
           AND content_hash GLOB '__null_migration_*__'
      `).get() as { count: number };
      expect(sessionANulls.count).toBe(3);
      const sessionBNulls = db.prepare(`
        SELECT COUNT(*) as count
          FROM observations
         WHERE memory_session_id = 'session-b'
           AND content_hash GLOB '__null_migration_*__'
      `).get() as { count: number };
      expect(sessionBNulls.count).toBe(2);

      const duplicateHashRows = db.prepare(`
        SELECT COUNT(*) as count
          FROM observations
         WHERE memory_session_id = 'session-a'
           AND content_hash = 'non-null-duplicate'
      `).get() as { count: number };
      expect(duplicateHashRows.count).toBe(1);

      const indexNames = getIndexNames(db, 'observations');
      expect(indexNames).toContain('ux_observations_session_hash');
    });
  });

  describe('schema drift recovery for migration 24', () => {
    it('should repair a malformed memory legacy-observation index', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('DROP INDEX idx_memory_items_legacy_observation');
      db.run('CREATE INDEX idx_memory_items_legacy_observation ON memory_items(kind)');

      runner.runAllMigrations();

      const columns = db
        .query('PRAGMA index_info(idx_memory_items_legacy_observation)')
        .all() as Array<{ name: string | null }>;
      expect(columns.map(column => column.name)).toEqual(['legacy_observation_id']);
    });

    it('should repair a malformed agent-event type index', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('DROP INDEX idx_agent_events_type');
      db.run('CREATE INDEX idx_agent_events_type ON agent_events(payload)');

      runner.runAllMigrations();

      const columns = db
        .query('PRAGMA index_info(idx_agent_events_type)')
        .all() as Array<{ name: string | null }>;
      expect(columns.map(column => column.name)).toEqual(['event_type']);
    });

    it('should repair a malformed project root-path index', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('DROP INDEX idx_projects_root_path');
      db.run('CREATE INDEX idx_projects_root_path ON projects(name)');

      runner.runAllMigrations();

      const columns = db
        .query('PRAGMA index_info(idx_projects_root_path)')
        .all() as Array<{ name: string | null }>;
      expect(columns.map(column => column.name)).toEqual(['root_path']);
    });

    it('should repair a malformed server-session status index', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('DROP INDEX idx_server_sessions_status');
      db.run('CREATE INDEX idx_server_sessions_status ON server_sessions(project_id)');

      runner.runAllMigrations();

      const columns = db
        .query('PRAGMA index_info(idx_server_sessions_status)')
        .all() as Array<{ name: string | null }>;
      expect(columns.map(column => column.name)).toEqual(['status']);
    });

    it('should repair a malformed server-session memory index', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('DROP INDEX idx_server_sessions_memory');
      db.run('CREATE INDEX idx_server_sessions_memory ON server_sessions(status)');

      runner.runAllMigrations();

      const columns = db
        .query('PRAGMA index_info(idx_server_sessions_memory)')
        .all() as Array<{ name: string | null }>;
      expect(columns.map(column => column.name)).toEqual(['memory_session_id']);
    });

    it('should repair a malformed server-session content index', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('DROP INDEX idx_server_sessions_content');
      db.run('CREATE INDEX idx_server_sessions_content ON server_sessions(status)');

      runner.runAllMigrations();

      const columns = db
        .query('PRAGMA index_info(idx_server_sessions_content)')
        .all() as Array<{ name: string | null }>;
      expect(columns.map(column => column.name)).toEqual(['content_session_id']);
    });

    it('should repair a malformed server-session project index', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('DROP INDEX idx_server_sessions_project');
      db.run('CREATE INDEX idx_server_sessions_project ON server_sessions(status)');

      runner.runAllMigrations();

      const columns = db
        .query('PRAGMA index_info(idx_server_sessions_project)')
        .all() as Array<{ name: string | null }>;
      expect(columns.map(column => column.name)).toEqual(['project_id']);
    });

    it('should restore the memory-item FTS delete trigger', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('DROP TRIGGER trg_memory_items_fts_delete');
      db.run(`
        CREATE TRIGGER trg_memory_items_fts_delete
        AFTER DELETE ON memory_items
        BEGIN
          SELECT RAISE(ABORT, 'stale trigger');
        END
      `);

      runner.runAllMigrations();

      db.run(`
        INSERT INTO projects (id, name, created_at_epoch, updated_at_epoch)
        VALUES ('fts-delete-project', 'FTS Delete Project', 1, 1)
      `);
      db.run(`
        INSERT INTO memory_items (
          id, project_id, kind, type, title, created_at_epoch, updated_at_epoch
        ) VALUES ('fts-delete-memory', 'fts-delete-project', 'manual', 'note', 'Delete me', 1, 1)
      `);
      db.run(`DELETE FROM memory_items WHERE id = 'fts-delete-memory'`);

      const ftsRow = db.prepare(`
        SELECT memory_item_id FROM memory_items_fts WHERE memory_item_id = 'fts-delete-memory'
      `).get();
      expect(ftsRow).toBeNull();
    });

    it('should restore the memory-item FTS update trigger', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('DROP TRIGGER trg_memory_items_fts_update');
      db.run(`
        CREATE TRIGGER trg_memory_items_fts_update
        AFTER UPDATE ON memory_items
        BEGIN
          SELECT RAISE(ABORT, 'stale trigger');
        END
      `);

      runner.runAllMigrations();

      db.run(`
        INSERT INTO projects (id, name, created_at_epoch, updated_at_epoch)
        VALUES ('fts-update-project', 'FTS Update Project', 1, 1)
      `);
      db.run(`
        INSERT INTO memory_items (
          id, project_id, kind, type, title, narrative, created_at_epoch, updated_at_epoch
        ) VALUES ('fts-update-memory', 'fts-update-project', 'manual', 'note', 'Old title', 'Old narrative', 1, 1)
      `);
      db.run(`
        UPDATE memory_items
        SET title = 'New title', narrative = 'New narrative'
        WHERE id = 'fts-update-memory'
      `);

      const ftsRow = db.prepare(`
        SELECT title, narrative FROM memory_items_fts WHERE memory_item_id = 'fts-update-memory'
      `).get() as { title: string; narrative: string };
      expect(ftsRow).toEqual({ title: 'New title', narrative: 'New narrative' });
    });

    it('should restore the memory-item FTS insert trigger', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('DROP TRIGGER trg_memory_items_fts_insert');
      db.run(`
        CREATE TRIGGER trg_memory_items_fts_insert
        AFTER INSERT ON memory_items
        BEGIN
          SELECT RAISE(ABORT, 'stale trigger');
        END
      `);

      runner.runAllMigrations();

      db.run(`
        INSERT INTO projects (id, name, created_at_epoch, updated_at_epoch)
        VALUES ('fts-insert-project', 'FTS Insert Project', 1, 1)
      `);
      db.run(`
        INSERT INTO memory_items (
          id, project_id, kind, type, title, narrative, created_at_epoch, updated_at_epoch
        ) VALUES ('fts-insert-memory', 'fts-insert-project', 'manual', 'note', 'Inserted title', 'Inserted narrative', 1, 1)
      `);

      const ftsRow = db.prepare(`
        SELECT title, narrative FROM memory_items_fts WHERE memory_item_id = 'fts-insert-memory'
      `).get() as { title: string; narrative: string };
      expect(ftsRow).toEqual({ title: 'Inserted title', narrative: 'Inserted narrative' });
    });

    it('should restore the memory-item project-boundary update trigger', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('DROP TRIGGER trg_memory_items_session_project_update');
      db.run(`
        CREATE TRIGGER trg_memory_items_session_project_update
        BEFORE UPDATE OF project_id, server_session_id ON memory_items
        WHEN NEW.server_session_id IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'stale trigger');
        END
      `);

      runner.runAllMigrations();

      db.run(`
        INSERT INTO projects (id, name, created_at_epoch, updated_at_epoch)
        VALUES ('memory-update-a', 'Memory Update A', 1, 1),
               ('memory-update-b', 'Memory Update B', 1, 1)
      `);
      db.run(`
        INSERT INTO server_sessions (
          id, project_id, status, started_at_epoch, updated_at_epoch
        ) VALUES ('memory-update-session', 'memory-update-a', 'active', 1, 1)
      `);
      db.run(`
        INSERT INTO memory_items (
          id, project_id, server_session_id, kind, type, created_at_epoch, updated_at_epoch
        ) VALUES ('memory-update-item', 'memory-update-a', 'memory-update-session', 'manual', 'note', 1, 1)
      `);

      expect(() => db.run(`
        UPDATE memory_items
        SET project_id = 'memory-update-b'
        WHERE id = 'memory-update-item'
      `)).toThrow(/memory_items server_session_id must belong to project_id/);
    });

    it('should restore the memory-item project-boundary insert trigger', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('DROP TRIGGER trg_memory_items_session_project_insert');
      db.run(`
        CREATE TRIGGER trg_memory_items_session_project_insert
        BEFORE INSERT ON memory_items
        WHEN NEW.server_session_id IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'stale trigger');
        END
      `);

      runner.runAllMigrations();

      db.run(`
        INSERT INTO projects (id, name, created_at_epoch, updated_at_epoch)
        VALUES ('memory-project-a', 'Memory Project A', 1, 1),
               ('memory-project-b', 'Memory Project B', 1, 1)
      `);
      db.run(`
        INSERT INTO server_sessions (
          id, project_id, status, started_at_epoch, updated_at_epoch
        ) VALUES ('memory-session', 'memory-project-a', 'active', 1, 1)
      `);

      expect(() => db.run(`
        INSERT INTO memory_items (
          id, project_id, server_session_id, kind, type, created_at_epoch, updated_at_epoch
        ) VALUES ('memory-item', 'memory-project-b', 'memory-session', 'manual', 'note', 1, 1)
      `)).toThrow(/memory_items server_session_id must belong to project_id/);
    });

    it('should restore the agent-event project-boundary update trigger', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('DROP TRIGGER trg_agent_events_session_project_update');
      db.run(`
        CREATE TRIGGER trg_agent_events_session_project_update
        BEFORE UPDATE OF project_id, server_session_id ON agent_events
        WHEN NEW.server_session_id IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'stale trigger');
        END
      `);

      runner.runAllMigrations();

      db.run(`
        INSERT INTO projects (id, name, created_at_epoch, updated_at_epoch)
        VALUES ('update-project-a', 'Update Project A', 1, 1),
               ('update-project-b', 'Update Project B', 1, 1)
      `);
      db.run(`
        INSERT INTO server_sessions (
          id, project_id, status, started_at_epoch, updated_at_epoch
        ) VALUES ('update-session', 'update-project-a', 'active', 1, 1)
      `);
      db.run(`
        INSERT INTO agent_events (
          id, project_id, server_session_id, source_type, event_type,
          occurred_at_epoch, created_at_epoch
        ) VALUES ('update-event', 'update-project-a', 'update-session', 'hook', 'test', 1, 1)
      `);

      expect(() => db.run(`
        UPDATE agent_events
        SET project_id = 'update-project-b'
        WHERE id = 'update-event'
      `)).toThrow(/server_session_id must belong to project_id/);
    });

    it('should restore the agent-event project-boundary insert trigger', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('DROP TRIGGER trg_agent_events_session_project_insert');
      db.run(`
        CREATE TRIGGER trg_agent_events_session_project_insert
        BEFORE INSERT ON agent_events
        WHEN NEW.server_session_id IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'stale trigger');
        END
      `);

      runner.runAllMigrations();

      db.run(`
        INSERT INTO projects (id, name, created_at_epoch, updated_at_epoch)
        VALUES ('event-project-a', 'Event Project A', 1, 1),
               ('event-project-b', 'Event Project B', 1, 1)
      `);
      db.run(`
        INSERT INTO server_sessions (
          id, project_id, status, started_at_epoch, updated_at_epoch
        ) VALUES ('event-session', 'event-project-a', 'active', 1, 1)
      `);

      expect(() => db.run(`
        INSERT INTO agent_events (
          id, project_id, server_session_id, source_type, event_type,
          occurred_at_epoch, created_at_epoch
        ) VALUES ('event-1', 'event-project-b', 'event-session', 'hook', 'test', 1, 1)
      `)).toThrow(/server_session_id must belong to project_id/);
    });

    it('should restore the server-session project-boundary trigger', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('DROP TRIGGER trg_server_sessions_project_update');
      db.run(`
        CREATE TRIGGER trg_server_sessions_project_update
        BEFORE UPDATE OF project_id ON server_sessions
        WHEN EXISTS (
          SELECT 1 FROM agent_events
          WHERE server_session_id = OLD.id AND project_id <> NEW.project_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'stale trigger');
        END
      `);

      runner.runAllMigrations();

      db.run(`
        INSERT INTO projects (id, name, created_at_epoch, updated_at_epoch)
        VALUES ('trigger-project-a', 'Trigger Project A', 1, 1),
               ('trigger-project-b', 'Trigger Project B', 1, 1)
      `);
      db.run(`
        INSERT INTO server_sessions (
          id, project_id, status, started_at_epoch, updated_at_epoch
        ) VALUES ('trigger-session', 'trigger-project-a', 'active', 1, 1)
      `);
      db.run(`
        INSERT INTO memory_items (
          id, project_id, server_session_id, kind, type, created_at_epoch, updated_at_epoch
        ) VALUES ('trigger-memory', 'trigger-project-a', 'trigger-session', 'manual', 'note', 1, 1)
      `);

      expect(() => db.run(`
        UPDATE server_sessions
        SET project_id = 'trigger-project-b'
        WHERE id = 'trigger-session'
      `)).toThrow(/project_id cannot change/);
    });

    it('should repair a malformed legacy source uniqueness index', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('DROP INDEX ux_memory_sources_legacy_source');
      db.run('CREATE INDEX ux_memory_sources_legacy_source ON memory_sources(source_type, legacy_table, legacy_id)');

      runner.runAllMigrations();

      const index = (db.query('PRAGMA index_list(memory_sources)').all() as Array<{ name: string; unique: number; partial: number }>)
        .find(candidate => candidate.name === 'ux_memory_sources_legacy_source');
      expect(index).toMatchObject({ unique: 1, partial: 1 });

      db.run(`
        INSERT INTO projects (id, name, created_at_epoch, updated_at_epoch)
        VALUES ('source-project', 'Source Project', 1, 1)
      `);
      db.run(`
        INSERT INTO memory_items (
          id, project_id, kind, type, created_at_epoch, updated_at_epoch
        ) VALUES ('source-memory', 'source-project', 'manual', 'note', 1, 1)
      `);
      db.run(`
        INSERT INTO memory_sources (id, memory_item_id, source_type, legacy_table, legacy_id, created_at_epoch)
        VALUES ('source-one', 'source-memory', 'observation', 'observations', 1, 1)
      `);
      expect(() => db.run(`
        INSERT INTO memory_sources (id, memory_item_id, source_type, legacy_table, legacy_id, created_at_epoch)
        VALUES ('source-two', 'source-memory', 'observation', 'observations', 1, 2)
      `)).toThrow();
    });

    it('should repair a malformed legacy observation uniqueness index', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('DROP INDEX ux_memory_items_legacy_observation');
      db.run('CREATE INDEX ux_memory_items_legacy_observation ON memory_items(legacy_observation_id)');

      runner.runAllMigrations();

      const index = (db.query('PRAGMA index_list(memory_items)').all() as Array<{ name: string; unique: number; partial: number }>)
        .find(candidate => candidate.name === 'ux_memory_items_legacy_observation');
      expect(index).toMatchObject({ unique: 1, partial: 1 });
      db.run(`
        INSERT INTO projects (id, name, created_at_epoch, updated_at_epoch)
        VALUES ('legacy-project', 'Legacy Project', 1, 1)
      `);
      db.run(`
        INSERT INTO memory_items (
          id, project_id, kind, type, legacy_observation_id, created_at_epoch, updated_at_epoch
        ) VALUES ('legacy-one', 'legacy-project', 'manual', 'note', 1, 1, 1)
      `);
      expect(() => db.run(`
        INSERT INTO memory_items (
          id, project_id, kind, type, legacy_observation_id, created_at_epoch, updated_at_epoch
        ) VALUES ('legacy-two', 'legacy-project', 'manual', 'note', 1, 2, 2)
      `)).toThrow();
    });

    it('should rebuild memory item FTS when content drifts without a row-count change', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const now = Date.now();
      db.run(`
        INSERT INTO projects (id, name, created_at_epoch, updated_at_epoch)
        VALUES ('fts-project', 'FTS Project', ?, ?)
      `, now, now);
      db.run(`
        INSERT INTO memory_items (
          id, project_id, kind, type, title, narrative, created_at_epoch, updated_at_epoch
        ) VALUES ('fts-memory', 'fts-project', 'manual', 'note', 'FTS title', 'Original narrative', ?, ?)
      `, now, now);
      db.run(`
        UPDATE memory_items_fts
        SET narrative = 'Stale narrative'
        WHERE memory_item_id = 'fts-memory'
      `);

      runner.runAllMigrations();

      const ftsRow = db.prepare(`
        SELECT narrative FROM memory_items_fts WHERE memory_item_id = 'fts-memory'
      `).get() as { narrative: string };
      expect(ftsRow.narrative).toBe('Original narrative');
    });

    it('should rebuild memory item FTS after a shadow table is missing', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('DROP TABLE memory_items_fts');
      db.run('CREATE TABLE memory_items_fts_content (stale TEXT)');

      runner.runAllMigrations();

      const ftsTables = db
        .query("SELECT name FROM sqlite_master WHERE name LIKE 'memory_items_fts_%'")
        .all() as Array<{ name: string }>;
      expect(ftsTables.map(table => table.name)).toContain('memory_items_fts_content');
    });

    it('should restore server-owned indexes after migration 33 is already recorded', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('DROP INDEX idx_server_sessions_status');

      runner.runAllMigrations();

      expect(getIndexNames(db, 'server_sessions')).toContain('idx_server_sessions_status');
    });

    it('should make text nullable without dropping later observation columns when migration 9 is recorded', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('PRAGMA foreign_keys = OFF');
      db.run('DROP TRIGGER IF EXISTS observations_ai');
      db.run('DROP TRIGGER IF EXISTS observations_ad');
      db.run('DROP TRIGGER IF EXISTS observations_au');
      db.run('ALTER TABLE observations RENAME TO observations_backup');
      const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='observations_backup'").get() as { sql: string };
      const createSQL = table.sql
        .replace(/observations_backup/g, 'observations')
        .replace(/\btext\s+TEXT\b/i, 'text TEXT NOT NULL');
      db.run(createSQL);
      db.run(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
        VALUES ('nullable-content', 'nullable-session', 'nullable-project', '2026-01-01T00:00:00.000Z', 1767225600000)
      `);
      db.run(`
        INSERT INTO observations (
          memory_session_id, project, text, type, title, metadata, content_hash,
          agent_type, agent_id, created_at, created_at_epoch
        ) VALUES ('nullable-session', 'nullable-project', 'legacy text', 'discovery',
          'sentinel title', 'sentinel metadata', 'sentinel hash', 'sentinel agent',
          'sentinel-id', '2026-01-01T00:00:00.000Z', 1767225600000)
      `);
      db.run('DROP TABLE observations_backup');
      db.run('PRAGMA foreign_keys = ON');

      runner.runAllMigrations();

      const textColumn = getColumns(db, 'observations').find(column => column.name === 'text');
      expect(textColumn?.notnull).toBe(0);
      const row = db.prepare(`
        SELECT title, metadata, content_hash, agent_type, agent_id
        FROM observations
        WHERE memory_session_id = 'nullable-session'
      `).get() as Record<string, string>;
      expect(row).toEqual({
        title: 'sentinel title',
        metadata: 'sentinel metadata',
        content_hash: 'sentinel hash',
        agent_type: 'sentinel agent',
        agent_id: 'sentinel-id',
      });
    });

    it('should restore user prompt indexes when migration 10 is already recorded', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('DROP INDEX idx_user_prompts_lookup');

      runner.runAllMigrations();

      expect(getIndexNames(db, 'user_prompts')).toContain('idx_user_prompts_lookup');
    });

    it('should restore pending-message indexes when migration 16 is already recorded', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('DROP INDEX idx_pending_messages_status');

      runner.runAllMigrations();

      expect(getIndexNames(db, 'pending_messages')).toContain('idx_pending_messages_status');
    });

    it('should restore renamed session ID columns when migration 17 is already recorded', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('ALTER TABLE user_prompts RENAME COLUMN content_session_id TO claude_session_id');

      runner.runAllMigrations();

      const columnNames = getColumns(db, 'user_prompts').map(column => column.name);
      expect(columnNames).toContain('content_session_id');
      expect(columnNames).not.toContain('claude_session_id');
    });

    it('should restore user_prompts when migration 10 is already recorded', () => {
      db.run(`
        CREATE TABLE schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)')
        .run(10, new Date().toISOString());

      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      expect(getTableNames(db)).toContain('user_prompts');
    });

    it('should restore discovery_tokens when migration 11 is already recorded', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('ALTER TABLE observations DROP COLUMN discovery_tokens');
      db.run('ALTER TABLE session_summaries DROP COLUMN discovery_tokens');

      runner.runAllMigrations();

      expect(getColumns(db, 'observations').map(column => column.name)).toContain('discovery_tokens');
      expect(getColumns(db, 'session_summaries').map(column => column.name)).toContain('discovery_tokens');
    });

    it('should restore all observation hierarchical fields when migration 8 is already recorded', () => {
      db.run(`
        CREATE TABLE schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      db.run(`
        CREATE TABLE observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          text TEXT,
          type TEXT NOT NULL,
          title TEXT,
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL
        )
      `);
      db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)')
        .run(8, new Date().toISOString());

      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const columnNames = getColumns(db, 'observations').map(column => column.name);
      expect(columnNames).toEqual(expect.arrayContaining([
        'title', 'subtitle', 'facts', 'narrative', 'concepts', 'files_read', 'files_modified',
      ]));
    });

    it('should restore the content-hash index when migration 22 is already recorded', () => {
      db.run(`
        CREATE TABLE schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      db.run(`
        CREATE TABLE observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          text TEXT,
          type TEXT NOT NULL,
          content_hash TEXT,
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL
        )
      `);
      db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)')
        .run(22, new Date().toISOString());

      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const indexNames = getIndexNames(db, 'observations');
      expect(indexNames).toContain('idx_observations_content_hash');
    });

    it('should restore custom_title when migration 23 is already recorded', () => {
      db.run(`
        CREATE TABLE schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)')
        .run(23, new Date().toISOString());

      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const columnNames = getColumns(db, 'sdk_sessions').map(column => column.name);
      expect(columnNames).toContain('custom_title');
    });

    it('should restore observation feedback storage when version 24 is already recorded', () => {
      db.run(`
        CREATE TABLE schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)')
        .run(24, new Date().toISOString());

      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      expect(getTableNames(db)).toContain('observation_feedback');
      const indexNames = getIndexNames(db, 'observation_feedback');
      expect(indexNames).toContain('idx_feedback_observation');
      expect(indexNames).toContain('idx_feedback_signal');
    });

    it('should repair platform_source column and index even when version 24 is already recorded', () => {
      db.run(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(24, new Date().toISOString());

      db.run(`
        CREATE TABLE sdk_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content_session_id TEXT UNIQUE NOT NULL,
          memory_session_id TEXT UNIQUE,
          project TEXT NOT NULL,
          user_prompt TEXT,
          started_at TEXT NOT NULL,
          started_at_epoch INTEGER NOT NULL,
          completed_at TEXT,
          completed_at_epoch INTEGER,
          status TEXT NOT NULL CHECK(status IN ('active','completed','failed'))
        )
      `);

      const runner = new MigrationRunner(db);
      expect(() => runner.runAllMigrations()).not.toThrow();

      const columnNames = getColumns(db, 'sdk_sessions').map(column => column.name);
      expect(columnNames).toContain('platform_source');

      const indexNames = getIndexNames(db, 'sdk_sessions');
      expect(indexNames).toContain('idx_sdk_sessions_platform_source');
    });
  });

  describe('issue #979 — old DatabaseManager version conflict', () => {
    it('should create core tables even when old migration versions 1-7 are in schema_versions', () => {
      db.run(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);

      const now = new Date().toISOString();
      for (let v = 1; v <= 7; v++) {
        db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(v, now);
      }

      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const tables = getTableNames(db);
      expect(tables).toContain('sdk_sessions');
      expect(tables).toContain('observations');
      expect(tables).toContain('session_summaries');
      expect(tables).toContain('user_prompts');
      expect(tables).toContain('pending_messages');
    });

    it('should handle version 5 conflict (old=drop tables, new=add column) correctly', () => {
      db.run(`
        CREATE TABLE IF NOT EXISTS schema_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER UNIQUE NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      db.prepare('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)').run(5, new Date().toISOString());

      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const columns = getColumns(db, 'sdk_sessions');
      const columnNames = columns.map(c => c.name);
      expect(columnNames).toContain('content_session_id');
    });
  });

  describe('crash recovery — leftover temp tables', () => {
    it('should handle leftover session_summaries_new table from crashed migration 7', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run(`
        CREATE TABLE session_summaries_new (
          id INTEGER PRIMARY KEY,
          test TEXT
        )
      `);

      db.prepare('DELETE FROM schema_versions WHERE version = 7').run();

      expect(() => runner.runAllMigrations()).not.toThrow();
    });

    it('should handle leftover observations_new table from crashed migration 9', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run(`
        CREATE TABLE observations_new (
          id INTEGER PRIMARY KEY,
          test TEXT
        )
      `);

      db.prepare('DELETE FROM schema_versions WHERE version = 9').run();

      expect(() => runner.runAllMigrations()).not.toThrow();
    });
  });

  describe('ON UPDATE CASCADE FK constraints', () => {
    it('should repair recorded migration 21 foreign keys without dropping later columns', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      db.run('PRAGMA foreign_keys = OFF');
      db.run('DROP TRIGGER IF EXISTS observations_ai');
      db.run('DROP TRIGGER IF EXISTS observations_ad');
      db.run('DROP TRIGGER IF EXISTS observations_au');
      db.run('DROP TRIGGER IF EXISTS session_summaries_ai');
      db.run('DROP TRIGGER IF EXISTS session_summaries_ad');
      db.run('DROP TRIGGER IF EXISTS session_summaries_au');
      db.run('ALTER TABLE observations RENAME TO observations_legacy');
      db.run('ALTER TABLE session_summaries RENAME TO session_summaries_legacy');
      db.run(`
        CREATE TABLE observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          text TEXT,
          type TEXT NOT NULL,
          title TEXT,
          subtitle TEXT,
          facts TEXT,
          narrative TEXT,
          concepts TEXT,
          files_read TEXT,
          files_modified TEXT,
          prompt_number INTEGER,
          discovery_tokens INTEGER DEFAULT 0,
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          metadata TEXT,
          content_hash TEXT,
          merged_into_project TEXT,
          agent_type TEXT,
          agent_id TEXT,
          FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
        )
      `);
      db.run(`
        CREATE TABLE session_summaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          request TEXT,
          investigated TEXT,
          learned TEXT,
          completed TEXT,
          next_steps TEXT,
          files_read TEXT,
          files_edited TEXT,
          notes TEXT,
          prompt_number INTEGER,
          discovery_tokens INTEGER DEFAULT 0,
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          merged_into_project TEXT,
          FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
        )
      `);
      db.run('DROP TABLE observations_legacy');
      db.run('DROP TABLE session_summaries_legacy');
      db.run('PRAGMA foreign_keys = ON');

      runner.runAllMigrations();

      expect(getColumns(db, 'observations').map(column => column.name)).toContain('agent_id');
      expect(getColumns(db, 'session_summaries').map(column => column.name)).toContain('merged_into_project');
      expect((db.query('PRAGMA foreign_key_list(observations)').all() as ForeignKeyInfo[])
        .find(foreignKey => foreignKey.table === 'sdk_sessions')?.on_update).toBe('CASCADE');
      expect((db.query('PRAGMA foreign_key_list(session_summaries)').all() as ForeignKeyInfo[])
        .find(foreignKey => foreignKey.table === 'sdk_sessions')?.on_update).toBe('CASCADE');
    });

    it('should have ON UPDATE CASCADE on observations FK after migration 21', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const fks = db.prepare('PRAGMA foreign_key_list(observations)').all() as ForeignKeyInfo[];
      const memorySessionFk = fks.find(fk => fk.table === 'sdk_sessions');

      expect(memorySessionFk).toBeDefined();
      expect(memorySessionFk!.on_update).toBe('CASCADE');
      expect(memorySessionFk!.on_delete).toBe('CASCADE');
    });

    it('should have ON UPDATE CASCADE on session_summaries FK after migration 21', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const fks = db.prepare('PRAGMA foreign_key_list(session_summaries)').all() as ForeignKeyInfo[];
      const memorySessionFk = fks.find(fk => fk.table === 'sdk_sessions');

      expect(memorySessionFk).toBeDefined();
      expect(memorySessionFk!.on_update).toBe('CASCADE');
      expect(memorySessionFk!.on_delete).toBe('CASCADE');
    });
  });

  describe('data integrity during migration', () => {
    it('should preserve existing data through all migrations', () => {
      const runner = new MigrationRunner(db);
      runner.runAllMigrations();

      const now = new Date().toISOString();
      const epoch = Date.now();

      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('test-content-1', 'test-memory-1', 'test-project', now, epoch, 'active');

      db.prepare(`
        INSERT INTO observations (memory_session_id, project, text, type, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('test-memory-1', 'test-project', 'test observation', 'discovery', now, epoch);

      db.prepare(`
        INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?)
      `).run('test-memory-1', 'test-project', 'test request', now, epoch);

      runner.runAllMigrations();

      const sessions = db.prepare('SELECT COUNT(*) as count FROM sdk_sessions').get() as { count: number };
      const observations = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
      const summaries = db.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number };

      expect(sessions.count).toBe(1);
      expect(observations.count).toBe(1);
      expect(summaries.count).toBe(1);
    });
  });
});
