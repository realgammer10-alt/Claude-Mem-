import { describe, expect, it, afterAll, mock } from 'bun:test';

const workerCalls: string[] = [];

mock.module('../../../src/utils/project-name.js', () => ({
  getProjectContext: () => ({
    primary: 'test-project',
    allProjects: ['test-project'],
  }),
}));
mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async (path: string) => {
    workerCalls.push(path);
    return 'context';
  },
  isWorkerFallback: () => false,
  getWorkerPort: () => 37777,
}));
mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({ CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'false' }),
}));
mock.module('../../../src/shared/oauth-token.js', () => ({
  readStaleMarker: () => null,
}));

import { contextHandler } from '../../../src/cli/handlers/context.js';

afterAll(() => {
  mock.restore();
});

describe('contextHandler platform scoping', () => {
  it('includes the normalized platform source in the worker request', async () => {
    workerCalls.length = 0;

    await contextHandler.execute({
      sessionId: 'session-codex',
      cwd: '/workspace/project',
      platform: 'codex-cli',
    });

    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0]).toContain('platformSource=codex');
  });
});
