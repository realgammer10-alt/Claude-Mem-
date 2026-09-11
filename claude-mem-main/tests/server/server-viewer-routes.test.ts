// SPDX-License-Identifier: Apache-2.0
//
// #2552 — the Viewer UI + API compat layer must be reachable on the server
// runtime. We register ServerViewerRoutes alongside a stub API route on the
// SAME Express app (as ServerBetaService does) and assert:
//   - the viewer root `/` responds (HTML when built, 503 when not),
//   - the static handler does NOT shadow a co-mounted API route.

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
import { Server, type ServerOptions } from '../../src/services/server/Server.js';
import { ServerViewerRoutes } from '../../src/server/runtime/ServerViewerRoutes.js';
import type { PostgresPool } from '../../src/storage/postgres/pool.js';
import { requirePostgresServerAuth } from '../../src/server/middleware/postgres-auth.js';

function baseOptions(): ServerOptions {
  return {
    getInitializationComplete: () => true,
    getMcpReady: () => true,
    onShutdown: () => Promise.resolve(),
    onRestart: () => Promise.resolve(),
    workerPath: '',
    getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
  };
}

describe('ServerViewerRoutes on the server runtime (#2552)', () => {
  let server: Server | null = null;
  let spies: ReturnType<typeof spyOn>[] = [];

  afterEach(async () => {
    spies.forEach(s => s.mockRestore());
    spies = [];
    if (server?.getHttpServer()) {
      try { await server.close(); } catch { /* ignore */ }
    }
    server = null;
  });

  it('serves the viewer root and does not shadow a co-mounted API route', async () => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
    ];
    server = new Server(baseOptions());

    // Mirror ServerBetaService: register an API route BEFORE the viewer's
    // static handler so we can prove the static handler does not swallow it.
    server.registerRoutes({
      setupRoutes(app) {
        app.get('/v1/info', (_req, res) => {
          res.json({ name: 'claude-mem-server', runtime: 'server-beta' });
        });
      },
    });
    server.registerRoutes(new ServerViewerRoutes());
    server.finalizeRoutes();

    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('Server did not expose an assigned port');
    const port = address.port;

    // The co-mounted API route still resolves (compat/v1 layer reachable).
    const apiRes = await fetch(`http://127.0.0.1:${port}/v1/info`);
    expect(apiRes.status).toBe(200);
    const apiBody = await apiRes.json();
    expect(apiBody.runtime).toBe('server-beta');

    // The viewer root route is registered and responds. When the build shipped
    // a viewer.html it is 200 text/html; otherwise it is a clean 503 (not a
    // 404/crash), proving the handler is mounted.
    const rootRes = await fetch(`http://127.0.0.1:${port}/`);
    if (ServerViewerRoutes.hasViewerHtml()) {
      expect(rootRes.status).toBe(200);
      expect(rootRes.headers.get('content-type')).toContain('text/html');
    } else {
      expect(rootRes.status).toBe(503);
      const body = await rootRes.json();
      expect(body.error).toBe('ViewerUnavailable');
    }
  });

  it('exposes the core legacy viewer API endpoints needed by the UI', async () => {
    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes());
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const projectsRes = await fetch(`http://127.0.0.1:${port}/api/projects`);
    expect(projectsRes.status).toBe(200);
    const projectsBody = await projectsRes.json();
    expect(Array.isArray(projectsBody.projects)).toBe(true);

    const invalidProjectsRes = await fetch(`http://127.0.0.1:${port}/api/projects?platformSource=claude&platformSource=codex`);
    expect(invalidProjectsRes.status).toBe(200);

    const logsRes = await fetch(`http://127.0.0.1:${port}/api/logs`);
    expect(logsRes.status).toBe(200);
    const logsBody = await logsRes.json();
    expect(logsBody).toHaveProperty('logs');
  });

  it('serves the public onboarding explainer endpoint', async () => {
    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes());
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/api/onboarding/explainer`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(await response.text()).toContain('claude-mem');

    const aliasResponse = await fetch(`http://127.0.0.1:${port}/api/how-it-works`);
    expect(aliasResponse.status).toBe(200);
    expect(aliasResponse.headers.get('content-type')).toContain('text/markdown');
    expect(await aliasResponse.text()).toContain('claude-mem');
  });

  it('returns paginated project-scoped observations', async () => {
    const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        if (text.includes('SELECT id FROM projects')) {
          return { rows: [{ id: 'project-a' }] };
        }
        return {
          rows: [{
            id: 'observation-1',
            project: 'Project A',
            kind: 'discovery',
            content: 'Stored context',
            metadata: { title: 'A discovery', platform_source: 'claude' },
            created_at: '2023-11-14T22:13:20.000Z',
            total_count: '11',
          }],
        };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
      localDevProjectId: 'project-a',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/api/observations?project=Project%20A&offset=10&limit=5`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(11);
    expect(body.items[0]).toMatchObject({
      id: 'observation-1',
      project: 'Project A',
      type: 'discovery',
      title: 'A discovery',
      narrative: 'Stored context',
    });
    const observationQuery = queries.find(query => query.text.includes('FROM observations'));
    expect(observationQuery?.text).toContain('COALESCE(o.platform_source, s.platform_source, \'claude\')');
    expect(observationQuery?.values).toEqual(['team-1', 'project-a', null, 6, 10]);
  });
  
  it('does not select an arbitrary project when names are duplicated', async () => {
    const pool = {
      query: async (text: string) => text.includes('SELECT id FROM projects')
        ? { rows: [{ id: 'project-a' }, { id: 'project-b' }] }
        : { rows: [] },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
      localDevProjectId: 'project-a',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/api/observations?project=Duplicate`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [], hasMore: false, total: 0 });
  });

  it('preserves totals when pagination starts beyond the final page', async () => {
    const pool = {
      query: async (text: string) => {
        if (text.includes('SELECT id FROM projects')) return { rows: [{ id: 'project-a' }] };
        if (text.includes('COUNT(*)::text AS count')) return { rows: [{ count: '11' }] };
        return { rows: [] };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
      localDevProjectId: 'project-a',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/api/observations?project=Project%20A&offset=50&limit=5`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [], hasMore: false, total: 11 });
  });

  it('returns summary observations in the legacy viewer shape', async () => {
    let queryValues: unknown[] | undefined;
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queryValues = values;
        return text.includes('SELECT id FROM projects')
          ? { rows: [{ id: 'project-a' }] }
          : {
          rows: [{
            id: 'summary-1',
            project: 'Project A',
            server_session_id: 'session-1',
            content: 'Completed work',
            metadata: {
              request: 'Build the feature',
              investigated: 'Existing routes',
              completed: 'Viewer compatibility',
            },
            created_at: '2023-11-14T22:13:20.000Z',
            total_count: '1',
            }],
          };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
      localDevProjectId: 'project-a',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/api/summaries?project=Project%20A&platformSource=codex-cli`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      id: 'summary-1',
      session_id: 'session-1',
      request: 'Build the feature',
      investigated: 'Existing routes',
      completed: 'Viewer compatibility',
    });
    expect(queryValues?.[2]).toBe('codex');
  });

  it('returns project-scoped prompts from server sessions', async () => {
    const promptRow = {
      id: 'prompt-1',
      server_session_id: 'server-session-1',
      content_session_id: 'content-session-1',
      project: 'Project A',
      payload: {
        prompt: 'Build the prompt route',
        prompt_number: 3,
        platform_source: 'codex',
      },
      prompt_text: 'Build the prompt route',
      prompt_number: 3,
      platform_source: 'codex',
      started_at: '2026-01-02T03:04:05.000Z',
      occurred_at: '2026-01-02T03:04:05.000Z',
      total_count: '1',
    };
    let queryValues: unknown[] | undefined;
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes('FROM server_prompts')) queryValues = values;
        return text.includes('FROM server_prompts')
          ? { rows: [promptRow] }
          : { rows: [] };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
      localDevProjectId: 'project-a',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const listResponse = await fetch(`http://127.0.0.1:${port}/api/prompts?limit=5&platformSource=codex-cli`);
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    expect(listBody).toMatchObject({ total: 1, hasMore: false });
    expect(listBody.items[0]).toMatchObject({
      id: 'prompt-1',
      content_session_id: 'content-session-1',
      project: 'Project A',
      prompt_number: 3,
      prompt_text: 'Build the prompt route',
      platform_source: 'codex',
    });
    expect(queryValues?.[2]).toBe('codex');

    const detailResponse = await fetch(`http://127.0.0.1:${port}/api/prompt/prompt-1?platformSource=codex-cli`);
    expect(detailResponse.status).toBe(200);
    expect(await detailResponse.json()).toMatchObject({ id: 'prompt-1', prompt_text: 'Build the prompt route' });
    expect(queryValues?.[3]).toBe('codex');

    const searchResponse = await fetch(`http://127.0.0.1:${port}/api/search/prompts?q=prompt&platformSource=codex-cli`);
    expect(searchResponse.status).toBe(200);
    const searchBody = await searchResponse.json();
    expect(searchBody.content[0].text).toContain('Build the prompt route');
    expect(queryValues?.[3]).toBe('codex');
  });

  it('returns project-scoped Postgres viewer statistics', async () => {
    const pool = {
      query: async (text: string) => {
        if (text.includes('pg_database_size')) return { rows: [{ size: '123456' }] };
        if (text.includes('COUNT(*)') && text.includes("kind = 'summary'")) return { rows: [{ count: '2' }] };
        if (text.includes('COUNT(*)') && text.includes('FROM observations')) return { rows: [{ count: '7' }] };
        if (text.includes('COUNT(*)') && text.includes('server_sessions')) return { rows: [{ count: '3' }] };
        if (text.includes('COUNT(*)')) return { rows: [{ count: '0' }] };
        return { rows: [{ created_at: '2026-01-02T03:04:05.000Z' }] };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
      localDevProjectId: 'project-a',
      port: 37877,
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/api/stats?platformSource=codex-cli`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.worker.activeSessions).toBe(3);
    expect(body.worker.uptime).toBeGreaterThanOrEqual(0);
    expect(body.worker.port).toBe(37877);
    expect(body.database).toMatchObject({
      observations: 7,
      sessions: 3,
      summaries: 2,
      size: 123456,
      firstObservationAt: '2026-01-02T03:04:05.000Z',
    });
  });

  it('searches project-scoped session summaries', async () => {
    let queryValues: unknown[] | undefined;
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes('FROM observations')) queryValues = values;
        return text.includes('FROM observations')
          ? {
          rows: [{
            id: 'server-session-1',
            project: 'Project A',
            content: 'Implemented the viewer route',
            started_at: '2026-01-02T03:04:05.000Z',
          }],
        }
          : { rows: [] };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/api/search/sessions?q=viewer&platformSource=codex-cli`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.content[0].text).toContain('Implemented the viewer route');
    expect(queryValues?.[2]).toBe('codex');
  });

  it('searches project-scoped observations', async () => {
    let queryValues: unknown[] | undefined;
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes('FROM observations')) queryValues = values;
        return text.includes('FROM observations')
          ? {
          rows: [{
            id: 'observation-1',
            project: 'Project A',
            kind: 'discovery',
            content: 'Found the route implementation',
          }],
        }
          : { rows: [] };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/api/search/observations?q=route&platformSource=codex-cli`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.content[0].text).toContain('Found the route implementation');
    expect(queryValues?.[2]).toBe('codex');
  });

  it('combines observations and prompts in unified search', async () => {
    let queryValues: unknown[] | undefined;
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes('UNION ALL')) queryValues = values;
        return text.includes('UNION ALL')
          ? {
          rows: [
            { result_type: 'observation', id: 'observation-1', project: 'Project A', text: 'Observed route', created_at: '2026-01-02T03:04:05.000Z' },
            { result_type: 'prompt', id: 'session-1', project: 'Project A', text: 'Build route search', created_at: '2026-01-02T03:03:05.000Z' },
          ],
        }
          : { rows: [] };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/api/search?q=route&platformSource=codex-cli`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.content[0].text).toContain('Observed route');
    expect(body.content[0].text).toContain('Build route search');
    expect(queryValues?.[2]).toBe('codex');
  });

  it('searches observations by type and validates the type parameter', async () => {
    let queryValues: unknown[] | undefined;
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes('o.kind = $2')) queryValues = values;
        return text.includes('o.kind = $2')
          ? { rows: [{ id: 'observation-1', project: 'Project A', content: 'A discovery' }] }
          : { rows: [] };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const invalidResponse = await fetch(`http://127.0.0.1:${port}/api/search/by-type`);
    expect(invalidResponse.status).toBe(400);

    const response = await fetch(`http://127.0.0.1:${port}/api/search/by-type?type=discovery&platformSource=codex-cli`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.content[0].text).toContain('A discovery');
    expect(queryValues?.[2]).toBe('codex');
  });

  it('searches observations by file path and validates the path parameter', async () => {
    let queryValues: unknown[] | undefined;
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes("metadata->>'files_read'")) queryValues = values;
        return text.includes("metadata->>'files_read'")
          ? { rows: [{ id: 'observation-1', project: 'Project A', kind: 'discovery', content: 'Read the route file' }] }
          : { rows: [] };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const invalidResponse = await fetch(`http://127.0.0.1:${port}/api/search/by-file`);
    expect(invalidResponse.status).toBe(400);

    const response = await fetch(`http://127.0.0.1:${port}/api/search/by-file?path=ServerViewerRoutes.ts&platformSource=codex-cli`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.content[0].text).toContain('Read the route file');
    expect(queryValues?.[2]).toBe('codex');
  });

  it('exposes decisions and changes as typed observation searches', async () => {
    const queriedKinds: string[] = [];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes('o.kind = $2')) {
          queriedKinds.push(String(values?.[1]));
          return { rows: [{ id: 'observation-1', project: 'Project A', content: `${values?.[1]} result` }] };
        }
        return { rows: [] };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    expect((await (await fetch(`http://127.0.0.1:${port}/api/decisions`)).json()).content[0].text).toContain('decision result');
    expect((await (await fetch(`http://127.0.0.1:${port}/api/changes`)).json()).content[0].text).toContain('change result');
    expect(queriedKinds).toEqual(['decision', 'change']);
  });

  it('returns project-scoped recent context', async () => {
    const pool = {
      query: async (text: string) => text.includes('SELECT id FROM projects')
        ? { rows: [{ id: 'project-a' }] }
        : { rows: [{ content: 'Recent project context', created_at: '2026-01-02T03:04:05.000Z' }] },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const invalidResponse = await fetch(`http://127.0.0.1:${port}/api/context/recent`);
    expect(invalidResponse.status).toBe(400);

    const response = await fetch(`http://127.0.0.1:${port}/api/context/recent?project=Project%20A&platformSource=codex-cli`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.content[0].text).toContain('Recent project context');
  });

  it('returns a bounded chronological context timeline', async () => {
    let timelineValues: unknown[] | undefined;
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes('SELECT id FROM projects')) return { rows: [{ id: 'project-a' }] };
        timelineValues = values;
        return {
          rows: [
            { content: 'Newer context', kind: 'change', created_at: '2026-01-02T03:04:05.000Z' },
            { content: 'Older context', kind: 'discovery', created_at: '2026-01-02T03:03:05.000Z' },
          ],
        };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const invalidResponse = await fetch(`http://127.0.0.1:${port}/api/context/timeline`);
    expect(invalidResponse.status).toBe(400);

    const response = await fetch(`http://127.0.0.1:${port}/api/context/timeline?project=Project%20A&limit=2&platformSource=codex-cli`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.content[0].text.indexOf('Older context')).toBeLessThan(body.content[0].text.indexOf('Newer context'));
    expect(timelineValues).toEqual(['team-1', 'project-a', 'codex', 2]);
  });

  it('returns semantic context for a scoped project', async () => {
    const pool = {
      query: async (text: string) => {
        if (text.includes('SELECT id FROM projects')) return { rows: [{ id: 'project-a' }] };
        if (text.includes('content_search @@')) {
          return { rows: [{
            id: 'observation-1',
            project_id: 'project-a',
            team_id: 'team-1',
            server_session_id: null,
            kind: 'discovery',
            content: 'Relevant context',
            metadata: {},
            embedding: null,
            generation_key: null,
            created_by_job_id: null,
            created_at: new Date('2026-01-02T03:04:05.000Z'),
            updated_at: new Date('2026-01-02T03:04:05.000Z'),
          }] };
        }
        return { rows: [] };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const emptyResponse = await fetch(`http://127.0.0.1:${port}/api/context/semantic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'Project A' }),
    });
    expect(await emptyResponse.json()).toEqual({ context: '', count: 0 });

    const response = await fetch(`http://127.0.0.1:${port}/api/context/semantic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'Project A', q: 'relevant context', limit: 3 }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ context: 'Relevant context', count: 1 });
  });

  it('injects plain-text context for scoped projects', async () => {
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes('SELECT id FROM projects')) return { rows: [{ id: `${values?.[1]}-id` }] };
        if (text.includes('FROM observations')) {
          return { rows: [{
            id: 'observation-1',
            project_id: 'project-a-id',
            team_id: 'team-1',
            server_session_id: null,
            kind: 'discovery',
            content: 'Injected context',
            metadata: {},
            embedding: null,
            generation_key: null,
            created_by_job_id: null,
            created_at: new Date('2026-01-02T03:04:05.000Z'),
            updated_at: new Date('2026-01-02T03:04:05.000Z'),
          }] };
        }
        return { rows: [] };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const invalidResponse = await fetch(`http://127.0.0.1:${port}/api/context/inject`);
    expect(invalidResponse.status).toBe(400);

    const response = await fetch(`http://127.0.0.1:${port}/api/context/inject?projects=Project%20A,Project%20B`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toContain('Injected context');
  });

  it('documents the server search and context routes', async () => {
    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes());
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/api/search/help`);
    expect(response.status).toBe(200);
    const body = await response.json();
    const paths = body.endpoints.map((endpoint: { path: string }) => endpoint.path);
    expect(paths).toContain('/api/search');
    expect(paths).toContain('/api/context/semantic');
    expect(paths).toContain('/api/context/inject');
    expect(paths).toContain('/api/observation/:id');
    expect(paths).toContain('/api/observations/by-file');
    expect(paths).toContain('/api/observations/batch');
    expect(paths).toContain('/api/sdk-sessions/batch');
  });

  it('searches timeline anchors in auto and interactive modes', async () => {
    let queryValues: unknown[] | undefined;
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes('SELECT id FROM projects')) return { rows: [{ id: 'project-a' }] };
        if (text.includes('content_search @@')) {
          queryValues = values;
          return { rows: [{
            id: 'observation-1',
            project_id: 'project-a',
            team_id: 'team-1',
            server_session_id: null,
            kind: 'decision',
            content: 'Use the scoped timeline anchor',
            metadata: {},
            embedding: null,
            generation_key: null,
            created_by_job_id: null,
            created_at: new Date('2026-01-02T03:04:05.000Z'),
            updated_at: new Date('2026-01-02T03:04:05.000Z'),
          }] };
        }
        return { rows: [] };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const invalidResponse = await fetch(`http://127.0.0.1:${port}/api/timeline/by-query?project=Project%20A`);
    expect(invalidResponse.status).toBe(400);

    const autoResponse = await fetch(`http://127.0.0.1:${port}/api/timeline/by-query?project=Project%20A&query=anchor&platformSource=codex-cli`);
    expect((await autoResponse.json()).content[0].text).toContain('Observation observation-1');
    expect(queryValues?.[3]).toBe('codex');

    const interactiveResponse = await fetch(`http://127.0.0.1:${port}/api/timeline/by-query?project=Project%20A&query=anchor&mode=interactive`);
    expect((await interactiveResponse.json()).content[0].text).toContain('Timeline Anchor Search Results');
  });

  it('returns a project-scoped observation by id', async () => {
    let queryValues: unknown[] | undefined;
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queryValues = values;
        if (text.includes('SELECT id FROM projects')) return { rows: [{ id: 'project-a' }] };
        if (text.includes('FROM observations o')) {
          return { rows: [{
            id: 'observation-1',
            project_id: 'project-a',
            team_id: 'team-1',
            server_session_id: 'session-1',
            kind: 'discovery',
            content: 'Scoped observation',
            metadata: { title: 'Discovery' },
            embedding: null,
            generation_key: null,
            created_by_job_id: null,
            created_at: new Date('2026-01-02T03:04:05.000Z'),
            updated_at: new Date('2026-01-02T03:04:05.000Z'),
          }] };
        }
        return { rows: [] };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/api/observation/observation-1?project=Project%20A&platformSource=codex-cli`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: 'observation-1',
      project_id: 'project-a',
      type: 'discovery',
      content: 'Scoped observation',
    });
    expect(queryValues?.[3]).toBe('codex');
  });

  it('returns a project-scoped server session by id', async () => {
    let queryValues: unknown[] | undefined;
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queryValues = values;
        return text.includes('FROM server_sessions')
        ? { rows: [{
          id: 'session-1',
          project_id: 'project-a',
          team_id: 'team-1',
          external_session_id: 'external-1',
          idempotency_key: 'key-1',
          content_session_id: 'content-1',
          agent_id: null,
          agent_type: 'claude-code',
          platform_source: 'codex',
          generation_status: 'idle',
          metadata: { prompt: 'Build the feature' },
          started_at: new Date('2026-01-02T03:04:05.000Z'),
          ended_at: null,
          last_generated_at: null,
          created_at: new Date('2026-01-02T03:04:05.000Z'),
          updated_at: new Date('2026-01-02T03:04:05.000Z'),
        }] }
        : { rows: [] };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
      localDevProjectId: 'project-a',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/api/session/session-1?platformSource=codex-cli`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: 'session-1',
      project_id: 'project-a',
      content_session_id: 'content-1',
      generation_status: 'idle',
    });
    expect(queryValues?.[3]).toBe('codex');
  });

  it('returns project-scoped observations in a batch', async () => {
    let queryValues: unknown[] | undefined;
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queryValues = values;
        return text.includes('id = ANY')
          ? { rows: [{
          id: 'observation-1',
          project_id: 'project-a',
          server_session_id: null,
          kind: 'discovery',
          platform_source: 'codex',
          content: 'Batch observation',
          metadata: {},
          created_at: new Date('2026-01-02T03:04:05.000Z'),
          updated_at: new Date('2026-01-02T03:04:05.000Z'),
          }] }
          : { rows: [] };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
      localDevProjectId: 'project-a',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const emptyResponse = await fetch(`http://127.0.0.1:${port}/api/observations/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    });
    expect(await emptyResponse.json()).toEqual([]);

    const response = await fetch(`http://127.0.0.1:${port}/api/observations/batch?platformSource=codex-cli`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['observation-1'] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject([{ id: 'observation-1', content: 'Batch observation' }]);
    expect(queryValues?.[3]).toBe('codex');
  });

  it('returns structured observations by repeated file paths', async () => {
    let queryValues: unknown[] | undefined;
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queryValues = values;
        return text.includes('unnest($3::text[])')
          ? { rows: [{
          id: 'observation-1',
          project_id: 'project-a',
          server_session_id: null,
          kind: 'discovery',
          platform_source: 'codex',
          content: 'File-backed observation',
          metadata: { files_read: '["src/routes.ts"]' },
          created_at: new Date('2026-01-02T03:04:05.000Z'),
          updated_at: new Date('2026-01-02T03:04:05.000Z'),
          }] }
          : { rows: [] };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
      localDevProjectId: 'project-a',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const invalidResponse = await fetch(`http://127.0.0.1:${port}/api/observations/by-file`);
    expect(invalidResponse.status).toBe(400);

    const response = await fetch(`http://127.0.0.1:${port}/api/observations/by-file?path=src%2Froutes.ts&path=routes.ts&platformSource=codex-cli`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      count: 1,
      observations: [{ id: 'observation-1', content: 'File-backed observation' }],
    });
    expect(queryValues?.[4]).toBe('codex');
  });

  it('returns project-scoped sessions in a batch', async () => {
    let queryValues: unknown[] | undefined;
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queryValues = values;
        return text.includes('id = ANY') && text.includes('FROM server_sessions')
        ? { rows: [{
          id: 'session-1',
          project_id: 'project-a',
          team_id: 'team-1',
          external_session_id: 'external-1',
          content_session_id: 'content-1',
          platform_source: 'codex',
          generation_status: 'idle',
          metadata: {},
          started_at: new Date('2026-01-02T03:04:05.000Z'),
          ended_at: null,
          last_generated_at: null,
        }] }
        : { rows: [] };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
      localDevProjectId: 'project-a',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/api/sdk-sessions/batch?platformSource=codex-cli`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memorySessionIds: ['session-1'] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject([{ id: 'session-1', content_session_id: 'content-1' }]);
    expect(queryValues?.[3]).toBe('codex');
  });

  it('accepts legacy sdkSessionIds as a compatibility alias in the server batch route', async () => {
    let queryValues: unknown[] | undefined;
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queryValues = values;
        return text.includes('id = ANY') && text.includes('FROM server_sessions')
        ? { rows: [{
          id: 'session-1',
          project_id: 'project-a',
          team_id: 'team-1',
          external_session_id: 'external-1',
          content_session_id: 'content-1',
          platform_source: 'codex',
          generation_status: 'idle',
          metadata: {},
          started_at: new Date('2026-01-02T03:04:05.000Z'),
          ended_at: null,
          last_generated_at: null,
        }] }
        : { rows: [] };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
      localDevProjectId: 'project-a',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/api/sdk-sessions/batch?platformSource=codex-cli`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sdkSessionIds: ['session-1'] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject([{ id: 'session-1', content_session_id: 'content-1' }]);
    expect(queryValues?.[3]).toBe('codex');
  });

  it('coerces string payloads on the server batch route', async () => {
    const pool = {
      query: async (_text: string, values?: unknown[]) => {
        const ids = values?.[2] as unknown[];
        return {
          rows: [{
            id: Array.isArray(ids) ? ids[0] : 'session-1',
            project_id: 'project-a',
            team_id: 'team-1',
            external_session_id: 'external-1',
            content_session_id: 'content-1',
            platform_source: 'codex',
            generation_status: 'idle',
            metadata: {},
            started_at: new Date('2026-01-02T03:04:05.000Z'),
            ended_at: null,
            last_generated_at: null,
          }],
        };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
      localDevProjectId: 'project-a',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/api/sdk-sessions/batch?platformSource=codex-cli`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memorySessionIds: 'session-1,session-2' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject([{ id: 'session-1', content_session_id: 'content-1' }]);
  });

  it('falls back to the legacy sdkSessionIds field when the canonical field is null', async () => {
    const pool = {
      query: async (_text: string, values?: unknown[]) => {
        const ids = values?.[2] as unknown[];
        return {
          rows: [{
            id: Array.isArray(ids) ? ids[0] : 'legacy-session',
            project_id: 'project-a',
            team_id: 'team-1',
            external_session_id: 'external-1',
            content_session_id: 'content-1',
            platform_source: 'codex',
            generation_status: 'idle',
            metadata: {},
            started_at: new Date('2026-01-02T03:04:05.000Z'),
            ended_at: null,
            last_generated_at: null,
          }],
        };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
      localDevProjectId: 'project-a',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/api/sdk-sessions/batch?platformSource=codex-cli`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memorySessionIds: null, sdkSessionIds: ['legacy-session'] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject([{ id: 'legacy-session', content_session_id: 'content-1' }]);
  });

  it('reports scoped generation-job processing status', async () => {
    let queryValues: unknown[] | undefined;
    const pool = {
      query: async (_text: string, values?: unknown[]) => {
        queryValues = values;
        return { rows: [{ status: 'queued', count: '4' }, { status: 'processing', count: '2' }] };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/api/processing-status?platformSource=codex-cli`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ isProcessing: true, queueDepth: 6 });
    expect(queryValues).toEqual(['team-1', 'codex']);
  });

  it('scopes context preview to the requested project', async () => {
    const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        if (text.includes('SELECT id FROM projects')) {
          return { rows: [{ id: 'project-a' }] };
        }
        return { rows: [{ content: 'project-a memory', metadata: {} }] };
      },
    } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'team-1',
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/api/context/preview?project=Project%20A&platformSource=codex-cli`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('project-a memory');

    const observationQuery = queries.find(query => query.text.includes('FROM observations'));
    expect(observationQuery?.values).toEqual(['team-1', 'project-a', 'codex']);
    expect(observationQuery?.text).toContain('o.project_id = $2');
  });

  it('requires viewer read auth for the server event stream', async () => {
    const pool = { query: async () => ({ rows: [] }) } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({ pool, authMode: 'api-key' }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/stream`);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'Unauthorized' });
  });

  it('emits viewer SSE frames in the worker-compatible data format', async () => {
    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes());
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/stream`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const reader = response.body!.getReader();
    let text = '';
    for (let index = 0; index < 3 && !text.includes('"type":"processing_status"'); index += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    await reader.cancel();
    expect(text).toContain('data: {"type":"initial_load"');
    expect(text).toContain('"type":"processing_status"');
    expect(text).not.toContain('event: initial_load');
  });

  it('keeps the SSE stream usable when initial Postgres reads fail', async () => {
    const pool = { query: async () => { throw new Error('database unavailable'); } } as unknown as PostgresPool;
    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({ pool, authMode: 'local-dev', allowLocalDevBypass: true, localDevTeamId: 'team-1' }));
    server.finalizeRoutes();

    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('Server did not expose an assigned port');
    const port = address.port;
    const response = await fetch(`http://127.0.0.1:${port}/stream`);
    const reader = response.body!.getReader();
    let text = '';
    for (let index = 0; index < 3 && !text.includes('"type":"processing_status"'); index += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    await reader.cancel();
    expect(response.status).toBe(200);
    expect(text).toContain('"type":"initial_load"');
    expect(text).toContain('"projects":[]');
    expect(text).toContain('"type":"processing_status"');
    expect(text).toContain('"queueDepth":0');
  });

  it('requires viewer auth for settings read and write', async () => {
    const pool = { query: async () => ({ rows: [] }) } as unknown as PostgresPool;

    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({ pool, authMode: 'api-key' }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const getResponse = await fetch(`http://127.0.0.1:${port}/api/settings`);
    expect(getResponse.status).toBe(401);

    const postResponse = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ CLAUDE_MEM_MODEL: 'ignored-without-auth' }),
    });
    expect(postResponse.status).toBe(401);
  });

  it('rejects non-string viewer settings values before writing', async () => {
    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      authMode: 'local-dev',
      allowLocalDevBypass: true,
    }));
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    const response = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ CLAUDE_MEM_CONTEXT_OBSERVATIONS: 25 }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false });
  });

  it('bootstraps a loopback viewer credential cookie when configured', async () => {
    const previousKey = process.env.CLAUDE_MEM_SERVER_BETA_API_KEY;
    process.env.CLAUDE_MEM_SERVER_BETA_API_KEY = 'viewer-test-key';
    try {
      const pool = { query: async () => ({ rows: [] }) } as unknown as PostgresPool;
      server = new Server(baseOptions());
      server.registerRoutes(new ServerViewerRoutes({ pool, authMode: 'api-key' }));
      server.finalizeRoutes();

      const port = 42000 + Math.floor(Math.random() * 9000);
      await server.listen(port, '127.0.0.1');

      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(response.headers.get('set-cookie')).toContain('claude_mem_viewer_key=viewer-test-key');
      expect(response.headers.get('set-cookie')).toContain('HttpOnly');
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      if (previousKey === undefined) delete process.env.CLAUDE_MEM_SERVER_BETA_API_KEY;
      else process.env.CLAUDE_MEM_SERVER_BETA_API_KEY = previousKey;
    }
  });

  it('accepts the bootstrapped viewer cookie for authenticated API calls', async () => {
    const previousKey = process.env.CLAUDE_MEM_SERVER_BETA_API_KEY;
    process.env.CLAUDE_MEM_SERVER_BETA_API_KEY = 'viewer-test-key';
    try {
      const pool = {
        query: async (text: string) => text.includes('FROM api_keys')
          ? {
            rows: [{
              id: 'key-1',
              team_id: 'team-1',
              project_id: null,
              scopes: ['memories:read'],
              revoked_at: null,
              expires_at: null,
            }],
          }
          : { rows: [] },
      } as unknown as PostgresPool;
      server = new Server(baseOptions());
      server.registerRoutes(new ServerViewerRoutes({ pool, authMode: 'api-key' }));
      server.finalizeRoutes();

      const port = 42000 + Math.floor(Math.random() * 9000);
      await server.listen(port, '127.0.0.1');
      const rootResponse = await fetch(`http://127.0.0.1:${port}/`);
      const cookie = rootResponse.headers.get('set-cookie')?.split(';')[0];
      expect(cookie).toBe('claude_mem_viewer_key=viewer-test-key');

      const projectsResponse = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        headers: { Cookie: cookie! },
      });
      expect(projectsResponse.status).toBe(200);
    } finally {
      if (previousKey === undefined) delete process.env.CLAUDE_MEM_SERVER_BETA_API_KEY;
      else process.env.CLAUDE_MEM_SERVER_BETA_API_KEY = previousKey;
    }
  });

  it('rejects viewer cookies on forwarded requests', async () => {
    const previousKey = process.env.CLAUDE_MEM_SERVER_BETA_API_KEY;
    process.env.CLAUDE_MEM_SERVER_BETA_API_KEY = 'viewer-test-key';
    try {
      const pool = { query: async () => ({ rows: [] }) } as unknown as PostgresPool;
      server = new Server(baseOptions());
      server.registerRoutes(new ServerViewerRoutes({ pool, authMode: 'api-key' }));
      server.finalizeRoutes();

      const port = 42000 + Math.floor(Math.random() * 9000);
      await server.listen(port, '127.0.0.1');
      const response = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        headers: {
          Cookie: 'claude_mem_viewer_key=viewer-test-key',
          'X-Forwarded-For': '203.0.113.10',
        },
      });
      expect(response.status).toBe(401);
    } finally {
      if (previousKey === undefined) delete process.env.CLAUDE_MEM_SERVER_BETA_API_KEY;
      else process.env.CLAUDE_MEM_SERVER_BETA_API_KEY = previousKey;
    }
  });

  it('does not use viewer cookies for non-viewer auth middleware', async () => {
    const pool = { query: async () => ({ rows: [] }) } as unknown as PostgresPool;
    server = new Server(baseOptions());
    server.registerRoutes({
      setupRoutes(app) {
        app.get('/protected', requirePostgresServerAuth(pool, { authMode: 'api-key' }), (_req, res) => {
          res.json({ ok: true });
        });
      },
    });
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');
    const response = await fetch(`http://127.0.0.1:${port}/protected`, {
      headers: { Cookie: 'claude_mem_viewer_key=viewer-test-key' },
    });
    expect(response.status).toBe(401);
  });
});
