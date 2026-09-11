import { spawnHidden } from '../../shared/spawn.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import pc from 'picocolors';
import { resolveBunBinaryPath } from '../utils/bun-resolver.js';
import { isPluginInstalled, marketplaceDirectory } from '../utils/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { parseServerExportArgs, ServerExportArgsError } from '../../server/export-args.js';
import { paths } from '../../shared/paths.js';

function ensureInstalledOrExit(): void {
  if (!isPluginInstalled()) {
    console.error(pc.red('claude-mem is not installed.'));
    console.error(`Run: ${pc.bold('npx claude-mem install')}`);
    process.exit(1);
  }
}

function resolveBunOrExit(): string {
  const bunPath = resolveBunBinaryPath();
  if (!bunPath) {
    console.error(pc.red('Bun not found.'));
    console.error('Install Bun: https://bun.sh');
    console.error('After installation, restart your terminal.');
    process.exit(1);
  }
  return bunPath;
}

function workerServiceScriptPath(): string {
  return join(marketplaceDirectory(), 'plugin', 'scripts', 'worker-service.cjs');
}

function serverBetaServiceScriptPath(): string {
  return join(marketplaceDirectory(), 'plugin', 'scripts', 'server-beta-service.cjs');
}

function spawnBunWorkerCommand(command: string, extraArgs: string[] = []): void {
  ensureInstalledOrExit();
  const bunPath = resolveBunOrExit();
  const workerScript = workerServiceScriptPath();

  if (!existsSync(workerScript)) {
    console.error(pc.red(`Worker script not found at: ${workerScript}`));
    console.error('The installation may be corrupted. Try: npx claude-mem install');
    process.exit(1);
  }

  const args = [workerScript, command, ...extraArgs];

  const child = spawnHidden(bunPath, args, {
    stdio: 'inherit',
    cwd: marketplaceDirectory(),
    // Sanitize host CLI bleed-through and Anthropic credentials before
    // launching the Bun worker/server/transcript process. Credentials are
    // re-read from ~/.claude-mem/.env at SDK spawn time (#2357 / #2375).
    env: sanitizeEnv(process.env),
  });

  child.on('error', (error) => {
    console.error(pc.red(`Failed to start Bun: ${error.message}`));
    process.exit(1);
  });

  child.on('close', (exitCode) => {
    process.exit(exitCode ?? 0);
  });
}

function spawnBunServerBetaCommand(command: string, extraArgs: string[] = []): void {
  ensureInstalledOrExit();
  const bunPath = resolveBunOrExit();
  const serverScript = serverBetaServiceScriptPath();

  if (!existsSync(serverScript)) {
    console.error(pc.red(`Server beta script not found at: ${serverScript}`));
    console.error('The installation may be corrupted. Try: npx claude-mem install');
    process.exit(1);
  }

  const child = spawnHidden(bunPath, [serverScript, command, ...extraArgs], {
    stdio: 'inherit',
    cwd: marketplaceDirectory(),
    // Sanitize host CLI bleed-through and Anthropic credentials before
    // launching the Bun worker/server/transcript process. Credentials are
    // re-read from ~/.claude-mem/.env at SDK spawn time (#2357 / #2375).
    env: sanitizeEnv(process.env),
  });

  child.on('error', (error) => {
    console.error(pc.red(`Failed to start Bun: ${error.message}`));
    process.exit(1);
  });

  child.on('close', (exitCode) => {
    process.exit(exitCode ?? 0);
  });
}

export function runServerBetaStartCommand(): void {
  spawnBunServerBetaCommand('start');
}

export function runServerBetaStopCommand(): void {
  spawnBunServerBetaCommand('stop');
}

export function runServerBetaRestartCommand(): void {
  spawnBunServerBetaCommand('restart');
}

export function runServerBetaStatusCommand(): void {
  spawnBunServerBetaCommand('status');
}

// Phase 10 — start the BullMQ generation worker (no HTTP). Use this in
// Compose to scale generation horizontally while a single (or multiple)
// HTTP-only server-beta replicas serve writes/reads.
export function runServerBetaWorkerStartCommand(): void {
  spawnBunServerBetaCommand('worker', ['start']);
}

export function runStartCommand(): void {
  spawnBunWorkerCommand('start');
}

export function runStopCommand(): void {
  spawnBunWorkerCommand('stop');
}

export function runRestartCommand(): void {
  spawnBunWorkerCommand('restart');
}

export function runStatusCommand(): void {
  spawnBunWorkerCommand('status');
}

