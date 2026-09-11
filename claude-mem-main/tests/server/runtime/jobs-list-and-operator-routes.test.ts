// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { createHash, randomBytes } from 'crypto';
import { Server } from '../../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import {
  bootstrapServerBetaPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { DisabledServerBetaQueueManager } from '../../../src/server/runtime/types.js';
import { logger } from '../../../src/utils/logger.js';

// Phase 12 — integration tests for GET /v1/jobs (with admin payload guard),
// POST /v1/jobs/:id/retry, POST /v1/jobs/:id/cancel. Postgres-gated; skipped
// without CLAUDE_MEM_TEST_POSTGRES_URL.

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function newApiKey(): { raw: string; hash: string } {
  const raw = `cm_${randomBytes(24).toString('hex')}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

describe('Phase 12 — GET /v1/jobs + retry/cancel routes', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let server: Server;
  let port: number;

  let teamId: string;
  let projectId: string;
  let writeKey: string;
  let adminKey: string;
  let projectScopedKey: string;
  let jobId: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    client = await pool.connect();
    schemaName = `cm_phase12_jobs_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerBetaPostgresSchema(client);
    pool.on('connect', (c) => {
      c.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {});
    });
    storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'team-a' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p1' });
    teamId = team.id;
    projectId = project.id;

    const writeMaterial = newApiKey();
    writeKey = writeMaterial.raw;
    await storage.auth.createApiKey({
      keyHash: writeMaterial.hash,
      teamId,
      projectId: null,
      actorId: 'system:phase12-write',
      scopes: ['memories:read', 'memories:write'],
    });

    const adminMaterial = newApiKey();
    adminKey = adminMaterial.raw;
    await storage.auth.createApiKey({
      keyHash: adminMaterial.hash,
      teamId,
      projectId: null,
      actorId: 'system:phase12-admin',
      scopes: ['memories:read', 'memories:write', 'memories:admin'],
    });

    const projectScopedMaterial = newApiKey();
    projectScopedKey = projectScopedMaterial.raw;
    await storage.auth.createApiKey({
      keyHash: projectScopedMaterial.hash,
      teamId,
      projectId,
      actorId: 'system:phase12-project-scoped',
      scopes: ['memories:read', 'memories:write'],
    });

    const event = await storage.agentEvents.create({
      projectId,
      teamId,
      sourceAdapter: 'api',
      eventType: 'tool_use',
      payload: { sensitive: 'should_not_leak' },
      occurredAt: new Date(),
    });
    const job = await storage.observationGenerationJobs.create({
      projectId,
      teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      agentEventId: event.id,
      jobType: 'observation_generate_for_event',
      payload: { sensitive: 'should_not_leak', request_id: 'req-12345' },
    });
    jobId = job.id;

    const session = await storage.serverSessions.create({
      projectId,
      teamId,
      externalSessionId: 'session-export-1',
      platformSource: 'claude-code',
    });
    await storage.observations.create({
      projectId,
      teamId,
      serverSessionId: session.id,
      platformSource: 'claude-code',
      kind: 'decision',
      content: 'Exported observation',
      metadata: { source: 'phase12-test' },
    });
    await client.query(
      `INSERT INTO server_prompts (
         id, project_id, team_id, server_session_id, prompt_number,
         prompt_text, occurred_at, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, now(), $7::jsonb)`,
      [crypto.randomUUID(), projectId, teamId, session.id, 1, 'Exported prompt', JSON.stringify({ source: 'phase12-test' })],
    );

    server = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs',
      runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerV1PostgresRoutes({
      pool: pool as never,
      queueManager: new DisabledServerBetaQueueManager('disabled in tests'),
      authMode: 'api-key',
      runtime: 'server-beta',
      sessionPolicy: 'per-event',
      getEventQueue: () => null,
      getSummaryQueue: () => null,
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    port = address.port;
  });

  afterEach(async () => {
    try { await server.close(); } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    }
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    client.release();
    await pool.end();
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  function authedFetch(rawKey: string, path: string, init?: RequestInit): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      ...(init ?? {}),
      headers: {
        Authorization: `Bearer ${rawKey}`,
        'Content-Type': 'application/json',
        ...((init?.headers as Record<string, string>) ?? {}),
      },
    });
  }

  it('GET /v1/jobs lists jobs without payload by default', async () => {
    const resp = await authedFetch(writeKey, '/v1/jobs');
    expect(resp.status).toBe(200);
    const body = await resp.json() as { jobs: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    expect(body.jobs[0]!.payload).toBeUndefined();
  });

  it('GET /v1/audit requires the memories:admin scope', async () => {
    const denied = await authedFetch(writeKey, '/v1/audit');
    expect(denied.status).toBe(403);

    const allowed = await authedFetch(adminKey, '/v1/audit?limit=10');
    expect(allowed.status).toBe(200);
    const body = await allowed.json() as { entries: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBeGreaterThan(0);
    expect(body.entries[0]?.teamId).toBe(teamId);
  });

  it('GET /v1/me, /v1/teams, and /v1/projects expose the API-key scope', async () => {
    const me = await authedFetch(writeKey, '/v1/me');
    expect(me.status).toBe(200);
    expect((await me.json()).teamId).toBe(teamId);

    const teams = await authedFetch(writeKey, '/v1/teams');
    expect(teams.status).toBe(200);
    expect((await teams.json()).teams[0].id).toBe(teamId);

    const projects = await authedFetch(writeKey, '/v1/projects');
    expect(projects.status).toBe(200);
    expect((await projects.json()).projects[0].id).toBe(projectId);
  });

  it('POST /v1/export requires admin scope and excludes API-key identifiers', async () => {
    const denied = await authedFetch(writeKey, '/v1/export', {
      method: 'POST',
      body: JSON.stringify({ projectId }),
    });
    expect(denied.status).toBe(403);

    const allowed = await authedFetch(adminKey, '/v1/export', {
      method: 'POST',
      body: JSON.stringify({ projectId, includeAudit: true, limit: 10 }),
    });
    expect(allowed.status).toBe(200);
    const body = await allowed.json() as {
      format: string;
      teamId: string;
      projectId: string;
      sessions: Array<Record<string, unknown>>;
      prompts: Array<Record<string, unknown>>;
      events: Array<Record<string, unknown>>;
      observations: Array<Record<string, unknown>>;
      audit?: Array<Record<string, unknown>>;
    };
    expect(body.format).toBe('claude-mem-server-export-v1');
    expect(body.teamId).toBe(teamId);
    expect(body.projectId).toBe(projectId);
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(Array.isArray(body.prompts)).toBe(true);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.id).toBe(event.id);
    expect(body.observations).toHaveLength(1);
    expect(body.observations[0]?.content).toBe('Exported observation');
    expect(body.sessions[0]?.external_session_id).toBe('session-export-1');
    expect(body.prompts[0]?.prompt_text).toBe('Exported prompt');
    expect(body.audit?.length).toBeGreaterThan(0);
    expect(body.audit?.[0]).not.toHaveProperty('api_key_id');
  });

  it('POST /v1/export applies the row limit to every collection', async () => {
    const resp = await authedFetch(adminKey, '/v1/export', {
      method: 'POST',
      body: JSON.stringify({ projectId, includeAudit: true, limit: 1 }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as {
      projects: unknown[];
      sessions: unknown[];
      prompts: unknown[];
      events: unknown[];
      observations: unknown[];
      audit?: unknown[];
    };
    expect(body.projects.length).toBeLessThanOrEqual(1);
    expect(body.sessions.length).toBeLessThanOrEqual(1);
    expect(body.prompts.length).toBeLessThanOrEqual(1);
    expect(body.events.length).toBeLessThanOrEqual(1);
    expect(body.observations.length).toBeLessThanOrEqual(1);
    expect(body.audit?.length).toBeLessThanOrEqual(1);
  });

  it('POST /v1/export rejects unknown request fields', async () => {
    const resp = await authedFetch(adminKey, '/v1/export', {
      method: 'POST',
      body: JSON.stringify({ limti: 10 }),
    });
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toBe('ValidationError');
  });

  it('POST /v1/export rejects blank project IDs', async () => {
    const resp = await authedFetch(adminKey, '/v1/export', {
      method: 'POST',
      body: JSON.stringify({ projectId: '   ' }),
    });
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toBe('ValidationError');
  });

  it('POST /v1/export rejects a missing project scope', async () => {
    const resp = await authedFetch(adminKey, '/v1/export', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'project-does-not-exist' }),
    });
    expect(resp.status).toBe(404);
    expect((await resp.json()).error).toBe('NotFound');
  });

  it('POST /v1/export rejects a project-scoped API key for a different project', async () => {
    const resp = await authedFetch(projectScopedKey, '/v1/export', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'project-does-not-exist' }),
    });
    expect(resp.status).toBe(403);
    expect((await resp.json()).error).toBe('Forbidden');
  });

  it('GET /v1/jobs?include=payload rejects without admin scope', async () => {
    const resp = await authedFetch(writeKey, '/v1/jobs?include=payload');
    expect(resp.status).toBe(403);
  });

  it('GET /v1/jobs?include=payload succeeds with admin scope and returns payload', async () => {
    const resp = await authedFetch(adminKey, '/v1/jobs?include=payload');
    expect(resp.status).toBe(200);
    const body = await resp.json() as { jobs: Array<Record<string, unknown>> };
    const payload = body.jobs[0]!.payload as { sensitive: string; request_id?: string };
    expect(payload.sensitive).toBe('should_not_leak');
    expect(payload.request_id).toBe('req-12345');
  });

  it('GET /v1/jobs supports source_type and since filters', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const resp = await authedFetch(writeKey, `/v1/jobs?source_type=agent_event&since=${future}`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { total: number };
    expect(body.total).toBe(0);
  });

  it('POST /v1/jobs/:id/retry on a queued job is a no-op', async () => {
    const resp = await authedFetch(writeKey, `/v1/jobs/${jobId}/retry`, { method: 'POST' });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { alreadyQueued: boolean };
    expect(body.alreadyQueued).toBe(true);
    // Idempotent: a second call also reports already queued.
    const resp2 = await authedFetch(writeKey, `/v1/jobs/${jobId}/retry`, { method: 'POST' });
    expect(resp2.status).toBe(200);
    const body2 = await resp2.json() as { alreadyQueued: boolean };
    expect(body2.alreadyQueued).toBe(true);
  });

  it('POST /v1/jobs/:id/retry on a failed job re-queues idempotently', async () => {
    // Force the row into failed.
    await client.query(
      `UPDATE observation_generation_jobs SET status = 'failed', failed_at = now() WHERE id = $1`,
      [jobId],
    );
    const resp = await authedFetch(writeKey, `/v1/jobs/${jobId}/retry`, { method: 'POST' });
    expect(resp.status).toBe(200);
    const body = await resp.json() as {
      alreadyQueued: boolean;
      retriedCount: number;
      generationJob: { status: string };
    };
    expect(body.alreadyQueued).toBe(false);
    expect(body.retriedCount).toBe(1);
    expect(body.generationJob.status).toBe('queued');

    // Second retry on now-queued row is a no-op.
    const resp2 = await authedFetch(writeKey, `/v1/jobs/${jobId}/retry`, { method: 'POST' });
    const body2 = await resp2.json() as { alreadyQueued: boolean };
    expect(body2.alreadyQueued).toBe(true);

    // Audit row written.
    const audit = await client.query(
      `SELECT * FROM audit_log WHERE action = 'generation_job.retried_by_operator' AND resource_id = $1`,
      [jobId],
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /v1/jobs/:id/cancel cancels a queued job and emits audit', async () => {
    const resp = await authedFetch(writeKey, `/v1/jobs/${jobId}/cancel`, { method: 'POST' });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { generationJob: { status: string }; alreadyCancelled: boolean };
    expect(body.alreadyCancelled).toBe(false);
    expect(body.generationJob.status).toBe('cancelled');

    // Idempotent.
    const resp2 = await authedFetch(writeKey, `/v1/jobs/${jobId}/cancel`, { method: 'POST' });
    const body2 = await resp2.json() as { alreadyCancelled: boolean };
    expect(body2.alreadyCancelled).toBe(true);

    const audit = await client.query(
      `SELECT * FROM audit_log WHERE action = 'generation_job.cancelled_by_operator' AND resource_id = $1`,
      [jobId],
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('request_id flows from header into audit details', async () => {
    const resp = await authedFetch(writeKey, '/v1/jobs', {
      headers: { 'X-Request-Id': 'op-correlation-007' },
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('x-request-id')).toBe('op-correlation-007');
    const body = await resp.json() as { requestId: string };
    expect(body.requestId).toBe('op-correlation-007');

    const audit = await client.query(
      `SELECT details FROM audit_log WHERE action = 'observation.read' ORDER BY created_at DESC LIMIT 1`,
    );
    const details = audit.rows[0]?.details as { requestId?: string };
    expect(details?.requestId).toBe('op-correlation-007');
  });
});
