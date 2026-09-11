import { describe, expect, it } from 'bun:test';
import {
  parseGenericJobListingQuery,
  parseJobListingQuery,
} from '../../src/server/routes/v1/ServerV1PostgresRoutes.js';

function request(query: Record<string, unknown>) {
  return { query } as never;
}

describe('server job-list query parsers', () => {
  it('rejects unknown status values instead of dropping the filter', () => {
    expect(parseJobListingQuery(request({ status: 'bogus' }))).toEqual({ error: 'Invalid status' });
  });

  it('rejects repeated status values', () => {
    expect(parseJobListingQuery(request({ status: ['queued', 'failed'] }))).toEqual({
      error: 'status must be a single value',
    });
  });

  it('rejects malformed generic filters', () => {
    expect(parseGenericJobListingQuery(request({
      source_type: 'unknown',
      limit: 'not-a-number',
      since: 'not-a-date',
    }))).toEqual({ error: 'Invalid source_type' });
  });

  it('keeps valid pagination clamping behavior', () => {
    expect(parseGenericJobListingQuery(request({
      status: 'queued',
      source_type: 'agent_event',
      limit: '999',
      offset: '4',
      since: '2026-01-02T03:04:05.000Z',
    }))).toEqual({
      status: 'queued',
      sourceType: 'agent_event',
      limit: 200,
      offset: 4,
      since: new Date('2026-01-02T03:04:05.000Z'),
    });
  });
});