export function runLogsCommand(lineCount = 50): void {
  const logsDir = paths.logsDir();
  if (!existsSync(logsDir)) {
    console.error(pc.yellow(`No logs found in ${logsDir}`));
    return;
  }

  let logPath: string | undefined;
  try {
    logPath = readdirSync(logsDir)
      .filter((name) => /^claude-mem-\d{4}-\d{2}-\d{2}\.log$/.test(name))
      .map((name) => join(logsDir, name))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(pc.red(`Unable to inspect logs in ${logsDir}: ${message}`));
    process.exitCode = 1;
    return;
  }

  if (!logPath) {
    console.error(pc.yellow(`No claude-mem logs found in ${logsDir}`));
    return;
  }

  try {
    const lines = readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
    console.log(lines.slice(-lineCount).join('\n'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(pc.red(`Unable to read log file ${logPath}: ${message}`));
    process.exitCode = 1;
  }
}

export function runServerApiKeyCommand(extraArgs: string[] = []): void {
  spawnBunServerBetaCommand('server', ['api-key', ...extraArgs]);
}

export function runServerMigrateCommand(): void {
  spawnBunServerBetaCommand('server', ['migrate']);
}

export async function runServerExportCommand(argv: string[] = []): Promise<void> {
  const baseUrl = SettingsDefaultsManager.get('CLAUDE_MEM_SERVER_BETA_URL').replace(/\/+$/, '');
  const apiKey = SettingsDefaultsManager.get('CLAUDE_MEM_SERVER_BETA_API_KEY').trim();
  if (!baseUrl || !apiKey) {
    console.error(pc.red('Server export requires CLAUDE_MEM_SERVER_BETA_URL and CLAUDE_MEM_SERVER_BETA_API_KEY.'));
    process.exit(1);
  }

  const invalidArgs = () => {
    console.error(pc.red('Usage: npx claude-mem server export [--project-id <id>] [--include-audit] [--limit <1-10000>]'));
    process.exit(1);
  };
  let body: ReturnType<typeof parseServerExportArgs> = {};
  try {
    body = parseServerExportArgs(argv);
  } catch (error) {
    if (!(error instanceof ServerExportArgsError)) throw error;
    invalidArgs();
  }

  try {
    const response = await fetch(`${baseUrl}/v1/export`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (!response.ok) {
      console.error(pc.red(`Server export failed: HTTP ${response.status}`));
      if (response.status === 403) {
        console.error('The configured API key needs the memories:admin scope for export.');
      }
      if (text) console.error(text);
      process.exit(1);
    }
    console.log(text);
  } catch (error) {
    console.error(pc.red(`Server export failed: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

export function runAdoptCommand(extraArgs: string[] = []): void {
  ensureInstalledOrExit();
  const bunPath = resolveBunOrExit();
  const workerScript = workerServiceScriptPath();

  if (!existsSync(workerScript)) {
    console.error(pc.red(`Worker script not found at: ${workerScript}`));
    console.error('The installation may be corrupted. Try: npx claude-mem install');
    process.exit(1);
  }

  const userCwd = process.cwd();
  const args = [workerScript, 'adopt', '--cwd', userCwd, ...extraArgs];

  const child = spawnHidden(bunPath, args, {
    stdio: 'inherit',
    cwd: marketplaceDirectory(),
    // Sanitize host CLI bleed-through and Anthropic credentials before
    // launching the Bun worker/server/transcript process. Credentials are
    // re-read from ~/.claude-mem/.env at SDK spawn time (#2357 / #2375).
    env: sanitizeEnv(process.env),
  });

  child.on('error', (error) => {
    console.error(pc.red(`Failed to start Bun: ${error.message}`));
    process.exit(1);
  });

  child.on('close', (exitCode) => {
    process.exit(exitCode ?? 0);
  });
}

export function runCleanupCommand(extraArgs: string[] = []): void {
  spawnBunWorkerCommand('cleanup', extraArgs);
}

export async function runSearchCommand(queryParts: string[]): Promise<void> {
  ensureInstalledOrExit();

  const query = queryParts.join(' ').trim();
  if (!query) {
    console.error(pc.red('Usage: npx claude-mem search <query>'));
    process.exit(1);
  }

  const workerHost = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_HOST');
  const workerPort = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT');
  const searchUrl = `http://${workerHost}:${workerPort}/api/search?query=${encodeURIComponent(query)}`;

  let response: Response;
  try {
    response = await fetch(searchUrl, {
      signal: AbortSignal.timeout(5000),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? (error as any).cause : undefined;
    if (cause?.code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
      console.error(pc.red('Worker is not running.'));
      console.error(`Start it with: ${pc.bold('npx claude-mem start')}`);
      process.exit(1);
    }
    console.error(pc.red(`Search failed: ${message}`));
    process.exit(1);
  }

  if (!response.ok) {
    if (response.status === 404) {
      console.error(pc.red('Search endpoint not found. Is the worker running?'));
      console.error(`Try: ${pc.bold('npx claude-mem start')}`);
      process.exit(1);
    }
    console.error(pc.red(`Search failed: HTTP ${response.status}`));
    process.exit(1);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(pc.red(`Search failed: invalid JSON response (${message})`));
    process.exit(1);
  }

  if (typeof data === 'object' && data !== null) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
}

export function runTranscriptWatchCommand(): void {
  ensureInstalledOrExit();
  const bunPath = resolveBunOrExit();

  const transcriptWatcherPath = join(
    marketplaceDirectory(),
    'plugin',
    'scripts',
    'transcript-watcher.cjs',
  );

  if (!existsSync(transcriptWatcherPath)) {
    spawnBunWorkerCommand('transcript', ['watch']);
    return;
  }

  const child = spawnHidden(bunPath, [transcriptWatcherPath, 'watch'], {
    stdio: 'inherit',
    cwd: marketplaceDirectory(),
    // Sanitize host CLI bleed-through and Anthropic credentials before
    // launching the Bun worker/server/transcript process. Credentials are
    // re-read from ~/.claude-mem/.env at SDK spawn time (#2357 / #2375).
    env: sanitizeEnv(process.env),
  });

  child.on('error', (error) => {
    console.error(pc.red(`Failed to start transcript watcher: ${error.message}`));
    process.exit(1);
  });

  child.on('close', (exitCode) => {
    process.exit(exitCode ?? 0);
  });
}
