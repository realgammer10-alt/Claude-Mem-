import pc from 'picocolors';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import {
  runServerBetaRestartCommand,
  runServerBetaStartCommand,
  runServerBetaStatusCommand,
  runServerBetaStopCommand,
  runServerBetaWorkerStartCommand,
  runLogsCommand,
  runRestartCommand,
  runServerApiKeyCommand,
  runServerExportCommand,
  runServerMigrateCommand,
  runStartCommand,
  runStatusCommand,
  runStopCommand,
} from './runtime.js';

const UNSUPPORTED_SERVER_COMMANDS = new Set([
  'import',
]);

export function getServerDoctorExitCode(
  configurationErrorCount: number,
  serverHealth: 'healthy' | 'unhealthy' | 'unreachable',
): number {
  if (configurationErrorCount > 0) return 1;
  if (serverHealth === 'healthy') return 0;
  return serverHealth === 'unreachable' ? 2 : 1;
}

export function getWorkerDoctorExitCode(status: unknown, reachable: boolean): number {
  if (!reachable) return 2;
  return status === 'ok' ? 0 : 1;
}

export function parseServerDoctorPort(raw: string | undefined, fallback: number): number {
  const value = raw?.trim() ?? '';
  if (!/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

function printServerUsage(): void {
  console.error(`Usage: ${pc.bold('npx claude-mem server <command>')}`);
  console.error('Commands: start, stop, restart, status, logs [--lines <count>], doctor, migrate, export, import, api-key create|list|revoke|migrate-scopes, keys rotate, worker start, jobs status|failed|retry|cancel');
}

function failUnsupported(command: string): never {
  console.error(pc.red(`Server command not implemented yet: ${command}`));
  console.error('This CLI route is reserved for the server runtime, but no backend API exists for it yet.');
  process.exit(1);
}

function runWorkerLifecycleCommand(command: string): boolean {
  switch (command) {
    case 'start':
      runStartCommand();
      return true;
    case 'stop':
      runStopCommand();
      return true;
    case 'restart':
      runRestartCommand();
      return true;
    case 'status':
      runStatusCommand();
      return true;
    default:
      return false;
  }
}

function runServerBetaLifecycleCommand(command: string): boolean {
  switch (command) {
    case 'start':
      runServerBetaStartCommand();
      return true;
    case 'stop':
      runServerBetaStopCommand();
      return true;
    case 'restart':
      runServerBetaRestartCommand();
      return true;
    case 'status':
      runServerBetaStatusCommand();
      return true;
    default:
      return false;
  }
}

async function runServerDoctorCommand(): Promise<void> {
  const runtime = (process.env.CLAUDE_MEM_RUNTIME ?? '').trim();
  const queueEngine = (process.env.CLAUDE_MEM_QUEUE_ENGINE ?? '').trim().toLowerCase();
  const configurationErrors: string[] = [];
  if (runtime && runtime !== 'server-beta') {
    configurationErrors.push(`CLAUDE_MEM_RUNTIME=${runtime} must be server-beta`);
  }
  if (!(process.env.CLAUDE_MEM_SERVER_DATABASE_URL ?? '').trim()) {
    configurationErrors.push('CLAUDE_MEM_SERVER_DATABASE_URL is not set');
  }
  if (queueEngine === 'bullmq' && !(process.env.CLAUDE_MEM_REDIS_URL ?? '').trim()) {
    configurationErrors.push('CLAUDE_MEM_REDIS_URL is required when CLAUDE_MEM_QUEUE_ENGINE=bullmq');
    const fallbackPort = 37877 + ((process.getuid?.() ?? 77) % 100);
    const port = parseServerDoctorPort(process.env.CLAUDE_MEM_SERVER_PORT, fallbackPort);
    console.log(`  Runtime: ${runtime || 'server-beta'}`);
    console.log(`  Queue:   ${queueEngine || 'disabled'}`);
  } else {
    console.error(pc.red('Server configuration: invalid'));
    for (const error of configurationErrors) console.error(`  - ${error}`);
  }

  const parsedPort = Number.parseInt(process.env.CLAUDE_MEM_SERVER_PORT ?? '', 10);
  const port = Number.isInteger(parsedPort) && parsedPort > 0
    ? parsedPort
    : 37877 + ((process.getuid?.() ?? 77) % 100);
  const host = (process.env.CLAUDE_MEM_SERVER_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  let serverHealth: 'healthy' | 'unhealthy' | 'unreachable' = 'unreachable';
  try {
    const response = await fetch(`http://${host}:${port}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      serverHealth = 'healthy';
      console.log(pc.green(`Server health: healthy at http://${host}:${port}`));
    } else {
      serverHealth = 'unhealthy';
      console.error(pc.yellow(`Server health: HTTP ${response.status} at port ${port}`));
    }
  } catch {
    console.error(pc.yellow(`Server health: unreachable at port ${port}`));
  }

  process.exit(getServerDoctorExitCode(configurationErrors.length, serverHealth));
}

export async function runServerCommand(argv: string[] = []): Promise<void> {
  const subCommand = argv[0]?.toLowerCase();

  if (!subCommand) {
    printServerUsage();
    process.exit(1);
  }

  if (UNSUPPORTED_SERVER_COMMANDS.has(subCommand)) {
    failUnsupported(`server ${subCommand}`);
  }

  if (subCommand === 'doctor') {
    await runServerDoctorCommand();
    return;
  }

  if (subCommand === 'logs') {
    const linesFlag = argv.indexOf('--lines');
    if (linesFlag === -1) {
      runLogsCommand();
      return;
    }

    const rawLineCount = argv[linesFlag + 1];
    const lineCount = Number(rawLineCount);
    if (!rawLineCount || !Number.isInteger(lineCount) || lineCount < 1 || lineCount > 10_000) {
      console.error(pc.red('Usage: npx claude-mem server logs [--lines <1-10000>]'));
      process.exit(1);
    }
    runLogsCommand(lineCount);
    return;
  }

  if (subCommand === 'migrate') {
    runServerMigrateCommand();
    return;
  }

  if (subCommand === 'export') {
    await runServerExportCommand(argv.slice(1));
    return;
  }

  if (runServerBetaLifecycleCommand(subCommand)) {
    return;
  }

  if (subCommand === 'api-key') {
    const apiKeyCommand = argv[1]?.toLowerCase();
    if (apiKeyCommand === 'create' || apiKeyCommand === 'list' || apiKeyCommand === 'revoke' || apiKeyCommand === 'migrate-scopes') {
      runServerApiKeyCommand(argv.slice(1));
      return;
    }
    console.error(pc.red(`Unknown server api-key subcommand: ${apiKeyCommand ?? '(none)'}`));
    console.error('Usage: npx claude-mem server api-key create|list|revoke|migrate-scopes');
    process.exit(1);
  }

  if (subCommand === 'worker') {
    const workerCommand = argv[1]?.toLowerCase();
    if (workerCommand === 'start') {
      runServerBetaWorkerStartCommand();
      return;
    }
    console.error(pc.red(`Unknown server worker subcommand: ${workerCommand ?? '(none)'}`));
    console.error('Usage: npx claude-mem server worker start');
    process.exit(1);
  }

  if (subCommand === 'keys') {
    const keysCommand = argv[1]?.toLowerCase();
    if (keysCommand === 'rotate') {
      await runServerBetaKeysRotateCommand();
      return;
    }
    console.error(pc.red(`Unknown server keys subcommand: ${keysCommand ?? '(none)'}`));
    console.error('Usage: npx claude-mem server keys rotate');
    process.exit(1);
  }

  if (subCommand === 'jobs') {
    // Phase 12 — operator queue console. Uses Postgres (canonical) +
    // BullMQ (transport) directly. See src/npx-cli/commands/server-jobs.ts.
    const { runServerJobsCommand } = await import('./server-jobs.js');
    await runServerJobsCommand(argv.slice(1));
    return;
  }

  console.error(pc.red(`Unknown server command: ${subCommand}`));
  printServerUsage();
  process.exit(1);
}

async function runServerBetaKeysRotateCommand(): Promise<void> {
  if (!process.env.CLAUDE_MEM_SERVER_DATABASE_URL) {
    console.error(pc.red('Cannot rotate server-beta API key: CLAUDE_MEM_SERVER_DATABASE_URL is not set.'));
    console.error('Configure Postgres first, then re-run this command.');
    process.exit(1);
  }
  const { rotateServerBetaApiKey, persistServerBetaSettings } = await import(
    '../../services/hooks/server-beta-bootstrap.js'
  );
  const { SettingsDefaultsManager } = await import('../../shared/SettingsDefaultsManager.js');
  const { join } = await import('path');
  const { existsSync, readFileSync } = await import('fs');

  const settingsPath = join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  let previousApiKeyId: string | null = null;
  if (existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
      const flat = (raw.env && typeof raw.env === 'object' ? raw.env : raw) as Record<string, unknown>;
      const previousKey = flat.CLAUDE_MEM_SERVER_BETA_API_KEY;
      if (typeof previousKey === 'string' && previousKey.length > 0) {
        previousApiKeyId = await lookupApiKeyIdByPlaintext(previousKey);
      }
    } catch {
      // ignore — we'll just generate a new key without revoking the old one
    }
  }

  const result = await rotateServerBetaApiKey({ previousApiKeyId });
  persistServerBetaSettings(settingsPath, {
    apiKey: result.rawKey,
    projectId: result.projectId,
  });
  console.log(JSON.stringify({
    rotated: true,
    apiKeyId: result.apiKeyId,
    teamId: result.teamId,
    projectId: result.projectId,
    settingsPath,
  }, null, 2));
}

async function lookupApiKeyIdByPlaintext(rawKey: string): Promise<string | null> {
  const { createPostgresPool } = await import('../../storage/postgres/pool.js');
  const { parsePostgresConfig } = await import('../../storage/postgres/config.js');
  const { hashApiKey } = await import('../../services/hooks/server-beta-bootstrap.js');
  const config = parsePostgresConfig({ requireDatabaseUrl: true });
  if (!config) return null;
  const pool = createPostgresPool(config);
  try {
    const result = await pool.query<{ id: string }>(
      'SELECT id FROM api_keys WHERE key_hash = $1 LIMIT 1',
      [hashApiKey(rawKey)],
    );
    return result.rows[0]?.id ?? null;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export async function runWorkerAliasCommand(argv: string[] = []): Promise<void> {
  const subCommand = argv[0]?.toLowerCase();

  if (subCommand === 'doctor') {
    const host = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_HOST');
    const port = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT');
    const json = argv.includes('--json');
    let response: Response;
    try {
      response = await fetch(`http://${host}:${port}/api/healthz`, {
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      const result = { status: 'unreachable', reachable: false, host, port };
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(pc.yellow(`claude-mem worker unreachable at ${host}:${port}`));
        console.error('Start it with: npx claude-mem start');
      }
      process.exit(2);
    }

    let body: Record<string, unknown>;
    try {
      body = await response.json() as Record<string, unknown>;
    } catch {
      body = { status: 'unhealthy', reachable: true, httpStatus: response.status };
    }

    const exitCode = getWorkerDoctorExitCode(body.status, true);
    if (json) {
      console.log(JSON.stringify({ ...body, reachable: true }, null, 2));
    } else {
      console.log('claude-mem worker doctor');
      console.log(`  Status:       ${body.status ?? 'unknown'}`);
      console.log(`  Runtime:      ${body.runtime ?? 'unknown'}`);
      console.log(`  PID:          ${body.pid ?? 'unknown'}`);
      console.log(`  Uptime:       ${body.uptime ?? 'unknown'}s`);
      console.log(`  Initialized:  ${body.initialized === true ? 'yes' : 'no'}`);
      console.log(`  MCP ready:    ${body.mcpReady === true ? 'yes' : 'no'}`);
    }
    process.exit(exitCode);
  }

  if (!subCommand || !runWorkerLifecycleCommand(subCommand)) {
    console.error(pc.red(`Unknown worker command: ${subCommand ?? '(none)'}`));
    console.error('Usage: npx claude-mem worker start|stop|restart|status|doctor [--json]');
    process.exit(1);
  }
}
