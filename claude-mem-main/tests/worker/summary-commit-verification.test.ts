import { describe, it, expect, mock, beforeAll, afterAll, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';
import { logger } from '../../src/utils/logger.js';

// processAgentResponse here uses a mocked SessionManager, so it never touches
// the real supervisor/process-registry — no need to mock them (mock.module
// leaks globally across the bun run and would break supervisor tests).

// Snapshot the real module namespaces BEFORE mock.module mutates the live,
// process-global registry. bun's mock.module is sticky and mock.restore() does
// NOT undo it, so we re-register these snapshots in afterAll. The spreads must
// run as executable statements textually before the corresponding mock.module
// calls so they capture the real exports (e.g. worker-service's
// buildStatusOutput) before the registry is clobbered.
import * as realModeManagerNs from '../../src/services/domain/ModeManager.js';
import * as realWorkerUtilsNs from '../../src/shared/worker-utils.js';
import * as realWorkerServiceNs from '../../src/services/worker-service.js';
const realModeManager = { ...realModeManagerNs };
const realWorkerUtils = { ...realWorkerUtilsNs };
const realWorkerService = { ...realWorkerServiceNs };

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        observation_types: [{ id: 'discovery' }, { id: 'bugfix' }, { id: 'refactor' }],
        observation_concepts: [],
      }),
    }),
  },
}));
mock.module('../../src/shared/worker-utils.js', () => ({ getWorkerPort: () => 37777 }));
mock.module('../../src/services/worker-service.js', () => ({
  updateCursorContextForProject: () => Promise.resolve(),
}));

import { processAgentResponse } from '../../src/services/worker/agents/ResponseProcessor.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { WorkerRef, StorageResult } from '../../src/services/worker/agents/types.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

const mockWorker = { broadcastProcessingStatus: () => {} } as unknown as WorkerRef;

const isolatedGitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
};

async function runGit(args: string[], cwd: string, captureOutput = false): Promise<string> {
  const git = Bun.spawn(['git', ...args], {
    cwd,
    env: isolatedGitEnv,
    stdout: captureOutput ? 'pipe' : 'ignore',
    stderr: 'pipe',
  });
  const exitCode = await git.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(git.stderr).text();
    throw new Error(`git ${args.join(' ')} failed (${exitCode}): ${stderr}`);
  }
  return captureOutput ? await new Response(git.stdout).text() : '';
}

function makeSessionManager(): SessionManager {
  return {
    confirmClaimedMessages: () => Promise.resolve(0),
    resetProcessingToPending: () => Promise.resolve(0),
    respawnPoisonedSession: () => Promise.resolve(),
  } as unknown as SessionManager;
}

function makeSession(): ActiveSession {
  return {
    sessionDbId: 1,
    contentSessionId: 'content-123',
    memorySessionId: 'mem-1',
    project: 'proj',
    platformSource: 'claude',
    userPrompt: 'do x',
    pendingMessages: [],
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: 'claude',
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    lastGeneratorActivity: Date.now(),
  } as ActiveSession;
}

describe('summary commit-hash verification (plan-11 #2574)', () => {
  let repoDir: string;
  let realHash: string;
  let storeSpy: ReturnType<typeof mock>;
  let dbManager: DatabaseManager;
  let spies: ReturnType<typeof spyOn>[] = [];

  beforeAll(async () => {
    const scratchRoot = os.tmpdir();
    mkdirSync(scratchRoot, { recursive: true });
    repoDir = mkdtempSync(join(scratchRoot, 'summary-verify-'));
    await runGit(['init', '-q'], repoDir);
    await runGit(['config', 'user.email', 'test@example.com'], repoDir);
    await runGit(['config', 'user.name', 'Test'], repoDir);
    writeFileSync(join(repoDir, 'a.txt'), 'x');
    await runGit(['add', '.'], repoDir);
    await runGit(['commit', '-q', '--no-verify', '-m', 'init'], repoDir);
    realHash = (await runGit(['rev-parse', 'HEAD'], repoDir, true)).trim();
  });

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
    mock.module('../../src/services/worker-service.js', () => realWorkerService);
    mock.module('../../src/shared/worker-utils.js', () => realWorkerUtils);
    mock.module('../../src/services/domain/ModeManager.js', () => realModeManager);
  });

  beforeEach(() => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
    storeSpy = mock(() => ({ observationIds: [], summaryId: 1, createdAtEpoch: 0 } as StorageResult));
    dbManager = {
      getSessionStore: () => ({
        storeObservations: storeSpy,
        ensureMemorySessionIdRegistered: () => {},
        getSessionById: () => ({ memory_session_id: 'mem-1' }),
      }),
      getChromaSync: () => undefined,
    } as unknown as DatabaseManager;
  });

  afterEach(() => spies.forEach(s => s.mockRestore()));

  const FAKE = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

  it('strips a fabricated commit hash before persisting the summary', { timeout: 30000 }, async () => {
    const response = `
      <summary>
        <request>fix the bug</request>
        <investigated>looked at auth</investigated>
        <learned>token expiry</learned>
        <completed>Fixed and committed as ${FAKE}</completed>
        <next_steps>tests</next_steps>
      </summary>`;

    await processAgentResponse(
      response, makeSession(), dbManager, makeSessionManager(), mockWorker,
      0, null, 'TestAgent', repoDir
    );

    expect(storeSpy).toHaveBeenCalledTimes(1);
    const persistedSummary = storeSpy.mock.calls[0][3];
    expect(persistedSummary.completed).not.toContain(FAKE);
    expect(persistedSummary.completed).toContain('[unverified commit]');
  });

  it('persists a real commit hash unchanged', { timeout: 30000 }, async () => {
    const response = `
      <summary>
        <request>fix the bug</request>
        <investigated>looked at auth</investigated>
        <learned>token expiry</learned>
        <completed>Fixed and committed as ${realHash}</completed>
        <next_steps>tests</next_steps>
      </summary>`;

    await processAgentResponse(
      response, makeSession(), dbManager, makeSessionManager(), mockWorker,
      0, null, 'TestAgent', repoDir
    );

    const persistedSummary = storeSpy.mock.calls[0][3];
    expect(persistedSummary.completed).toContain(realHash);
    expect(persistedSummary.completed).not.toContain('[unverified commit]');
  });

  it('strips fabricated commit hashes from observations before persisting', { timeout: 30000 }, async () => {
    const response = `
      <observation>
        <type>discovery</type>
        <title>Changed auth in ${FAKE}</title>
        <narrative>Implemented the fix and committed as ${FAKE}</narrative>
        <facts><fact>Reviewed commit ${FAKE}</fact></facts>
        <files_modified><file>src/auth.ts</file></files_modified>
      </observation>`;

    await processAgentResponse(
      response, makeSession(), dbManager, makeSessionManager(), mockWorker,
      0, null, 'TestAgent', repoDir
    );

    expect(storeSpy).toHaveBeenCalledTimes(1);
    const persistedObservations = storeSpy.mock.calls[0][2];
    expect(persistedObservations[0].title).not.toContain(FAKE);
    expect(persistedObservations[0].narrative).toContain('[unverified commit]');
    expect(persistedObservations[0].facts[0]).toContain('[unverified commit]');
  });
});
