// SPDX-License-Identifier: Apache-2.0
//
// #2552 — Viewer UI on the server runtime.
//
// The Viewer UI (plugin/ui/viewer.html) is served by the in-plugin worker via
// ViewerRoutes, but the server-beta runtime never mounted any static handler,
// so the viewer was unreachable. This handler mirrors the worker's static
// serving: it caches viewer.html at boot and serves it at `/` plus any static
// assets under the package `ui` directory. The viewer's API calls resolve
// against the same Express app (the /v1/* routes and the legacy
// /api/sessions/* compat adapters are already registered on it).

import express, { type Application, type Request, type Response } from 'express';
import path from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import type { RouteHandler } from '../../services/server/Server.js';
import { getPackageRoot, paths } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { normalizePlatformSource, sortPlatformSources } from '../../shared/platform-source.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { PostgresObservationRepository } from '../../storage/postgres/observations.js';
import { PostgresServerSessionsRepository } from '../../storage/postgres/server-sessions.js';
import { isLocalhost, requirePostgresServerAuth } from '../middleware/postgres-auth.js';
import { parseLogLineLimit, readLastLines } from '../../services/worker/http/routes/LogsRoutes.js';

export interface ServerViewerRoutesOptions {
  pool?: PostgresPool;
  authMode?: string;
  allowLocalDevBypass?: boolean;
  localDevTeamId?: string | null;
  localDevProjectId?: string | null;
  port?: number;
}

const VIEWER_HTML_CANDIDATE_PATHS: readonly string[] = (() => {
  const packageRoot = getPackageRoot();
  return [
    path.join(packageRoot, 'ui', 'viewer.html'),
    path.join(packageRoot, 'plugin', 'ui', 'viewer.html'),
  ];
})();

const resolvedViewerHtmlPath: string | null =
  VIEWER_HTML_CANDIDATE_PATHS.find(candidate => existsSync(candidate)) ?? null;

const viewerHtmlBytes: Buffer | null = resolvedViewerHtmlPath
  ? readFileSync(resolvedViewerHtmlPath)
  : null;

const ONBOARDING_EXPLAINER_CANDIDATE_PATHS: readonly string[] = [
  path.join(getPackageRoot(), 'onboarding-explainer.md'),
  path.join(getPackageRoot(), 'plugin', 'skills', 'how-it-works', 'onboarding-explainer.md'),
  path.join(getPackageRoot(), '..', 'plugin', 'skills', 'how-it-works', 'onboarding-explainer.md'),
];
const resolvedOnboardingExplainerPath = ONBOARDING_EXPLAINER_CANDIDATE_PATHS.find(candidate => existsSync(candidate)) ?? null;
const onboardingExplainer = resolvedOnboardingExplainerPath
  ? readFileSync(resolvedOnboardingExplainerPath, 'utf-8')
  : null;

interface PromptEventRow {
  id: string;
  server_session_id: string | null;
  content_session_id: string | null;
  project: string;
  payload: unknown;
  occurred_at: Date | string;
  total_count: string;
}

interface SearchPromptRow {
  id: string;
  project: string;
  content_session_id: string | null;
  platform_source: string | null;
  prompt_text: string;
  prompt_number: string | null;
  started_at: Date | string;
}

interface UnifiedSearchRow {
  result_type: 'observation' | 'prompt';
  id: string;
  project: string;
  text: string;
  created_at: Date | string;
}

function hasDuplicateQueryParam(originalUrl: string, name: string): boolean {
  return new URL(originalUrl, 'http://localhost').searchParams.getAll(name).length > 1;
}

if (resolvedViewerHtmlPath) {
  logger.info('SYSTEM', 'Cached viewer.html at boot (server runtime)', {
    path: resolvedViewerHtmlPath,
    bytes: viewerHtmlBytes!.byteLength,
  });
} else {
  logger.warn('SYSTEM', 'viewer.html not found for server runtime', {
    candidates: VIEWER_HTML_CANDIDATE_PATHS,
  });
}

export class ServerViewerRoutes implements RouteHandler {
  private readonly startedAt = Date.now();
  private activeSseClients = 0;

  constructor(private readonly options: ServerViewerRoutesOptions = {}) {}

  setupRoutes(app: Application): void {
    const packageRoot = getPackageRoot();
    const readAuth = this.options.pool
      ? requirePostgresServerAuth(this.options.pool, {
        authMode: this.options.authMode,
        allowLocalDevBypass: this.options.allowLocalDevBypass,
        localDevTeamId: this.options.localDevTeamId,
        localDevProjectId: this.options.localDevProjectId,
        allowViewerCookie: true,
        requiredScopes: ['memories:read'],
      })
      : undefined;
    const writeAuth = this.options.pool
      ? requirePostgresServerAuth(this.options.pool, {
        authMode: this.options.authMode,
        allowLocalDevBypass: this.options.allowLocalDevBypass,
        localDevTeamId: this.options.localDevTeamId,
        localDevProjectId: this.options.localDevProjectId,
        allowViewerCookie: true,
        requiredScopes: ['memories:write'],
      })
      : undefined;

    // Serve static assets from BOTH the npm-package `ui` dir and the plugin
    // `plugin/ui` dir, matching the worker's resolution order so the viewer
    // loads regardless of which layout the server image ships.
    app.use(express.static(path.join(packageRoot, 'ui')));
    app.use(express.static(path.join(packageRoot, 'plugin', 'ui')));

    app.get('/stream', ...(readAuth ? [readAuth] : []), async (req: Request, res: Response) => {
      this.activeSseClients += 1;
      res.once('close', () => {
        this.activeSseClients = Math.max(0, this.activeSseClients - 1);
      });
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      try {
        const projects = await this.getProjectCatalog(req);
        res.write(`data: ${JSON.stringify({ type: 'initial_load', projects: projects.projects, sources: projects.sources, projectsBySource: projects.projectsBySource, timestamp: Date.now() })}\n\n`);
      } catch (error) {
        logger.warn('HTTP', 'Viewer SSE project catalog unavailable', {
          error: error instanceof Error ? error.message : String(error),
        });
        res.write(`data: ${JSON.stringify({ type: 'initial_load', projects: [], sources: ['claude'], projectsBySource: { claude: [] }, timestamp: Date.now() })}\n\n`);
      }

      try {
        const processingStatus = await this.getProcessingStatus(req);
        res.write(`data: ${JSON.stringify({ type: 'processing_status', ...processingStatus, timestamp: Date.now() })}\n\n`);
      } catch (error) {
        logger.warn('HTTP', 'Viewer SSE processing status unavailable', {
          error: error instanceof Error ? error.message : String(error),
        });
        res.write(`data: ${JSON.stringify({ type: 'processing_status', isProcessing: false, queueDepth: 0, timestamp: Date.now() })}\n\n`);
      }

      reqKeepAlive(res);
    });

    app.get('/api/projects', ...(readAuth ? [readAuth] : []), this.handleGetProjects.bind(this));
    app.get('/api/context/preview', ...(readAuth ? [readAuth] : []), this.handleGetContextPreview.bind(this));
    app.get('/api/context/recent', ...(readAuth ? [readAuth] : []), this.handleGetRecentContext.bind(this));
    app.get('/api/context/timeline', ...(readAuth ? [readAuth] : []), this.handleGetContextTimeline.bind(this));
    app.get('/api/context/inject', ...(readAuth ? [readAuth] : []), this.handleContextInject.bind(this));
    app.post('/api/context/semantic', ...(readAuth ? [readAuth] : []), this.handleSemanticContext.bind(this));
    app.get('/api/timeline/by-query', ...(readAuth ? [readAuth] : []), this.handleTimelineByQuery.bind(this));
    app.get('/api/onboarding/explainer', this.handleGetOnboardingExplainer.bind(this));
    app.get('/api/how-it-works', this.handleGetOnboardingExplainer.bind(this));
    app.get('/api/settings', ...(readAuth ? [readAuth] : []), this.handleGetSettings.bind(this));
    app.post('/api/settings', ...(writeAuth ? [writeAuth] : []), this.handleUpdateSettings.bind(this));
    app.get('/api/logs', ...(readAuth ? [readAuth] : []), this.handleGetLogs.bind(this));
    app.post('/api/logs/clear', ...(writeAuth ? [writeAuth] : []), this.handleClearLogs.bind(this));
    app.get('/api/stats', ...(readAuth ? [readAuth] : []), this.handleGetStats.bind(this));
    app.get('/api/processing-status', ...(readAuth ? [readAuth] : []), this.handleGetProcessingStatus.bind(this));

    app.get('/api/observations', ...(readAuth ? [readAuth] : []), this.handleGetObservations.bind(this));
    app.get('/api/observation/:id', ...(readAuth ? [readAuth] : []), this.handleGetObservationById.bind(this));
    app.get('/api/observations/by-file', ...(readAuth ? [readAuth] : []), this.handleGetObservationsByFile.bind(this));
    app.post('/api/observations/batch', ...(readAuth ? [readAuth] : []), this.handleGetObservationsBatch.bind(this));
    app.post('/api/sdk-sessions/batch', ...(readAuth ? [readAuth] : []), this.handleGetSessionsBatch.bind(this));
    app.get('/api/session/:id', ...(readAuth ? [readAuth] : []), this.handleGetSessionById.bind(this));
    app.get('/api/summaries', ...(readAuth ? [readAuth] : []), this.handleGetSummaries.bind(this));
    app.get('/api/prompts', ...(readAuth ? [readAuth] : []), this.handleGetPrompts.bind(this));
    app.get('/api/prompt/:id', ...(readAuth ? [readAuth] : []), this.handleGetPromptById.bind(this));
    app.get('/api/search/prompts', ...(readAuth ? [readAuth] : []), this.handleSearchPrompts.bind(this));
    app.get('/api/search/sessions', ...(readAuth ? [readAuth] : []), this.handleSearchSessions.bind(this));
    app.get('/api/search/observations', ...(readAuth ? [readAuth] : []), this.handleSearchObservations.bind(this));
    app.get('/api/search', ...(readAuth ? [readAuth] : []), this.handleUnifiedSearch.bind(this));
    app.get('/api/search/by-type', ...(readAuth ? [readAuth] : []), (req, res) => this.handleSearchByType(req, res));
    app.get('/api/search/by-concept', ...(readAuth ? [readAuth] : []), this.handleSearchByConcept.bind(this));
    app.get('/api/search/by-file', ...(readAuth ? [readAuth] : []), this.handleSearchByFile.bind(this));
    app.get('/api/decisions', ...(readAuth ? [readAuth] : []), (req, res) => this.handleSearchByType(req, res, 'decision'));
    app.get('/api/changes', ...(readAuth ? [readAuth] : []), (req, res) => this.handleSearchByType(req, res, 'change'));
    app.get('/api/search/help', ...(readAuth ? [readAuth] : []), this.handleSearchHelp.bind(this));

    app.get('/', (_req: Request, res: Response) => {
      const viewerKey = SettingsDefaultsManager.loadFromFile(paths.settings()).CLAUDE_MEM_SERVER_BETA_API_KEY;
      if (
        this.options.pool
        && viewerKey
        && isLocalhost(_req)
        && !_req.header('forwarded')
        && !_req.header('x-forwarded-for')
        && !_req.header('x-forwarded-host')
        && !_req.header('x-real-ip')
      ) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Set-Cookie', `claude_mem_viewer_key=${encodeURIComponent(viewerKey)}; HttpOnly; Path=/; SameSite=Strict`);
      }
      if (!viewerHtmlBytes) {
        res.status(503).json({ error: 'ViewerUnavailable', message: 'Viewer UI not found at any expected location' });
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(viewerHtmlBytes);
    });
  }

