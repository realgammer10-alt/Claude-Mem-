import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { detectWorktree } from '../../src/utils/worktree.js';

describe('detectWorktree', () => {
  it('resolves relative gitdir references against the worktree directory', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cm-worktree-'));
    const parentRepo = path.join(root, 'main-repo');
    const worktree = path.join(root, 'feature');

    try {
      mkdirSync(path.join(parentRepo, '.git', 'worktrees', 'feature'), { recursive: true });
      mkdirSync(worktree, { recursive: true });
      writeFileSync(path.join(worktree, '.git'), 'gitdir: ../main-repo/.git/worktrees/feature\n');

      expect(detectWorktree(worktree)).toEqual({
        isWorktree: true,
        worktreeName: 'feature',
        parentRepoPath: parentRepo,
        parentProjectName: 'main-repo',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});