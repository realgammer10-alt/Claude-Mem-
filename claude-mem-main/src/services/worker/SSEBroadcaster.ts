
import type { Response } from 'express';
import { logger } from '../../utils/logger.js';
import type { SSEEvent, SSEClient } from '../worker-types.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';

interface RegisteredSSEClient {
  response: SSEClient;
  platformSource?: string;
}

export class SSEBroadcaster {
  private sseClients: Set<RegisteredSSEClient> = new Set();

  addClient(res: Response, platformSource?: string): void {
    const client = {
      response: res,
      platformSource: platformSource ? normalizePlatformSource(platformSource) : undefined,
    };
    this.sseClients.add(client);
    logger.debug('WORKER', 'Client connected', { total: this.sseClients.size });

    res.on('close', () => {
      this.removeClient(client);
    });

    this.sendToClient(res, { type: 'connected', timestamp: Date.now() });
  }

  removeClient(client: RegisteredSSEClient): void {
    this.sseClients.delete(client);
    logger.debug('WORKER', 'Client disconnected', { total: this.sseClients.size });
  }

  broadcast(event: SSEEvent): void {
    if (this.sseClients.size === 0) {
      logger.debug('WORKER', 'SSE broadcast skipped (no clients)', { eventType: event.type });
      return; 
    }

    const eventWithTimestamp = { ...event, timestamp: Date.now() };
    const data = `data: ${JSON.stringify(eventWithTimestamp)}\n\n`;

    logger.debug('WORKER', 'SSE broadcast sent', { eventType: event.type, clients: this.sseClients.size });

    for (const client of this.sseClients) {
      if (client.platformSource && !eventMatchesPlatformSource(event, client.platformSource)) {
        continue;
      }
      client.response.write(data);
    }
  }

  getClientCount(): number {
    return this.sseClients.size;
  }

  private sendToClient(res: Response, event: SSEEvent): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    res.write(data);
  }
}

function eventMatchesPlatformSource(event: SSEEvent, platformSource: string): boolean {
  const payload = event.observation ?? event.summary ?? event.prompt;
  if (!payload || typeof payload !== 'object') return true;
  const source = (payload as { platform_source?: unknown }).platform_source;
  return typeof source === 'string' && normalizePlatformSource(source) === platformSource;
}
