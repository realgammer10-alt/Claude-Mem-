import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { buildTimeline, queryObservations } from '../../src/services/context/index.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import type { Observation, SummaryTimelineItem } from '../../src/services/context/types.js';
import type { ContextConfig } from '../../src/services/context/types.js';

const compilerConfig: ContextConfig = {
  totalObservationCount: 20,
  fullObservationCount: 20,
  sessionCount: 5,
  showReadTokens: false,
  showWorkTokens: false,
  showSavingsAmount: false,
  showSavingsPercent: false,
  observationTypes: new Set(['discovery']),
  observationConcepts: new Set(['testing']),
  fullObservationField: 'narrative',
  showLastSummary: true,
  showLastMessage: false,
};

function createTestObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: 1,
    memory_session_id: 'session-123',
    type: 'discovery',
    title: 'Test Observation',
    subtitle: null,
    narrative: 'A test narrative',
    facts: '["fact1"]',
    concepts: '["concept1"]',
    files_read: null,
    files_modified: null,
    discovery_tokens: 100,
    created_at: '2025-01-01T12:00:00.000Z',
    created_at_epoch: 1735732800000,
    ...overrides,
  };
}

function createTestSummaryTimelineItem(overrides: Partial<SummaryTimelineItem> = {}): SummaryTimelineItem {
  return {
    id: 1,
    memory_session_id: 'session-123',
    request: 'Test Request',
    investigated: 'Investigated things',
    learned: 'Learned things',
    completed: 'Completed things',
    next_steps: 'Next steps',
    created_at: '2025-01-01T12:00:00.000Z',
    created_at_epoch: 1735732800000,
    displayEpoch: 1735732800000,
    displayTime: '2025-01-01T12:00:00.000Z',
    shouldShowLink: false,
    ...overrides,
  };
}

describe('buildTimeline', () => {
    it('should combine observations and summaries into timeline', () => {
      const observations = [
        createTestObservation({ id: 1, created_at_epoch: 1000 }),
      ];
      const summaries = [
        createTestSummaryTimelineItem({ id: 1, displayEpoch: 2000 }),
      ];

      const timeline = buildTimeline(observations, summaries);

      expect(timeline).toHaveLength(2);
    });

    it('should sort timeline items chronologically by epoch', () => {
      const observations = [
        createTestObservation({ id: 1, created_at_epoch: 3000 }),
        createTestObservation({ id: 2, created_at_epoch: 1000 }),
      ];
      const summaries = [
        createTestSummaryTimelineItem({ id: 1, displayEpoch: 2000 }),
      ];

      const timeline = buildTimeline(observations, summaries);

      expect(timeline).toHaveLength(3);
      expect(timeline[0].type).toBe('observation');
      expect((timeline[0].data as Observation).id).toBe(2);
      expect(timeline[1].type).toBe('summary');
      expect(timeline[2].type).toBe('observation');
      expect((timeline[2].data as Observation).id).toBe(1);
    });

    it('should handle empty observations array', () => {
      const summaries = [
        createTestSummaryTimelineItem({ id: 1, displayEpoch: 1000 }),
      ];

      const timeline = buildTimeline([], summaries);

      expect(timeline).toHaveLength(1);
      expect(timeline[0].type).toBe('summary');
    });

    it('should handle empty summaries array', () => {
      const observations = [
        createTestObservation({ id: 1, created_at_epoch: 1000 }),
      ];

      const timeline = buildTimeline(observations, []);

      expect(timeline).toHaveLength(1);
      expect(timeline[0].type).toBe('observation');
    });

    it('should handle both empty arrays', () => {
      const timeline = buildTimeline([], []);

      expect(timeline).toHaveLength(0);
    });

    it('should correctly tag items with their type', () => {
      const observations = [createTestObservation()];
      const summaries = [createTestSummaryTimelineItem()];

      const timeline = buildTimeline(observations, summaries);

      const observationItem = timeline.find(item => item.type === 'observation');
      const summaryItem = timeline.find(item => item.type === 'summary');

      expect(observationItem).toBeDefined();
      expect(summaryItem).toBeDefined();
      expect(observationItem!.data).toHaveProperty('narrative');
      expect(summaryItem!.data).toHaveProperty('request');
    });

    it('should use displayEpoch for summary sorting, not created_at_epoch', () => {
      const observations = [
        createTestObservation({ id: 1, created_at_epoch: 2000 }),
      ];
      const summaries = [
        createTestSummaryTimelineItem({
          id: 1,
          created_at_epoch: 3000, // Created later
          displayEpoch: 1000,     // But displayed earlier
        }),
      ];

      const timeline = buildTimeline(observations, summaries);

      expect(timeline[0].type).toBe('summary');
      expect(timeline[1].type).toBe('observation');
    });
});

describe('context source scoping', () => {
  it('queryObservations excludes observations from other platforms', () => {
    const db = new Database(':memory:');
    const store = new SessionStore(db);

    const claudeSession = store.createSDKSession('compiler-claude-content', 'compiler-project', 'prompt');
    store.updateMemorySessionId(claudeSession, 'compiler-claude-memory');
    const codexSession = store.createSDKSession('compiler-codex-content', 'compiler-project', 'prompt', undefined, 'codex');
    store.updateMemorySessionId(codexSession, 'compiler-codex-memory');

    const observation = {
      type: 'discovery',
      title: 'Scoped observation',
      subtitle: null,
      facts: [],
      narrative: 'Source scoped content',
      concepts: ['testing'],
      files_read: [],
      files_modified: [],
    };
    store.storeObservation('compiler-claude-memory', 'compiler-project', observation);
    store.storeObservation('compiler-codex-memory', 'compiler-project', observation);

    const results = queryObservations(store, 'compiler-project', compilerConfig, 'codex');

    expect(results).toHaveLength(1);
    expect(results[0].memory_session_id).toBe('compiler-codex-memory');
    db.close();
  });
});
