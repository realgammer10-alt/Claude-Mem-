import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { getProjectContext } from '../../src/utils/project-name.js';
import * as realChromaSync from '../../src/services/sync/ChromaSync.js';

const realChromaSyncSnapshot = { ...realChromaSync };

const chromaPatchedIds = new Set<number>();
const chromaCalls: Array<{ ids: number[]; project: string }> = [];
let chromaShouldFail = false;

mock.module('../../src/services/sync/ChromaSync.js', () => ({
  ChromaSync: class {
    async updateMergedIntoProject(ids: number[], project: string): Promise<number> {
      if (chromaShouldFail) throw new Error('Chroma unavailable');
      const pendingIds = ids.filter(id => !chromaPatchedIds.has(id));
      chromaCalls.push({ ids: pendingIds, project });
      for (const id of pendingIds) chromaPatchedIds.add(id);
      return pendingIds.length;
    }

    async close(): Promise<void> {}
  }
}));

afterAll(() => {
  mock.module('../../src/services/sync/ChromaSync.js', () => realChromaSyncSnapshot);
});

const { adoptMergedWorktrees } = await import('../../src/services/infrastructure/WorktreeAdoption.js');

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function createMergedWorktree(dataDirectory: string): {
  dbPath: string;
  parentProject: string;
  worktreeProject: string;
  observationId: number;
} {
  const repoPath = path.join(dataDirectory, 'repo');
  const worktreePath = path.join(dataDirectory, 'feature-worktree');
  git(dataDirectory, 'init', repoPath);
  git(repoPath, 'config', 'user.email', 'test@example.com');
  git(repoPath, 'config', 'user.name', 'Test User');
  writeFileSync(path.join(repoPath, 'README.md'), 'initial\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');
  git(repoPath, 'worktree', 'add', '-b', 'feature', worktreePath);
  writeFileSync(path.join(worktreePath, 'feature.txt'), 'feature\n');
  git(worktreePath, 'add', 'feature.txt');
  git(worktreePath, 'commit', '-m', 'feature');
  git(repoPath, 'reset', '--hard', 'feature');

  const parentProject = getProjectContext(repoPath).primary;
  const worktreeProject = getProjectContext(worktreePath).primary;
  const dbPath = path.join(dataDirectory, 'claude-mem.db');
  const database = new ClaudeMemDatabase(dbPath);
  const now = new Date().toISOString();
  const epoch = Date.now();
  database.db.prepare(
    `INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, started_at, started_at_epoch)
     VALUES (?, ?, ?, ?, ?)`
  ).run('content-1', 'memory-1', worktreeProject, now, epoch);
  const observation = database.db.prepare(
    `INSERT INTO observations
      (memory_session_id, project, type, text, created_at, created_at_epoch)
     VALUES (?, ?, 'discovery', ?, ?, ?)`
  ).run('memory-1', worktreeProject, 'feature observation', now, epoch);
  database.db.prepare(
    `INSERT INTO session_summaries
      (memory_session_id, project, request, created_at, created_at_epoch)
     VALUES (?, ?, ?, ?, ?)`
  ).run('memory-1', worktreeProject, 'feature request', now, epoch);
  database.close();

  return {
    dbPath,
    parentProject,
    worktreeProject,
    observationId: Number(observation.lastInsertRowid)
  };
}

describe('adoptMergedWorktrees', () => {
  let dataDirectory: string;

  afterEach(() => {
    chromaPatchedIds.clear();
    chromaCalls.length = 0;
    chromaShouldFail = false;
    if (dataDirectory) {
      const repoPath = path.join(dataDirectory, 'repo');
      const worktreePath = path.join(dataDirectory, 'feature-worktree');
      if (existsSync(repoPath)) {
        execFileSync('git', ['-C', repoPath, 'worktree', 'remove', '--force', worktreePath], {
          stdio: 'ignore'
        });
      }
      try {
        rmSync(dataDirectory, { recursive: true, force: true });
      } catch {
        // SQLite and Git may release temporary handles just after the test closes.
      }
    }
  });

  it('adopts observations and summaries idempotently', async () => {
    dataDirectory = mkdtempSync(path.join(tmpdir(), 'worktree-adoption-'));
    const fixture = createMergedWorktree(dataDirectory);

    const first = await adoptMergedWorktrees({
      repoPath: path.join(dataDirectory, 'repo'),
      dataDirectory
    });

    expect(first.adoptedObservations).toBe(1);
    expect(first.adoptedSummaries).toBe(1);
    expect(first.chromaUpdates).toBe(1);
    expect(chromaCalls).toEqual([{ ids: [fixture.observationId], project: fixture.parentProject }]);

    const second = await adoptMergedWorktrees({
      repoPath: path.join(dataDirectory, 'repo'),
      dataDirectory
    });

    expect(second.adoptedObservations).toBe(0);
    expect(second.adoptedSummaries).toBe(0);
    expect(second.chromaUpdates).toBe(0);
    expect(chromaCalls).toHaveLength(2);
    expect(chromaCalls[1]).toEqual({ ids: [], project: fixture.parentProject });

    const database = new ClaudeMemDatabase(fixture.dbPath);
    const observation = database.db.prepare(
      'SELECT project, merged_into_project FROM observations WHERE id = ?'
    ).get(fixture.observationId) as { project: string; merged_into_project: string };
    const summary = database.db.prepare(
      'SELECT merged_into_project FROM session_summaries WHERE memory_session_id = ?'
    ).get('memory-1') as { merged_into_project: string };
    database.close();

    expect(observation.project).toBe(fixture.worktreeProject);
    expect(observation.merged_into_project).toBe(fixture.parentProject);
    expect(summary.merged_into_project).toBe(fixture.parentProject);
  }, 30_000);

  it('retries Chroma reconciliation after SQL succeeds during an outage', async () => {
    dataDirectory = mkdtempSync(path.join(tmpdir(), 'worktree-adoption-'));
    const fixture = createMergedWorktree(dataDirectory);
    chromaShouldFail = true;

    const failed = await adoptMergedWorktrees({
      repoPath: path.join(dataDirectory, 'repo'),
      dataDirectory
    });

    expect(failed.adoptedObservations).toBe(1);
    expect(failed.chromaFailed).toBe(1);

    chromaShouldFail = false;
    const recovered = await adoptMergedWorktrees({
      repoPath: path.join(dataDirectory, 'repo'),
      dataDirectory
    });

    expect(recovered.adoptedObservations).toBe(0);
    expect(recovered.chromaUpdates).toBe(1);
    expect(chromaCalls).toEqual([{ ids: [fixture.observationId], project: fixture.parentProject }]);
  }, 30_000);

  it('rolls back SQLite changes and skips Chroma in dry-run mode', async () => {
    dataDirectory = mkdtempSync(path.join(tmpdir(), 'worktree-adoption-'));
    const fixture = createMergedWorktree(dataDirectory);

    const dryRun = await adoptMergedWorktrees({
      repoPath: path.join(dataDirectory, 'repo'),
      dataDirectory,
      dryRun: true
    });

    expect(dryRun.adoptedObservations).toBe(1);
    expect(dryRun.adoptedSummaries).toBe(1);
    expect(dryRun.chromaUpdates).toBe(0);
    expect(chromaCalls).toHaveLength(0);

    const database = new ClaudeMemDatabase(fixture.dbPath);
    const observation = database.db.prepare(
      'SELECT merged_into_project FROM observations WHERE id = ?'
    ).get(fixture.observationId) as { merged_into_project: string | null };
    database.close();

    expect(observation.merged_into_project).toBeNull();
  }, 30_000);
});