  private async getProjectCatalog(req: Request): Promise<{ projects: string[]; sources: string[]; projectsBySource: Record<string, string[]> }> {
    if (!this.options.pool) {
      return { projects: [], sources: ['claude'], projectsBySource: { claude: [] } };
    }

    const teamId = req.authContext?.teamId ?? null;
    if (!teamId) {
      return { projects: [], sources: ['claude'], projectsBySource: { claude: [] } };
    }

    const projectId = req.authContext?.projectId ?? null;
    const result = await this.options.pool.query<{ name: string; platform_source: string | null }>(
      `
        WITH project_sources AS (
          SELECT project_id, team_id, platform_source
          FROM server_sessions
          UNION
          SELECT project_id, team_id, platform_source
          FROM observations
          WHERE platform_source IS NOT NULL
        )
        SELECT p.name, COALESCE(ps.platform_source, 'claude') AS platform_source
        FROM projects p
        LEFT JOIN project_sources ps ON ps.project_id = p.id AND ps.team_id = p.team_id
        WHERE p.team_id = $1 ${projectId ? 'AND p.id = $2' : ''}
        GROUP BY p.id, p.name, COALESCE(ps.platform_source, 'claude')
        ORDER BY p.name ASC
      `,
      projectId ? [teamId, projectId] : [teamId],
    );
    const projectsBySource: Record<string, string[]> = {};
    for (const row of result.rows) {
      const project = typeof row.name === 'string' ? row.name : '';
      if (!project) continue;
      const source = normalizePlatformSource(row.platform_source);
      const sourceProjects = projectsBySource[source] ?? (projectsBySource[source] = []);
      if (!sourceProjects.includes(project)) sourceProjects.push(project);
    }
    const projects = [...new Set(Object.values(projectsBySource).flat())].sort((a, b) => a.localeCompare(b));
    const sources = sortPlatformSources(Object.keys(projectsBySource));
    if (sources.length === 0) {
      return { projects: [], sources: ['claude'], projectsBySource: { claude: [] } };
    }
    return { projects, sources, projectsBySource };
  }

  private handleGetProjects = async (req: Request, res: Response): Promise<void> => {
    if (!this.options.pool) {
      res.json({ projects: [], sources: ['claude'], projectsBySource: { claude: [] } });
      return;
    }

    const teamId = req.authContext?.teamId ?? null;
    const projectId = req.authContext?.projectId ?? null;

    if (!teamId) {
      res.json({ projects: [], sources: ['claude'], projectsBySource: { claude: [] } });
      return;
    }

    const catalog = await this.getProjectCatalog(req);
    const rawPlatformSource = req.query.platformSource;
    if (hasDuplicateQueryParam(req.originalUrl || req.url, 'platformSource') || (rawPlatformSource !== undefined && typeof rawPlatformSource !== 'string')) {
      res.status(400).json({ error: 'ValidationError', message: 'Invalid platformSource' });
      return;
    }
    if (typeof rawPlatformSource === 'string' && rawPlatformSource.trim()) {
      const platformSource = normalizePlatformSource(rawPlatformSource);
      const projects = catalog.projectsBySource[platformSource] ?? [];
      res.json({
        projects,
        sources: [platformSource],
        projectsBySource: { [platformSource]: projects },
      });
      return;
    }
    res.json(catalog);
  };

  private handleGetContextPreview = async (req: Request, res: Response): Promise<void> => {
    const projectName = typeof req.query.project === 'string' ? req.query.project.trim() : '';
    if (!projectName) {
      res.status(400).json({ error: 'Project parameter is required' });
      return;
    }

    const teamId = req.authContext?.teamId ?? null;
    const scopedProjectId = req.authContext?.projectId ?? null;

    let lines: string[] = [];
      if (this.options.pool && teamId) {
        const namedProjectId = await this.resolveUniqueProjectId(teamId, projectName);
        const projectId = namedProjectId && (!scopedProjectId || scopedProjectId === namedProjectId) ? namedProjectId : null;

      if (!projectId) {
        res.status(404).json({ error: 'ProjectNotFound', message: `Project not found: ${projectName}` });
        return;
      }
      const requestedPlatformSource = typeof req.query.platformSource === 'string'
        ? req.query.platformSource.trim()
        : '';
      const platformSource = requestedPlatformSource
        ? normalizePlatformSource(requestedPlatformSource)
        : null;

      const result = await this.options.pool.query<{ content: string | null; metadata: unknown }>(
        `
          SELECT o.content, o.metadata
          FROM observations o
          LEFT JOIN server_sessions s ON s.id = o.server_session_id
          WHERE o.team_id = $1 AND o.project_id = $2
            AND ($3::text IS NULL OR COALESCE(o.platform_source, s.platform_source, 'claude') = $3)
          ORDER BY o.created_at DESC
          LIMIT 8
        `,
        [teamId, projectId, platformSource],
      );
      lines = result.rows
        .map(row => {
          const payload = typeof row.metadata === 'object' && row.metadata !== null ? row.metadata as Record<string, unknown> : {};
          const text = typeof row.content === 'string' && row.content.trim().length > 0 ? row.content : (typeof payload.summary === 'string' ? payload.summary : 'recent context');
          return text.trim();
        })
        .filter((value): value is string => value.length > 0)
        .slice(0, 6);
    }

    const body = lines.length > 0
      ? `# [${projectName}] recent context\n\n${lines.map((line, idx) => `${idx + 1}. ${line}`).join('\n')}`
      : `# [${projectName}] recent context\n\nNo prior memory for this project yet.`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(body);
  };

  private handleGetRecentContext = async (req: Request, res: Response): Promise<void> => {
    if (!this.options.pool || !req.authContext?.teamId) {
      res.json({ content: [{ type: 'text', text: '# Recent Session Context\n\nNo previous sessions found.' }] });
      return;
    }

    const projectName = typeof req.query.project === 'string' ? req.query.project.trim() : '';
    if (!projectName) {
      res.status(400).json({ error: 'ValidationError', message: 'project is required' });
      return;
    }
    const projectId = await this.resolveUniqueProjectId(req.authContext.teamId, projectName);
    if (!projectId || (req.authContext.projectId && req.authContext.projectId !== projectId)) {
      res.json({ content: [{ type: 'text', text: `# Recent Session Context\n\nNo previous sessions found for project "${projectName}".` }] });
      return;
    }
    const requestedPlatformSource = typeof req.query.platformSource === 'string'
      ? req.query.platformSource.trim()
      : '';
    const platformSource = requestedPlatformSource
      ? normalizePlatformSource(requestedPlatformSource)
      : null;

    const result = await this.options.pool.query<{ content: string; created_at: Date | string }>(
      `
        SELECT o.content, o.created_at
        FROM observations o
        LEFT JOIN server_sessions s ON s.id = o.server_session_id
        WHERE o.team_id = $1 AND o.project_id = $2
          AND ($3::text IS NULL OR COALESCE(o.platform_source, s.platform_source, 'claude') = $3)
        ORDER BY o.created_at DESC
        LIMIT 10
      `,
      [req.authContext.teamId, projectId, platformSource],
    );
    const text = result.rows.length === 0
      ? `# Recent Session Context\n\nNo previous sessions found for project "${projectName}".`
      : [
        '# Recent Session Context',
        '',
        `Showing last ${result.rows.length} memory item(s) for **${projectName}**:`,
        '',
        ...result.rows.map(row => `- ${row.content}`),
      ].join('\n');
    res.json({ content: [{ type: 'text', text }] });
  };

  private handleGetContextTimeline = async (req: Request, res: Response): Promise<void> => {
    if (!this.options.pool || !req.authContext?.teamId) {
      res.json({ content: [{ type: 'text', text: '# Context Timeline\n\nNo context found.' }] });
      return;
    }

    const projectName = typeof req.query.project === 'string' ? req.query.project.trim() : '';
    if (!projectName) {
      res.status(400).json({ error: 'ValidationError', message: 'project is required' });
      return;
    }
    const projectId = await this.resolveUniqueProjectId(req.authContext.teamId, projectName);
    if (!projectId || (req.authContext.projectId && req.authContext.projectId !== projectId)) {
      res.json({ content: [{ type: 'text', text: `# Context Timeline\n\nNo context found for project "${projectName}".` }] });
      return;
    }

    const limit = parseBoundedInteger(req.query.limit, 20, 1, 100);
    const requestedPlatformSource = typeof req.query.platformSource === 'string'
      ? req.query.platformSource.trim()
      : '';
    const platformSource = requestedPlatformSource
      ? normalizePlatformSource(requestedPlatformSource)
      : null;
    const result = await this.options.pool.query<{ content: string; kind: string; created_at: Date | string }>(
      `
        SELECT o.content, o.kind, o.created_at
        FROM observations o
        LEFT JOIN server_sessions s ON s.id = o.server_session_id
        WHERE o.team_id = $1 AND o.project_id = $2
          AND ($3::text IS NULL OR COALESCE(o.platform_source, s.platform_source, 'claude') = $3)
        ORDER BY o.created_at DESC
        LIMIT $4
      `,
      [req.authContext.teamId, projectId, platformSource, limit],
    );
    const text = result.rows.length === 0
      ? `# Context Timeline\n\nNo context found for project "${projectName}".`
      : [
        `# Context Timeline: ${projectName}`,
        '',
        ...result.rows.slice().reverse().map(row => `${new Date(row.created_at).toISOString()} [${row.kind}] ${row.content}`),
      ].join('\n');
    res.json({ content: [{ type: 'text', text }] });
  };

