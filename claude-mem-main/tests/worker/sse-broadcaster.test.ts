import { describe, expect, it } from 'bun:test';
import { SSEBroadcaster } from '../../src/services/worker/SSEBroadcaster.js';

function createResponse() {
  const writes: string[] = [];
  const closeHandlers: Array<() => void> = [];
  return {
    writes,
    on(event: string, handler: () => void) {
      if (event === 'close') closeHandlers.push(handler);
      return this;
    },
    once(event: string, handler: () => void) {
      if (event === 'close') closeHandlers.push(handler);
      return this;
    },
    write(data: string) {
      writes.push(data);
      return true;
    },
    close() {
      for (const handler of closeHandlers) handler();
    },
  };
}

describe('SSEBroadcaster platform filtering', () => {
  it('delivers only matching normalized sources to scoped clients', () => {
    const broadcaster = new SSEBroadcaster();
    const codexClient = createResponse();
    const claudeClient = createResponse();
    const allSourcesClient = createResponse();

    broadcaster.addClient(codexClient as never, 'codex-cli');
    broadcaster.addClient(claudeClient as never, 'claude-code');
    broadcaster.addClient(allSourcesClient as never);

    broadcaster.broadcast({
      type: 'new_observation',
      observation: { platform_source: 'codex', id: 'codex-observation' },
    });
    broadcaster.broadcast({
      type: 'new_observation',
      observation: { platform_source: 'claude', id: 'claude-observation' },
    });

    expect(codexClient.writes).toHaveLength(2);
    expect(codexClient.writes[1]).toContain('codex-observation');
    expect(claudeClient.writes).toHaveLength(2);
    expect(claudeClient.writes[1]).toContain('claude-observation');
    expect(allSourcesClient.writes).toHaveLength(3);
  });

  it('broadcasts source-less control events to scoped clients', () => {
    const broadcaster = new SSEBroadcaster();
    const client = createResponse();
    broadcaster.addClient(client as never, 'openclaw');

    broadcaster.broadcast({ type: 'processing_status', queueDepth: 0 });

    expect(client.writes).toHaveLength(2);
    expect(client.writes[1]).toContain('processing_status');
  });
});