  private handleSemanticContext = async (req: Request, res: Response): Promise<void> => {
    if (!this.options.pool || !req.authContext?.teamId) {
      res.json({ context: '', count: 0 });
      return;
    }

    const query = typeof req.body?.q === 'string' ? req.body.q.trim() : '';
    const projectName = typeof req.body?.project === 'string' ? req.body.project.trim() : '';
    if (!query || !projectName) {
      res.json({ context: '', count: 0 });
      return;
    }
    const projectId = await this.resolveUniqueProjectId(req.authContext.teamId, projectName);
    if (!projectId || (req.authContext.projectId && req.authContext.projectId !== projectId)) {
      res.json({ context: '', count: 0 });
      return;
    }

    const rawLimit = Number(req.body?.limit);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 20) : 5;
    const requestedPlatformSource = typeof req.body?.platformSource === 'string'
      ? req.body.platformSource.trim()
      : '';
    const observations = await new PostgresObservationRepository(this.options.pool).search({
      projectId,
      teamId: req.authContext.teamId,
      query,
      platformSource: requestedPlatformSource ? normalizePlatformSource(requestedPlatformSource) : null,
      limit,
    });
    const context = observations
      .map(observation => observation.content)
      .filter(text => typeof text === 'string' && text.length > 0)
      .join('\n\n');
    res.json({ context, count: observations.length });
  };

  private handleContextInject = async (req: Request, res: Response): Promise<void> => {
    if (!this.options.pool || !req.authContext?.teamId) {
      res.type('text/plain').send('No context available.');
      return;
    }

    const rawProjects = req.query.projects ?? req.query.project;
    const projects = (Array.isArray(rawProjects) ? rawProjects : [rawProjects])
      .flatMap(value => typeof value === 'string' ? value.split(',') : [])
      .map(value => value.trim())
      .filter(Boolean);
    if (projects.length === 0) {
      res.status(400).send('Project(s) parameter is required');
      return;
    }

    const sections: string[] = [];
    const requestedPlatformSource = typeof req.query.platformSource === 'string'
      ? req.query.platformSource.trim()
      : '';
    const platformSource = requestedPlatformSource
      ? normalizePlatformSource(requestedPlatformSource)
      : null;
    const repo = new PostgresObservationRepository(this.options.pool);
    for (const projectName of projects) {
      const projectId = await this.resolveUniqueProjectId(req.authContext.teamId, projectName);
      if (!projectId || (req.authContext.projectId && req.authContext.projectId !== projectId)) continue;
      const observations = await repo.listByProject({
        projectId,
        teamId: req.authContext.teamId,
        platformSource,
        limit: 20,
      });
      if (observations.length === 0) continue;
      sections.push([
        `## ${projectName}`,
        ...observations.reverse().map(observation => `- ${observation.content}`),
      ].join('\n'));
    }

    res.type('text/plain').send(sections.length > 0 ? sections.join('\n\n') : 'No context available.');
  };

  private handleTimelineByQuery = async (req: Request, res: Response): Promise<void> => {
    if (!this.options.pool || !req.authContext?.teamId) {
      res.json({ content: [{ type: 'text', text: 'No observations found matching the query.' }] });
      return;
    }
    const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
    if (!query) {
      res.status(400).json({ error: 'ValidationError', message: 'query is required' });
      return;
    }

    const projectName = typeof req.query.project === 'string' ? req.query.project.trim() : '';
    const scopedProjectId = req.authContext.projectId ?? null;
    const projectId = projectName
      ? await this.resolveUniqueProjectId(req.authContext.teamId, projectName)
      : scopedProjectId;
    if (projectName && (!projectId || (scopedProjectId && projectId !== scopedProjectId))) {
      res.json({ content: [{ type: 'text', text: `No observations found matching "${query}".` }] });
      return;
    }
    if (!projectId) {
      res.status(400).json({ error: 'ValidationError', message: 'project is required' });
      return;
    }

    const limit = parseBoundedInteger(req.query.limit, 1, 1, 20);
    const requestedPlatformSource = typeof req.query.platformSource === 'string'
      ? req.query.platformSource.trim()
      : '';
    const observations = await new PostgresObservationRepository(this.options.pool).search({
      projectId,
      teamId: req.authContext.teamId,
      query,
      platformSource: requestedPlatformSource ? normalizePlatformSource(requestedPlatformSource) : null,
      limit,
    });
    if (observations.length === 0) {
      res.json({ content: [{ type: 'text', text: `No observations found matching "${query}". Try a different search query.` }] });
      return;
    }

    const mode = typeof req.query.mode === 'string' ? req.query.mode : 'auto';
    const lines = mode === 'interactive'
      ? [
        '# Timeline Anchor Search Results',
        '',
        `Found ${observations.length} observation(s) matching "${query}"`,
        '',
        ...observations.map((observation, index) => `${index + 1}. [${observation.kind}] Observation ${observation.id}\n   - ${observation.content}`),
      ]
      : [
        `# Timeline for query: "${query}"`,
        `**Anchor:** Observation ${observations[0]!.id} [${observations[0]!.kind}]`,
        '',
        observations[0]!.content,
        '',
        'Broader timeline context is not available in server-beta yet.',
      ];
    res.json({ content: [{ type: 'text', text: lines.join('\n') }] });
  };

  private handleSearchHelp = (req: Request, res: Response): void => {
    const baseUrl = `http://${req.headers.host ?? 'localhost'}`;
    res.json({
      title: 'Claude-Mem Search API',
      description: 'HTTP API for searching persistent memory',
      endpoints: [
        { path: '/api/observation/:id', method: 'GET', description: 'Get one project-scoped observation', parameters: { project: 'Project filter' } },
        { path: '/api/observations/by-file', method: 'GET', description: 'Get observations by repeated file paths', parameters: { path: 'File path(s)', limit: 'Maximum results' } },
        { path: '/api/observations/batch', method: 'POST', description: 'Get observations by ID batch', parameters: { ids: 'Observation ID array' } },
        { path: '/api/session/:id', method: 'GET', description: 'Get one project-scoped session' },
        { path: '/api/sdk-sessions/batch', method: 'POST', description: 'Get sessions by ID batch', parameters: { memorySessionIds: 'Session ID array' } },
        { path: '/api/prompts', method: 'GET', description: 'List durable project prompts', parameters: { project: 'Project filter', limit: 'Maximum results' } },
        { path: '/api/prompt/:id', method: 'GET', description: 'Get one durable prompt' },
        { path: '/api/search', method: 'GET', description: 'Search observations and prompts', parameters: { query: 'Search query', project: 'Project filter', platformSource: 'Platform source filter' } },
        { path: '/api/search/observations', method: 'GET', description: 'Search observations', parameters: { query: 'Search query', project: 'Project filter', platformSource: 'Platform source filter' } },
        { path: '/api/search/prompts', method: 'GET', description: 'Search user prompts', parameters: { query: 'Search query', project: 'Project filter', platformSource: 'Platform source filter' } },
        { path: '/api/search/by-type', method: 'GET', description: 'Find observations by type', parameters: { type: 'Observation type', project: 'Project filter' } },
        { path: '/api/search/by-concept', method: 'GET', description: 'Find observations by concept', parameters: { concept: 'Concept tag', project: 'Project filter' } },
        { path: '/api/search/by-file', method: 'GET', description: 'Find observations by file path', parameters: { path: 'File path or partial path', project: 'Project filter' } },
        { path: '/api/decisions', method: 'GET', description: 'Find decision observations', parameters: { project: 'Project filter' } },
        { path: '/api/changes', method: 'GET', description: 'Find change observations', parameters: { project: 'Project filter' } },
        { path: '/api/timeline/by-query', method: 'GET', description: 'Find a timeline observation anchor', parameters: { query: 'Search query', project: 'Project name', mode: 'auto or interactive' } },
        { path: '/api/context/recent', method: 'GET', description: 'Get recent project context', parameters: { project: 'Project name' } },
        { path: '/api/context/timeline', method: 'GET', description: 'Get a project context timeline', parameters: { project: 'Project name', limit: 'Maximum entries' } },
        { path: '/api/context/inject', method: 'GET', description: 'Build plain-text context for projects', parameters: { project: 'Project name(s)' } },
        { path: '/api/context/semantic', method: 'POST', description: 'Build semantic context', parameters: { q: 'Search query', project: 'Project name' } },
      ],
      examples: [
        `curl "${baseUrl}/api/search/observations?query=authentication"`,
        `curl "${baseUrl}/api/context/recent?project=claude-mem"`,
      ],
    });
  };

  private handleGetSettings = (_req: Request, res: Response): void => {
    res.json(SettingsDefaultsManager.loadFromFile(paths.settings()));
  };

  private async resolveUniqueProjectId(teamId: string, projectName: string): Promise<string | null> {
    if (!this.options.pool) {
      return null;
    }
    const result = await this.options.pool.query<{ id: string }>(
      'SELECT id FROM projects WHERE team_id = $1 AND name = $2 ORDER BY id ASC LIMIT 2',
      [teamId, projectName],
    );
    return result.rows.length === 1 ? result.rows[0]!.id : null;
  }

  private async countViewerRows(
    teamId: string,
    projectId: string | null,
    summariesOnly: boolean,
    platformSource: string | null = null,
  ): Promise<number> {
    if (!this.options.pool) {
      return 0;
    }
    const projectClause = projectId ? 'AND project_id = $2' : '';
    const kindClause = summariesOnly ? "AND kind = 'summary'" : '';
    const sourceParam = projectId ? 3 : 2;
    const result = await this.options.pool.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM observations o
        LEFT JOIN server_sessions s ON s.id = o.server_session_id
        WHERE o.team_id = $1 ${projectClause} ${kindClause}
          AND ($${sourceParam}::text IS NULL OR COALESCE(o.platform_source, s.platform_source, 'claude') = $${sourceParam})
      `,
      projectId ? [teamId, projectId, platformSource] : [teamId, platformSource],
    );
    return Number.parseInt(result.rows[0]?.count ?? '0', 10) || 0;
  }

  private handleGetOnboardingExplainer = (_req: Request, res: Response): void => {
    if (onboardingExplainer === null) {
      res.status(404).json({ error: 'Onboarding explainer not available' });
      return;
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(onboardingExplainer);
  };

  private handleGetObservations = async (req: Request, res: Response): Promise<void> => {
    if (!this.options.pool) {
      res.json({ items: [], hasMore: false, total: 0 });
      return;
    }

    const teamId = req.authContext?.teamId ?? null;
    if (!teamId) {
      res.json({ items: [], hasMore: false, total: 0 });
      return;
    }

    const offset = parseBoundedInteger(req.query.offset, 0, 0, 1000000);
    const limit = parseBoundedInteger(req.query.limit, 50, 1, 100);
    const requestedProject = typeof req.query.project === 'string' ? req.query.project.trim() : '';
    const scopedProjectId = req.authContext?.projectId ?? null;
    const projectId = requestedProject
      ? await this.resolveUniqueProjectId(teamId, requestedProject)
      : scopedProjectId;

    if (requestedProject && (!projectId || (scopedProjectId && projectId !== scopedProjectId))) {
      res.json({ items: [], hasMore: false, total: 0 });
      return;
    }

    const requestedPlatformSource = typeof req.query.platformSource === 'string'
      ? req.query.platformSource.trim()
      : '';
    const platformSource = requestedPlatformSource
      ? normalizePlatformSource(requestedPlatformSource)
      : null;
    const projectClause = projectId ? 'AND o.project_id = $2' : '';
    const sourceParam = projectId ? 3 : 2;
    const limitParam = sourceParam + 1;
    const offsetParam = sourceParam + 2;
    const params = projectId
      ? [teamId, projectId, platformSource, limit + 1, offset]
      : [teamId, platformSource, limit + 1, offset];
    const result = await this.options.pool.query<{
      id: string;
      project: string;
      kind: string;
      content: string;
      metadata: unknown;
      platform_source: string | null;
      created_at: Date | string;
      total_count: string;
    }>(
      `
         SELECT o.id, p.name AS project, o.kind, o.content, o.metadata,
           COALESCE(o.platform_source, s.platform_source) AS platform_source, o.created_at,
           COUNT(*) OVER()::text AS total_count
        FROM observations o
        LEFT JOIN server_sessions s ON s.id = o.server_session_id
        JOIN projects p ON p.id = o.project_id AND p.team_id = o.team_id
        WHERE o.team_id = $1 ${projectClause}
          AND ($${sourceParam}::text IS NULL OR COALESCE(o.platform_source, s.platform_source, 'claude') = $${sourceParam})
        ORDER BY o.created_at DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
      `,
      params,
    );
    const hasMore = result.rows.length > limit;
    const items = result.rows.slice(0, limit).map(row => {
      const metadata = typeof row.metadata === 'object' && row.metadata !== null
        ? row.metadata as Record<string, unknown>
        : {};
      return {
        id: row.id,
        memory_session_id: typeof metadata.memory_session_id === 'string' ? metadata.memory_session_id : '',
        project: row.project,
        platform_source: row.platform_source ?? (typeof metadata.platform_source === 'string' ? metadata.platform_source : 'claude'),
        type: row.kind,
        title: typeof metadata.title === 'string' ? metadata.title : null,
        subtitle: typeof metadata.subtitle === 'string' ? metadata.subtitle : null,
        narrative: row.content,
        text: row.content,
        facts: typeof metadata.facts === 'string' ? metadata.facts : null,
        concepts: typeof metadata.concepts === 'string' ? metadata.concepts : null,
        files_read: typeof metadata.files_read === 'string' ? metadata.files_read : null,
        files_modified: typeof metadata.files_modified === 'string' ? metadata.files_modified : null,
        prompt_number: typeof metadata.prompt_number === 'number' ? metadata.prompt_number : null,
        created_at: new Date(row.created_at).toISOString(),
        created_at_epoch: new Date(row.created_at).getTime(),
      };
    });
    const total = result.rows.length > 0
      ? Number.parseInt(result.rows[0]!.total_count, 10) || 0
      : await this.countViewerRows(teamId, projectId, false, platformSource);
    res.json({ items, hasMore, total });
  };

  private handleGetObservationById = async (req: Request, res: Response): Promise<void> => {
    if (!this.options.pool || !req.authContext?.teamId) {
      res.status(404).json({ error: 'ObservationNotFound' });
      return;
    }
    const projectName = typeof req.query.project === 'string' ? req.query.project.trim() : '';
    const scopedProjectId = req.authContext.projectId ?? null;
    const projectId = projectName
      ? await this.resolveUniqueProjectId(req.authContext.teamId, projectName)
      : scopedProjectId;
    if (!projectId || (scopedProjectId && projectId !== scopedProjectId)) {
      res.status(404).json({ error: 'ObservationNotFound' });
      return;
    }
    const requestedPlatformSource = typeof req.query.platformSource === 'string'
      ? req.query.platformSource.trim()
      : '';

    const observation = await new PostgresObservationRepository(this.options.pool).getByIdForScope({
      id: String(req.params.id),
      projectId,
      teamId: req.authContext.teamId,
      platformSource: requestedPlatformSource ? normalizePlatformSource(requestedPlatformSource) : null,
    });
    if (!observation) {
      res.status(404).json({ error: 'ObservationNotFound' });
      return;
    }
    res.json({
      id: observation.id,
      project_id: observation.projectId,
      server_session_id: observation.serverSessionId,
      type: observation.kind,
      content: observation.content,
      metadata: observation.metadata,
      created_at_epoch: observation.createdAtEpoch,
      updated_at_epoch: observation.updatedAtEpoch,
    });
  };

  private handleGetObservationsByFile = async (req: Request, res: Response): Promise<void> => {
    const rawPaths = req.query.path;
    const paths = (Array.isArray(rawPaths) ? rawPaths : [rawPaths])
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map(value => value.trim());
    if (paths.length === 0) {
      res.status(400).json({ error: 'ValidationError', message: 'path query parameter is required' });
      return;
    }
    if (!this.options.pool || !req.authContext?.teamId || !req.authContext.projectId) {
      res.json({ observations: [], count: 0 });
      return;
    }
    const patterns = paths.map(pathValue => `%${pathValue}%`);
    const requestedPlatformSource = typeof req.query.platformSource === 'string'
      ? req.query.platformSource.trim()
      : '';
    const platformSource = requestedPlatformSource
      ? normalizePlatformSource(requestedPlatformSource)
      : null;
    const result = await this.options.pool.query<{
      id: string;
      project_id: string;
      server_session_id: string | null;
      kind: string;
      content: string;
      metadata: unknown;
      created_at: Date | string;
      updated_at: Date | string;
    }>(
      `
        SELECT o.id, o.project_id, o.server_session_id, o.kind, o.content, o.metadata, o.created_at, o.updated_at
        FROM observations o
        LEFT JOIN server_sessions s ON s.id = o.server_session_id
        WHERE o.team_id = $1 AND o.project_id = $2
          AND EXISTS (
            SELECT 1 FROM unnest($3::text[]) AS requested_path
            WHERE o.metadata->>'files_read' ILIKE requested_path
               OR o.metadata->>'files_modified' ILIKE requested_path
          )
          AND ($5::text IS NULL OR COALESCE(o.platform_source, s.platform_source, 'claude') = $5)
        ORDER BY o.created_at DESC
        LIMIT $4
      `,
      [req.authContext.teamId, req.authContext.projectId, patterns, parseBoundedInteger(req.query.limit, 100, 1, 100), platformSource],
    );
    res.json({
      observations: result.rows.map(row => ({
        id: row.id,
        project_id: row.project_id,
        server_session_id: row.server_session_id,
        type: row.kind,
        content: row.content,
        metadata: row.metadata,
        created_at_epoch: new Date(row.created_at).getTime(),
        updated_at_epoch: new Date(row.updated_at).getTime(),
      })),
      count: result.rows.length,
    });
  };

  private handleGetObservationsBatch = async (req: Request, res: Response): Promise<void> => {
    if (!this.options.pool || !req.authContext?.teamId) {
      res.json([]);
      return;
    }
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0).slice(0, 100)
      : [];
    const projectId = req.authContext.projectId;
    if (!projectId || ids.length === 0) {
      res.json([]);
      return;
    }
    const requestedPlatformSource = typeof req.query.platformSource === 'string'
      ? req.query.platformSource.trim()
      : '';
    const platformSource = requestedPlatformSource
      ? normalizePlatformSource(requestedPlatformSource)
      : null;

    const result = await this.options.pool.query<{
      id: string;
      project_id: string;
      server_session_id: string | null;
      kind: string;
      content: string;
      metadata: unknown;
      created_at: Date | string;
      updated_at: Date | string;
    }>(
      `
        SELECT o.id, o.project_id, o.server_session_id, o.kind, o.content, o.metadata, o.created_at, o.updated_at
        FROM observations o
        LEFT JOIN server_sessions s ON s.id = o.server_session_id
        WHERE o.team_id = $1 AND o.project_id = $2 AND o.id = ANY($3::text[])
          AND ($4::text IS NULL OR COALESCE(o.platform_source, s.platform_source, 'claude') = $4)
        ORDER BY o.created_at DESC
      `,
      [req.authContext.teamId, projectId, ids, platformSource],
    );
    res.json(result.rows.map(row => ({
      id: row.id,
      project_id: row.project_id,
      server_session_id: row.server_session_id,
      type: row.kind,
      content: row.content,
      metadata: row.metadata,
      created_at_epoch: new Date(row.created_at).getTime(),
      updated_at_epoch: new Date(row.updated_at).getTime(),
    })));
  };

  private handleGetSessionById = async (req: Request, res: Response): Promise<void> => {
    if (!this.options.pool || !req.authContext?.teamId) {
      res.status(404).json({ error: 'SessionNotFound' });
      return;
    }
    const projectId = req.authContext.projectId;
    if (!projectId) {
      res.status(404).json({ error: 'SessionNotFound' });
      return;
    }
    const requestedPlatformSource = typeof req.query.platformSource === 'string'
      ? req.query.platformSource.trim()
      : '';
    const session = await new PostgresServerSessionsRepository(this.options.pool).getByIdForScope({
      id: String(req.params.id),
      projectId,
      teamId: req.authContext.teamId,
      platformSource: requestedPlatformSource ? normalizePlatformSource(requestedPlatformSource) : null,
    });
    if (!session) {
      res.status(404).json({ error: 'SessionNotFound' });
      return;
    }
    res.json({
      id: session.id,
      project_id: session.projectId,
      team_id: session.teamId,
      content_session_id: session.contentSessionId,
      external_session_id: session.externalSessionId,
      platform_source: session.platformSource,
      generation_status: session.generationStatus,
      metadata: session.metadata,
      started_at_epoch: session.startedAtEpoch,
      ended_at_epoch: session.endedAtEpoch,
      last_generated_at_epoch: session.lastGeneratedAtEpoch,
    });
  };

  private handleGetSessionsBatch = async (req: Request, res: Response): Promise<void> => {
    if (!this.options.pool || !req.authContext?.teamId || !req.authContext.projectId) {
      res.json([]);
      return;
    }

    const rawBody = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    const rawIds = rawBody.memorySessionIds !== undefined && rawBody.memorySessionIds !== null
      ? rawBody.memorySessionIds
      : rawBody.sdkSessionIds !== undefined && rawBody.sdkSessionIds !== null
        ? rawBody.sdkSessionIds
        : [];

    const normalizedIds = Array.isArray(rawIds)
      ? rawIds
      : typeof rawIds === 'string'
        ? (() => {
            try {
              const parsed = JSON.parse(rawIds);
              return Array.isArray(parsed) ? parsed : rawIds.split(',');
            } catch {
              return rawIds.split(',');
            }
          })()
        : [];

    const ids = normalizedIds
      .map((id: unknown) => typeof id === 'string' ? id.trim() : String(id).trim())
      .filter((id: string) => id.length > 0)
      .slice(0, 100);
    if (ids.length === 0) {
      res.json([]);
      return;
    }
    const requestedPlatformSource = typeof req.query.platformSource === 'string'
      ? req.query.platformSource.trim()
      : '';
    const platformSource = requestedPlatformSource
      ? normalizePlatformSource(requestedPlatformSource)
      : null;

    const result = await this.options.pool.query<{
      id: string;
      project_id: string;
      team_id: string;
      external_session_id: string | null;
      content_session_id: string | null;
      platform_source: string | null;
      generation_status: string;
      metadata: unknown;
      started_at: Date | string;
      ended_at: Date | string | null;
      last_generated_at: Date | string | null;
    }>(
      `
        SELECT id, project_id, team_id, external_session_id, content_session_id,
          platform_source, generation_status, metadata, started_at, ended_at, last_generated_at
        FROM server_sessions
        WHERE team_id = $1 AND project_id = $2 AND id = ANY($3::text[])
          AND ($4::text IS NULL OR COALESCE(platform_source, 'claude') = $4)
        ORDER BY started_at DESC
      `,
      [req.authContext.teamId, req.authContext.projectId, ids, platformSource],
    );
    res.json(result.rows.map(row => ({
      id: row.id,
      project_id: row.project_id,
      team_id: row.team_id,
      external_session_id: row.external_session_id,
      content_session_id: row.content_session_id,
      platform_source: row.platform_source,
      generation_status: row.generation_status,
      metadata: row.metadata,
      started_at_epoch: new Date(row.started_at).getTime(),
      ended_at_epoch: row.ended_at ? new Date(row.ended_at).getTime() : null,
      last_generated_at_epoch: row.last_generated_at ? new Date(row.last_generated_at).getTime() : null,
    })));
  };

  private handleGetSummaries = async (req: Request, res: Response): Promise<void> => {
    if (!this.options.pool) {
      res.json({ items: [], hasMore: false, total: 0 });
      return;
    }

    const teamId = req.authContext?.teamId ?? null;
    if (!teamId) {
      res.json({ items: [], hasMore: false, total: 0 });
      return;
    }

    const offset = parseBoundedInteger(req.query.offset, 0, 0, 1000000);
    const limit = parseBoundedInteger(req.query.limit, 50, 1, 100);
    const requestedProject = typeof req.query.project === 'string' ? req.query.project.trim() : '';
    const scopedProjectId = req.authContext?.projectId ?? null;
    const projectId = requestedProject
      ? await this.resolveUniqueProjectId(teamId, requestedProject)
      : scopedProjectId;

    if (requestedProject && (!projectId || (scopedProjectId && projectId !== scopedProjectId))) {
      res.json({ items: [], hasMore: false, total: 0 });
      return;
    }

    const requestedPlatformSource = typeof req.query.platformSource === 'string'
      ? req.query.platformSource.trim()
      : '';
    const platformSource = requestedPlatformSource
      ? normalizePlatformSource(requestedPlatformSource)
      : null;
    const projectClause = projectId ? 'AND o.project_id = $2' : '';
    const sourceParam = projectId ? 3 : 2;
    const limitParam = sourceParam + 1;
    const offsetParam = sourceParam + 2;
    const params = projectId
      ? [teamId, projectId, platformSource, limit + 1, offset]
      : [teamId, platformSource, limit + 1, offset];
    const result = await this.options.pool.query<{
      id: string;
      project: string;
      server_session_id: string | null;
      content: string;
      metadata: unknown;
      platform_source: string | null;
      created_at: Date | string;
      total_count: string;
    }>(
      `
        SELECT o.id, p.name AS project, o.server_session_id, o.content, o.metadata,
          s.platform_source, o.created_at,
           COUNT(*) OVER()::text AS total_count
        FROM observations o
        LEFT JOIN server_sessions s ON s.id = o.server_session_id
        JOIN projects p ON p.id = o.project_id AND p.team_id = o.team_id
        WHERE o.team_id = $1 AND o.kind = 'summary' ${projectClause}
          AND ($${sourceParam}::text IS NULL OR COALESCE(o.platform_source, s.platform_source, 'claude') = $${sourceParam})
        ORDER BY o.created_at DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
      `,
      params,
    );
    const hasMore = result.rows.length > limit;
    const items = result.rows.slice(0, limit).map(row => {
      const metadata = typeof row.metadata === 'object' && row.metadata !== null
        ? row.metadata as Record<string, unknown>
        : {};
      const text = valueAsString(row.content);
      return {
        id: row.id,
        session_id: row.server_session_id ?? '',
        project: row.project,
        platform_source: row.platform_source ?? valueAsString(metadata.platform_source) ?? 'claude',
        request: valueAsString(metadata.request) ?? text,
        investigated: valueAsString(metadata.investigated),
        learned: valueAsString(metadata.learned),
        completed: valueAsString(metadata.completed),
        next_steps: valueAsString(metadata.next_steps),
        created_at_epoch: new Date(row.created_at).getTime(),
      };
    });
    const total = result.rows.length > 0
      ? Number.parseInt(result.rows[0]!.total_count, 10) || 0
      : await this.countViewerRows(teamId, projectId, true, platformSource);
    res.json({ items, hasMore, total });
  };

  private handleGetPrompts = async (req: Request, res: Response): Promise<void> => {
    if (!this.options.pool) {
      res.json({ items: [], hasMore: false, total: 0 });
      return;
    }

    const teamId = req.authContext?.teamId ?? null;
    if (!teamId) {
      res.json({ items: [], hasMore: false, total: 0 });
      return;
    }

    const offset = parseBoundedInteger(req.query.offset, 0, 0, 1000000);
    const limit = parseBoundedInteger(req.query.limit, 50, 1, 100);
    const requestedProject = typeof req.query.project === 'string' ? req.query.project.trim() : '';
    const scopedProjectId = req.authContext?.projectId ?? null;
    const projectId = requestedProject
      ? await this.resolveUniqueProjectId(teamId, requestedProject)
      : scopedProjectId;

    if (requestedProject && (!projectId || (scopedProjectId && projectId !== scopedProjectId))) {
      res.json({ items: [], hasMore: false, total: 0 });
      return;
    }

    const requestedPlatformSource = typeof req.query.platformSource === 'string'
      ? req.query.platformSource.trim()
      : '';
    const platformSource = requestedPlatformSource
      ? normalizePlatformSource(requestedPlatformSource)
      : null;
    const projectClause = projectId ? 'AND sp.project_id = $2' : '';
    const sourceParam = projectId ? 3 : 2;
    const limitParam = sourceParam + 1;
    const offsetParam = sourceParam + 2;
    const params = projectId
      ? [teamId, projectId, platformSource, limit + 1, offset]
      : [teamId, platformSource, limit + 1, offset];
    const result = await this.options.pool.query<PromptEventRow>(
      `
        SELECT sp.id, sp.server_session_id, s.content_session_id, p.name AS project,
          jsonb_build_object(
            'prompt', sp.prompt_text,
            'prompt_number', sp.prompt_number,
            'platform_source', s.platform_source
          ) AS payload,
          sp.occurred_at, COUNT(*) OVER()::text AS total_count
        FROM server_prompts sp
        JOIN server_sessions s ON s.id = sp.server_session_id
        JOIN projects p ON p.id = sp.project_id AND p.team_id = sp.team_id
        WHERE sp.team_id = $1 ${projectClause}
          AND ($${sourceParam}::text IS NULL OR COALESCE(s.platform_source, 'claude') = $${sourceParam})
        ORDER BY sp.occurred_at DESC, sp.id DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
      `,
      params,
    );
    const hasMore = result.rows.length > limit;
    const items = result.rows.slice(0, limit).map(row => serializePrompt(row));
    const total = result.rows.length > 0
      ? Number.parseInt(result.rows[0]!.total_count, 10) || 0
      : await this.countPromptRows(teamId, projectId, platformSource);
    res.json({ items, hasMore, total });
  };

  private handleGetPromptById = async (req: Request, res: Response): Promise<void> => {
    if (!this.options.pool || !req.authContext?.teamId) {
      res.status(404).json({ error: 'PromptNotFound' });
      return;
    }
    const requestedPlatformSource = typeof req.query.platformSource === 'string'
      ? req.query.platformSource.trim()
      : '';
    const platformSource = requestedPlatformSource
      ? normalizePlatformSource(requestedPlatformSource)
      : null;

    const result = await this.options.pool.query<PromptEventRow>(
      `
        SELECT sp.id, sp.server_session_id, s.content_session_id, p.name AS project,
          jsonb_build_object(
            'prompt', sp.prompt_text,
            'prompt_number', sp.prompt_number,
            'platform_source', s.platform_source
          ) AS payload,
          sp.occurred_at, 1::text AS total_count
        FROM server_prompts sp
        JOIN server_sessions s ON s.id = sp.server_session_id
        JOIN projects p ON p.id = sp.project_id AND p.team_id = sp.team_id
        WHERE sp.id = $1 AND sp.team_id = $2
          AND ($3::text IS NULL OR sp.project_id = $3)
          AND ($4::text IS NULL OR COALESCE(s.platform_source, 'claude') = $4)
      `,
      [String(req.params.id), req.authContext.teamId, req.authContext.projectId ?? null, platformSource],
    );
    const row = result.rows[0];
    if (!row) {
      res.status(404).json({ error: 'PromptNotFound' });
      return;
    }
    res.json(serializePrompt(row));
  };

  private handleSearchPrompts = async (req: Request, res: Response): Promise<void> => {
    if (!this.options.pool || !req.authContext?.teamId) {
      res.json({ content: [{ type: 'text', text: 'No user prompts found' }] });
      return;
    }

    const query = typeof req.query.query === 'string'
      ? req.query.query.trim()
      : typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const projectName = typeof req.query.project === 'string' ? req.query.project.trim() : '';
    const teamId = req.authContext.teamId;
    const scopedProjectId = req.authContext.projectId ?? null;
    const requestedProjectId = projectName
      ? await this.resolveUniqueProjectId(teamId, projectName)
      : scopedProjectId;

    if (projectName && (!requestedProjectId || (scopedProjectId && requestedProjectId !== scopedProjectId))) {
      res.json({ content: [{ type: 'text', text: query ? `No user prompts found matching "${query}"` : 'No user prompts found' }] });
      return;
    }

    const requestedPlatformSource = typeof req.query.platformSource === 'string'
      ? req.query.platformSource.trim()
      : '';
    const platformSource = requestedPlatformSource
      ? normalizePlatformSource(requestedPlatformSource)
      : null;
    const sourceParam = requestedProjectId ? 4 : 3;
    const projectClause = requestedProjectId ? 'AND sp.project_id = $3' : '';
    const values: unknown[] = [teamId, `%${query}%`];
    if (requestedProjectId) values.push(requestedProjectId);
    values.push(platformSource);
    const result = await this.options.pool.query<SearchPromptRow>(
      `
        SELECT sp.id, p.name AS project, s.content_session_id, s.platform_source,
          sp.prompt_text, sp.prompt_number::text AS prompt_number, sp.occurred_at AS started_at
        FROM server_prompts sp
        JOIN server_sessions s ON s.id = sp.server_session_id
        JOIN projects p ON p.id = s.project_id AND p.team_id = s.team_id
        WHERE sp.team_id = $1
          AND sp.prompt_text ILIKE $2 ${projectClause}
          AND ($${sourceParam}::text IS NULL OR COALESCE(s.platform_source, 'claude') = $${sourceParam})
        ORDER BY sp.occurred_at DESC, sp.id DESC
        LIMIT 100
      `,
      values,
    );
    const text = result.rows.length === 0
      ? (query ? `No user prompts found matching "${query}"` : 'No user prompts found')
      : [
        `Found ${result.rows.length} user prompt(s)${query ? ` matching "${query}"` : ''}`,
        '',
        ...result.rows.map((row, index) => {
          const promptNumber = row.prompt_number ? ` #${row.prompt_number}` : '';
          return `${index + 1}. [${row.project}]${promptNumber} ${row.prompt_text}`;
        }),
      ].join('\n');
    res.json({ content: [{ type: 'text', text }] });
  };

  private handleSearchSessions = async (req: Request, res: Response): Promise<void> => {
    if (!this.options.pool || !req.authContext?.teamId) {
      res.json({ content: [{ type: 'text', text: 'No sessions found matching ""' }] });
      return;
    }

    const query = typeof req.query.query === 'string'
      ? req.query.query.trim()
      : typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const projectName = typeof req.query.project === 'string' ? req.query.project.trim() : '';
    const teamId = req.authContext.teamId;
    const scopedProjectId = req.authContext.projectId ?? null;
    const requestedProjectId = projectName
      ? await this.resolveUniqueProjectId(teamId, projectName)
      : scopedProjectId;

    if (projectName && (!requestedProjectId || (scopedProjectId && requestedProjectId !== scopedProjectId))) {
      res.json({ content: [{ type: 'text', text: `No sessions found matching "${query}"` }] });
      return;
    }

    const requestedPlatformSource = typeof req.query.platformSource === 'string'
      ? req.query.platformSource.trim()
      : '';
    const platformSource = requestedPlatformSource
      ? normalizePlatformSource(requestedPlatformSource)
      : null;
    const projectClause = requestedProjectId ? 'AND o.project_id = $3' : '';
    const sourceParam = requestedProjectId ? 4 : 3;
    const values: unknown[] = [teamId, `%${query}%`];
    if (requestedProjectId) values.push(requestedProjectId);
    values.push(platformSource);
    const result = await this.options.pool.query<{
      id: string;
      project: string;
      content: string;
      started_at: Date | string;
    }>(
      `
        SELECT o.server_session_id AS id, p.name AS project, o.content, s.started_at
        FROM observations o
        JOIN projects p ON p.id = o.project_id AND p.team_id = o.team_id
        JOIN server_sessions s ON s.id = o.server_session_id
        WHERE o.team_id = $1 AND o.kind = 'summary'
          AND (o.content ILIKE $2 OR o.metadata::text ILIKE $2) ${projectClause}
          AND ($${sourceParam}::text IS NULL OR COALESCE(o.platform_source, s.platform_source, 'claude') = $${sourceParam})
        ORDER BY s.started_at DESC, o.created_at DESC
        LIMIT 100
      `,
      values,
    );
    const text = result.rows.length === 0
      ? `No sessions found matching "${query}"`
      : [
        `Found ${result.rows.length} session(s) matching "${query}"`,
        '',
        ...result.rows.map((row, index) => `${index + 1}. [${row.project}] ${row.content}`),
      ].join('\n');
    res.json({ content: [{ type: 'text', text }] });
  };

  private handleSearchObservations = async (req: Request, res: Response): Promise<void> => {
    if (!this.options.pool || !req.authContext?.teamId) {
      res.json({ content: [{ type: 'text', text: 'No observations found' }] });
      return;
    }

    const query = typeof req.query.query === 'string'
      ? req.query.query.trim()
      : typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const projectName = typeof req.query.project === 'string' ? req.query.project.trim() : '';
    const teamId = req.authContext.teamId;
    const scopedProjectId = req.authContext.projectId ?? null;
    const requestedProjectId = projectName
      ? await this.resolveUniqueProjectId(teamId, projectName)
      : scopedProjectId;

    if (projectName && (!requestedProjectId || (scopedProjectId && requestedProjectId !== scopedProjectId))) {
      res.json({ content: [{ type: 'text', text: query ? `No observations found matching "${query}"` : 'No observations found' }] });
      return;
    }

    const requestedPlatformSource = typeof req.query.platformSource === 'string'
      ? req.query.platformSource.trim()
      : '';
    const platformSource = requestedPlatformSource
      ? normalizePlatformSource(requestedPlatformSource)
      : null;
    const projectClause = requestedProjectId ? 'AND o.project_id = $3' : '';
    const sourceParam = requestedProjectId ? 4 : 3;
    const values: unknown[] = [teamId, `%${query}%`];
    if (requestedProjectId) values.push(requestedProjectId);
    values.push(platformSource);
    const result = await this.options.pool.query<{
      id: string;
      project: string;
      kind: string;
      content: string;
    }>(
      `
        SELECT o.id, p.name AS project, o.kind, o.content
        FROM observations o
        LEFT JOIN server_sessions s ON s.id = o.server_session_id
        JOIN projects p ON p.id = o.project_id AND p.team_id = o.team_id
        WHERE o.team_id = $1
          AND (o.content ILIKE $2 OR o.metadata::text ILIKE $2) ${projectClause}
          AND ($${sourceParam}::text IS NULL OR COALESCE(o.platform_source, s.platform_source, 'claude') = $${sourceParam})
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT 100
      `,
      values,
    );
    const text = result.rows.length === 0
      ? (query ? `No observations found matching "${query}"` : 'No observations found')
      : [
        `Found ${result.rows.length} observation(s)${query ? ` matching "${query}"` : ''}`,
        '',
        ...result.rows.map((row, index) => `${index + 1}. [${row.project}] #${row.id} (${row.kind}) ${row.content}`),
      ].join('\n');
    res.json({ content: [{ type: 'text', text }] });
  };

  private handleUnifiedSearch = async (req: Request, res: Response): Promise<void> => {
    if (!this.options.pool || !req.authContext?.teamId) {
      res.json({ content: [{ type: 'text', text: 'No results found' }] });
      return;
    }

    const query = typeof req.query.query === 'string'
      ? req.query.query.trim()
      : typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const projectName = typeof req.query.project === 'string' ? req.query.project.trim() : '';
    const teamId = req.authContext.teamId;
    const scopedProjectId = req.authContext.projectId ?? null;
    const requestedProjectId = projectName
      ? await this.resolveUniqueProjectId(teamId, projectName)
      : scopedProjectId;

    if (projectName && (!requestedProjectId || (scopedProjectId && requestedProjectId !== scopedProjectId))) {
      res.json({ content: [{ type: 'text', text: `No results found matching "${query}"` }] });
      return;
    }

    const requestedPlatformSource = typeof req.query.platformSource === 'string'
      ? req.query.platformSource.trim()
      : '';
    const platformSource = requestedPlatformSource
      ? normalizePlatformSource(requestedPlatformSource)
      : null;
    const projectClause = requestedProjectId ? 'AND project_id = $3' : '';
    const sourceParam = requestedProjectId ? 4 : 3;
    const values: unknown[] = [teamId, `%${query}%`];
    if (requestedProjectId) values.push(requestedProjectId);
    values.push(platformSource);
    const result = await this.options.pool.query<UnifiedSearchRow>(
      `
        SELECT 'observation' AS result_type, o.id::text AS id, p.name AS project, o.content AS text, o.created_at
        FROM observations o
        LEFT JOIN server_sessions s ON s.id = o.server_session_id
        JOIN projects p ON p.id = o.project_id AND p.team_id = o.team_id
        WHERE o.team_id = $1 AND (o.content ILIKE $2 OR o.metadata::text ILIKE $2) ${projectClause.replace('project_id', 'o.project_id')}
          AND ($${sourceParam}::text IS NULL OR COALESCE(o.platform_source, s.platform_source, 'claude') = $${sourceParam})
        UNION ALL
        SELECT 'prompt' AS result_type, sp.id::text AS id, p.name AS project, sp.prompt_text AS text, sp.occurred_at AS created_at
        FROM server_prompts sp
        JOIN server_sessions s ON s.id = sp.server_session_id
        JOIN projects p ON p.id = s.project_id AND p.team_id = s.team_id
        WHERE sp.team_id = $1 AND sp.prompt_text ILIKE $2 ${projectClause.replace('project_id', 'sp.project_id')}
          AND ($${sourceParam}::text IS NULL OR COALESCE(s.platform_source, 'claude') = $${sourceParam})
        ORDER BY created_at DESC, id DESC
        LIMIT 100
      `,
      values,
    );
    const text = result.rows.length === 0
      ? `No results found matching "${query}"`
      : [
        `Found ${result.rows.length} result(s)${query ? ` matching "${query}"` : ''}`,
        '',
        ...result.rows.map((row, index) => `${index + 1}. [${row.result_type}] [${row.project}] ${row.text}`),
      ].join('\n');
    res.json({ content: [{ type: 'text', text }] });
  };

  private handleSearchByType = async (req: Request, res: Response, fixedKind?: string): Promise<void> => {
    if (!this.options.pool || !req.authContext?.teamId) {
      res.json({ content: [{ type: 'text', text: 'No observations found' }] });
      return;
    }

    const kind = fixedKind ?? (typeof req.query.type === 'string' ? req.query.type.trim() : '');
    const teamId = req.authContext.teamId;
    const projectName = typeof req.query.project === 'string' ? req.query.project.trim() : '';
    const scopedProjectId = req.authContext.projectId ?? null;
    const requestedProjectId = projectName
      ? await this.resolveUniqueProjectId(teamId, projectName)
      : scopedProjectId;

    if (!kind) {
      res.status(400).json({ error: 'ValidationError', message: 'type is required' });
      return;
    }
    if (projectName && (!requestedProjectId || (scopedProjectId && requestedProjectId !== scopedProjectId))) {
      res.json({ content: [{ type: 'text', text: `No observations found with type "${kind}"` }] });
      return;
    }

    const requestedPlatformSource = typeof req.query.platformSource === 'string'
      ? req.query.platformSource.trim()
      : '';
    const platformSource = requestedPlatformSource
      ? normalizePlatformSource(requestedPlatformSource)
      : null;
    const projectClause = requestedProjectId ? 'AND o.project_id = $3' : '';
    const sourceParam = requestedProjectId ? 4 : 3;
    const values: unknown[] = [teamId, kind];
    if (requestedProjectId) values.push(requestedProjectId);
    values.push(platformSource);
    const result = await this.options.pool.query<{ id: string; project: string; content: string }>(
      `
        SELECT o.id, p.name AS project, o.content
        FROM observations o
        LEFT JOIN server_sessions s ON s.id = o.server_session_id
        JOIN projects p ON p.id = o.project_id AND p.team_id = o.team_id
        WHERE o.team_id = $1 AND o.kind = $2 ${projectClause}
          AND ($${sourceParam}::text IS NULL OR COALESCE(o.platform_source, s.platform_source, 'claude') = $${sourceParam})
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT 100
      `,
      values,
    );
    const text = result.rows.length === 0
      ? `No observations found with type "${kind}"`
      : [
        `Found ${result.rows.length} observation(s) with type "${kind}"`,
        '',
        ...result.rows.map((row, index) => `${index + 1}. [${row.project}] #${row.id} ${row.content}`),
      ].join('\n');
    res.json({ content: [{ type: 'text', text }] });
  };

  private handleSearchByConcept = async (req: Request, res: Response): Promise<void> => {
    if (!this.options.pool || !req.authContext?.teamId) {
      res.json({ content: [{ type: 'text', text: 'No observations found' }] });
      return;
    }

    const rawConcept = req.query.concept ?? req.query.concepts;
    const concept = Array.isArray(rawConcept) ? rawConcept[0] : rawConcept;
    const normalizedConcept = typeof concept === 'string' ? concept.trim() : '';
    if (!normalizedConcept) {
      res.status(400).json({ error: 'ValidationError', message: 'concept is required' });
      return;
    }

    const teamId = req.authContext.teamId;
    const projectName = typeof req.query.project === 'string' ? req.query.project.trim() : '';
    const scopedProjectId = req.authContext.projectId ?? null;
    const requestedProjectId = projectName
      ? await this.resolveUniqueProjectId(teamId, projectName)
      : scopedProjectId;
    if (projectName && (!requestedProjectId || (scopedProjectId && requestedProjectId !== scopedProjectId))) {
      res.json({ content: [{ type: 'text', text: `No observations found with concept "${normalizedConcept}"` }] });
      return;
    }

    const requestedPlatformSource = typeof req.query.platformSource === 'string'
      ? req.query.platformSource.trim()
      : '';
    const platformSource = requestedPlatformSource
      ? normalizePlatformSource(requestedPlatformSource)
      : null;
    const projectClause = requestedProjectId ? 'AND o.project_id = $3' : '';
    const sourceParam = requestedProjectId ? 4 : 3;
    const values: unknown[] = [teamId, `%${normalizedConcept}%`];
    if (requestedProjectId) values.push(requestedProjectId);
    values.push(platformSource);
    const result = await this.options.pool.query<{ id: string; project: string; kind: string; content: string }>(
      `
        SELECT o.id, p.name AS project, o.kind, o.content
        FROM observations o
        LEFT JOIN server_sessions s ON s.id = o.server_session_id
        JOIN projects p ON p.id = o.project_id AND p.team_id = o.team_id
        WHERE o.team_id = $1 AND o.metadata::text ILIKE $2 ${projectClause}
          AND ($${sourceParam}::text IS NULL OR COALESCE(o.platform_source, s.platform_source, 'claude') = $${sourceParam})
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT 100
      `,
      values,
    );
    const text = result.rows.length === 0
      ? `No observations found with concept "${normalizedConcept}"`
      : [
        `Found ${result.rows.length} observation(s) with concept "${normalizedConcept}"`,
        '',
        ...result.rows.map((row, index) => `${index + 1}. [${row.project}] #${row.id} (${row.kind}) ${row.content}`),
      ].join('\n');
    res.json({ content: [{ type: 'text', text }] });
  };

  private handleSearchByFile = async (req: Request, res: Response): Promise<void> => {
    if (!this.options.pool || !req.authContext?.teamId) {
      res.json({ content: [{ type: 'text', text: 'No observations found' }] });
      return;
    }

    const rawPath = req.query.path ?? req.query.file;
    const filePath = Array.isArray(rawPath) ? rawPath[0] : rawPath;
    const normalizedPath = typeof filePath === 'string' ? filePath.trim() : '';
    if (!normalizedPath) {
      res.status(400).json({ error: 'ValidationError', message: 'path is required' });
      return;
    }

    const teamId = req.authContext.teamId;
    const projectName = typeof req.query.project === 'string' ? req.query.project.trim() : '';
    const scopedProjectId = req.authContext.projectId ?? null;
    const requestedProjectId = projectName
      ? await this.resolveUniqueProjectId(teamId, projectName)
      : scopedProjectId;
    if (projectName && (!requestedProjectId || (scopedProjectId && requestedProjectId !== scopedProjectId))) {
      res.json({ content: [{ type: 'text', text: `No observations found for file "${normalizedPath}"` }] });
      return;
    }

    const requestedPlatformSource = typeof req.query.platformSource === 'string'
      ? req.query.platformSource.trim()
      : '';
    const platformSource = requestedPlatformSource
      ? normalizePlatformSource(requestedPlatformSource)
      : null;
    const projectClause = requestedProjectId ? 'AND o.project_id = $3' : '';
    const sourceParam = requestedProjectId ? 4 : 3;
    const values: unknown[] = [teamId, `%${normalizedPath}%`];
    if (requestedProjectId) values.push(requestedProjectId);
    values.push(platformSource);
    const result = await this.options.pool.query<{ id: string; project: string; kind: string; content: string }>(
      `
        SELECT o.id, p.name AS project, o.kind, o.content
        FROM observations o
        LEFT JOIN server_sessions s ON s.id = o.server_session_id
        JOIN projects p ON p.id = o.project_id AND p.team_id = o.team_id
        WHERE o.team_id = $1
          AND (o.metadata->>'files_read' ILIKE $2 OR o.metadata->>'files_modified' ILIKE $2) ${projectClause}
          AND ($${sourceParam}::text IS NULL OR COALESCE(o.platform_source, s.platform_source, 'claude') = $${sourceParam})
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT 100
      `,
      values,
    );
    const text = result.rows.length === 0
      ? `No observations found for file "${normalizedPath}"`
      : [
        `Found ${result.rows.length} observation(s) for file "${normalizedPath}"`,
        '',
        ...result.rows.map((row, index) => `${index + 1}. [${row.project}] #${row.id} (${row.kind}) ${row.content}`),
      ].join('\n');
    res.json({ content: [{ type: 'text', text }] });
  };

  private async countPromptRows(teamId: string, projectId: string | null, platformSource: string | null = null): Promise<number> {
    if (!this.options.pool) return 0;
    const projectClause = projectId ? 'AND project_id = $2' : '';
    const sourceParam = projectId ? 3 : 2;
    const result = await this.options.pool.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM server_prompts sp
        JOIN server_sessions s ON s.id = sp.server_session_id
        WHERE sp.team_id = $1 ${projectId ? 'AND sp.project_id = $2' : ''}
          AND ($${sourceParam}::text IS NULL OR COALESCE(s.platform_source, 'claude') = $${sourceParam})
      `,
      projectId ? [teamId, projectId, platformSource] : [teamId, platformSource],
    );
    return Number.parseInt(result.rows[0]?.count ?? '0', 10) || 0;
  }

  private handleUpdateSettings = (req: Request, res: Response): void => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({ success: false, error: 'Settings body must be an object' });
      return;
    }

    const settingsPath = paths.settings();
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath, false) as unknown as Record<string, string>;
    const allowedKeys = Object.keys(SettingsDefaultsManager.getAllDefaults());

    for (const key of allowedKeys) {
      if (req.body?.[key] !== undefined) {
        if (typeof req.body[key] !== 'string') {
          res.status(400).json({ success: false, error: `${key} must be a string` });
          return;
        }
        settings[key] = req.body[key];
      }
    }

    try {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    res.json({ success: true, message: 'Settings updated successfully' });
  };

  private handleGetLogs = (req: Request, res: Response): void => {
    const logFilePath = this.getLogFilePath();
    const exists = existsSync(logFilePath);
    if (!exists) {
      res.json({ logs: '', path: logFilePath, exists: false });
      return;
    }

    try {
      const maxLines = parseLogLineLimit(req.query.lines as string | string[] | undefined);
      const { lines, totalEstimate } = readLastLines(logFilePath, maxLines);
      res.json({
        logs: lines,
        path: logFilePath,
        exists: true,
        totalLines: totalEstimate,
        returnedLines: lines ? lines.split('\n').length : 0,
      });
    } catch (error) {
      res.status(500).json({ error: 'LogReadFailed', message: error instanceof Error ? error.message : String(error), path: logFilePath });
    }
  };

  private handleClearLogs = (_req: Request, res: Response): void => {
    const logFilePath = this.getLogFilePath();
    if (!existsSync(logFilePath)) {
      res.json({ success: true, message: 'Log file does not exist', path: logFilePath });
      return;
    }

    try {
      writeFileSync(logFilePath, '', 'utf-8');
    } catch (error) {
      res.status(500).json({ error: 'LogClearFailed', message: error instanceof Error ? error.message : String(error), path: logFilePath });
      return;
    }
    res.json({ success: true, message: 'Log file cleared', path: logFilePath });
  };

  private handleGetStats = async (req: Request, res: Response): Promise<void> => {
    const packageRoot = getPackageRoot();
    const packageJsonPath = [
      path.join(packageRoot, 'package.json'),
      path.join(packageRoot, '..', 'package.json'),
    ].find(candidate => existsSync(candidate));
    let packageVersion = 'unknown';
    if (packageJsonPath) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
            typeof (parsed as { version?: unknown }).version === 'string') {
          packageVersion = (parsed as { version: string }).version;
        }
      } catch {
        // Stats should remain available when package metadata is unreadable.
      }
    }

    let observations = 0;
    let sessions = 0;
    let summaries = 0;
    let activeSessions = 0;
    let databaseSize = 0;
    let firstObservationAt: string | null = null;
    const teamId = req.authContext?.teamId ?? null;
    const projectId = req.authContext?.projectId ?? null;
    if (this.options.pool && teamId) {
      const projectScope = projectId ? 'team_id = $1 AND project_id = $2' : 'team_id = $1';
      const requestedPlatformSource = typeof req.query.platformSource === 'string'
        ? req.query.platformSource.trim()
        : '';
      const platformSource = requestedPlatformSource
        ? normalizePlatformSource(requestedPlatformSource)
        : null;
      const sourceParam = projectId ? 3 : 2;
      const params = projectId ? [teamId, projectId, platformSource] : [teamId, platformSource];
      const observationScope = projectId ? 'o.team_id = $1 AND o.project_id = $2' : 'o.team_id = $1';
      const observationSourceClause = `AND ($${sourceParam}::text IS NULL OR COALESCE(o.platform_source, s.platform_source, 'claude') = $${sourceParam})`;
      const sessionSourceClause = `AND ($${sourceParam}::text IS NULL OR COALESCE(platform_source, 'claude') = $${sourceParam})`;
      const [observationCount, sessionCount, activeSessionCount, summaryCount, firstObservation, sizeResult] = await Promise.all([
        this.options.pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM observations o LEFT JOIN server_sessions s ON s.id = o.server_session_id WHERE ${observationScope} ${observationSourceClause}`, params),
        this.options.pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM server_sessions WHERE ${projectScope} ${sessionSourceClause}`, params),
        this.options.pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM server_sessions WHERE ${projectScope} ${sessionSourceClause} AND ended_at IS NULL`, params),
        this.options.pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM observations o LEFT JOIN server_sessions s ON s.id = o.server_session_id WHERE ${observationScope} ${observationSourceClause} AND o.kind = 'summary'`, params),
        this.options.pool.query<{ created_at: Date | string }>(`SELECT o.created_at FROM observations o LEFT JOIN server_sessions s ON s.id = o.server_session_id WHERE ${observationScope} ${observationSourceClause} ORDER BY o.created_at ASC LIMIT 1`, params),
        this.options.pool.query<{ size: string }>('SELECT pg_database_size(current_database())::text AS size'),
      ]);
      observations = Number.parseInt(observationCount.rows[0]?.count ?? '0', 10) || 0;
      sessions = Number.parseInt(sessionCount.rows[0]?.count ?? '0', 10) || 0;
      activeSessions = Number.parseInt(activeSessionCount.rows[0]?.count ?? '0', 10) || 0;
      summaries = Number.parseInt(summaryCount.rows[0]?.count ?? '0', 10) || 0;
      databaseSize = Number.parseInt(sizeResult.rows[0]?.size ?? '0', 10) || 0;
      const createdAt = firstObservation.rows[0]?.created_at;
      firstObservationAt = createdAt ? new Date(createdAt).toISOString() : null;
    }

    res.json({
      worker: {
        version: packageVersion,
        uptime: Math.max(0, Math.round((Date.now() - this.startedAt) / 1000)),
        activeSessions,
        sseClients: this.activeSseClients,
        port: this.options.port ?? 0,
      },
      database: {
        path: null,
        size: databaseSize,
        observations,
        sessions,
        summaries,
        firstObservationAt,
      },
    });
  };

  private handleGetProcessingStatus = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.getProcessingStatus(req));
  };

  private async getProcessingStatus(req: Request): Promise<{ isProcessing: boolean; queueDepth: number }> {
    const teamId = req.authContext?.teamId ?? null;
    if (!this.options.pool || !teamId) {
      return { isProcessing: false, queueDepth: 0 };
    }

    const projectId = req.authContext?.projectId ?? null;
    const scope = projectId ? 'team_id = $1 AND project_id = $2' : 'team_id = $1';
    const requestedPlatformSource = typeof req.query.platformSource === 'string'
      ? req.query.platformSource.trim()
      : '';
    const platformSource = requestedPlatformSource
      ? normalizePlatformSource(requestedPlatformSource)
      : null;
    const sourceParam = projectId ? 3 : 2;
    const params = projectId ? [teamId, projectId, platformSource] : [teamId, platformSource];
    const result = await this.options.pool.query<{ status: string; count: string }>(
      `
        SELECT j.status, COUNT(*)::text AS count
        FROM observation_generation_jobs j
        LEFT JOIN server_sessions s ON s.id = j.server_session_id
        WHERE ${scope.replaceAll('team_id', 'j.team_id').replaceAll('project_id', 'j.project_id')}
          AND j.status IN ('queued', 'processing')
          AND ($${sourceParam}::text IS NULL OR COALESCE(s.platform_source, 'claude') = $${sourceParam})
        GROUP BY status
      `,
      params,
    );
    const counts = new Map(result.rows.map(row => [row.status, Number.parseInt(row.count, 10) || 0]));
    const processing = counts.get('processing') ?? 0;
    const queued = counts.get('queued') ?? 0;
    return { isProcessing: processing > 0, queueDepth: queued + processing };
  }

  private getLogFilePath(): string {
    const dataDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
    const logsDir = path.join(dataDir, 'logs');
    const fileName = `claude-mem-${new Date().toISOString().split('T')[0]}.log`;
    return path.join(logsDir, fileName);
  }

  // Exposed for tests: did the build ship a viewer.html the server can serve?
  static hasViewerHtml(): boolean {
    return viewerHtmlBytes !== null;
  }
}

function reqKeepAlive(res: Response): void {
  const interval = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keepalive\n\n');
    } else {
      clearInterval(interval);
    }
  }, 30000);
  res.once('close', () => {
    clearInterval(interval);
  });
}

function parseBoundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function valueAsString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function serializePrompt(row: PromptEventRow): Record<string, unknown> {
  const payload = typeof row.payload === 'object' && row.payload !== null
    ? row.payload as Record<string, unknown>
    : {};
  const promptNumber = typeof payload.prompt_number === 'number'
    ? payload.prompt_number
    : typeof payload.promptNumber === 'number'
      ? payload.promptNumber
      : null;
  const contentSessionId = valueAsString(payload.content_session_id)
    ?? valueAsString(payload.contentSessionId)
    ?? row.content_session_id
    ?? '';
  const occurredAt = new Date(row.occurred_at);
  return {
    id: row.id,
    content_session_id: contentSessionId,
    server_session_id: row.server_session_id,
    project: row.project,
    platform_source: valueAsString(payload.platform_source) ?? 'claude',
    prompt_number: promptNumber,
    prompt_text: valueAsString(payload.prompt) ?? '',
    created_at: occurredAt.toISOString(),
    created_at_epoch: occurredAt.getTime(),
  };
}
