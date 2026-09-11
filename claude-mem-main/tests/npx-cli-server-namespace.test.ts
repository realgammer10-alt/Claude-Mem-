import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const indexSource = readFileSync(join(__dirname, '..', 'src', 'npx-cli', 'index.ts'), 'utf-8');
const serverSource = readFileSync(join(__dirname, '..', 'src', 'npx-cli', 'commands', 'server.ts'), 'utf-8');
const runtimeSource = readFileSync(join(__dirname, '..', 'src', 'npx-cli', 'commands', 'runtime.ts'), 'utf-8');
const workerServiceSource = readFileSync(join(__dirname, '..', 'src', 'services', 'worker-service.ts'), 'utf-8');

describe('npx CLI server namespace', () => {
  it('routes the server namespace through the server command module', () => {
    expect(indexSource).toContain("case 'server'");
    expect(indexSource).toContain("await import('./commands/server.js')");
    expect(indexSource).toContain('await runServerCommand(args.slice(1))');
  });

  it('routes worker lifecycle aliases through the server command module', () => {
    expect(indexSource).toContain("case 'worker'");
    expect(indexSource).toContain('runWorkerAliasCommand(args.slice(1))');
    expect(serverSource).toContain('runWorkerLifecycleCommand');
    expect(serverSource).toContain('runStartCommand()');
    expect(serverSource).toContain('runStopCommand()');
    expect(serverSource).toContain('runRestartCommand()');
    expect(serverSource).toContain('runStatusCommand()');
    expect(indexSource).toContain('worker doctor [--json]');
    expect(serverSource).toContain("subCommand === 'doctor'");
    expect(serverSource).toContain('CLAUDE_MEM_WORKER_HOST');
    expect(serverSource).toContain('http://${host}:${port}/api/healthz');
  });

  it('uses the configured worker host for CLI health and search requests', () => {
    const doctorSource = readFileSync(join(__dirname, '..', 'src', 'npx-cli', 'commands', 'doctor.ts'), 'utf-8');
    expect(doctorSource).toContain('CLAUDE_MEM_WORKER_HOST');
    expect(doctorSource).toContain('http://${workerHost}:${workerPort}/api/health');
    expect(runtimeSource).toContain('CLAUDE_MEM_WORKER_HOST');
    expect(runtimeSource).toContain('http://${workerHost}:${workerPort}/api/search');
  });

  it('routes server lifecycle commands and keeps reserved commands nonzero failures', () => {
    expect(serverSource).toContain('runServerBetaLifecycleCommand(subCommand)');
    expect(serverSource).toContain('runServerBetaStartCommand()');
    expect(serverSource).toContain('runServerBetaStopCommand()');
    expect(serverSource).toContain('runServerBetaRestartCommand()');
    expect(serverSource).toContain('runServerBetaStatusCommand()');
    expect(serverSource).toContain("subCommand === 'logs'");
    expect(serverSource).toContain('runLogsCommand()');
    expect(serverSource).toContain("runLogsCommand(lineCount)");
    expect(serverSource).toContain("lineCount > 10_000");
    expect(serverSource).not.toContain("'logs',");
    expect(serverSource).toContain("subCommand === 'doctor'");
    expect(serverSource).toContain('CLAUDE_MEM_SERVER_DATABASE_URL is not set');
    expect(serverSource).toContain('CLAUDE_MEM_SERVER_HOST');
    expect(serverSource).toContain('http://${host}:${port}/healthz');
    expect(serverSource).toContain("/healthz");
    expect(serverSource).not.toContain("server/runtime/create-server-beta-service.js");
    expect(serverSource).toContain("'doctor'");
    expect(serverSource).toContain("'migrate'");
    expect(serverSource).toContain("'export'");
    expect(serverSource).toContain("'import'");
    expect(serverSource).toContain("process.exit(1)");
    expect(serverSource).toContain('runServerApiKeyCommand(argv.slice(1))');
    expect(serverSource).toContain('runServerMigrateCommand()');
    expect(serverSource).toContain('runServerExportCommand(argv.slice(1))');
    expect(runtimeSource).toContain("fetch(`${baseUrl}/v1/export`");
    expect(runtimeSource).toContain('parseServerExportArgs(argv)');
    expect(runtimeSource).toContain("spawnBunServerBetaCommand('server', ['migrate'])");
    expect(indexSource).toContain('Run server Postgres migrations');
    expect(indexSource).not.toContain('Run server migrations (not yet implemented)');
    expect(indexSource).toContain('Export server data (admin key; --project-id, --include-audit, --limit)');
    expect(indexSource).not.toContain('Export server data (not yet implemented)');
    expect(serverSource).toContain("apiKeyCommand === 'migrate-scopes'");
    expect(serverSource).toContain('api-key create|list|revoke|migrate-scopes');
    expect(runtimeSource).toContain("spawnBunServerBetaCommand('server', ['api-key', ...extraArgs])");
    expect(runtimeSource).not.toContain("spawnBunWorkerCommand('server', ['api-key', ...extraArgs])");
  });

  it('normalizes direct worker-service server invocations', () => {
    expect(workerServiceSource).toContain("rawCommand === 'server'");
    expect(workerServiceSource).toContain('lifecycleCommands.has(maybeSubCommand)');
    expect(workerServiceSource).toContain('command: `server-${maybeSubCommand}`');
    expect(workerServiceSource).toContain("case 'server-start'");
    expect(workerServiceSource).toContain('runServerBetaServiceCli(command.slice');
    expect(workerServiceSource).toContain('serverCommands.has(maybeSubCommand)');
    expect(workerServiceSource).toContain("case 'server-api-key'");
    expect(workerServiceSource).toContain("runServerBetaServiceCli('server', ['api-key', ...commandArgs])");
    expect(workerServiceSource).toContain("runServerBetaServiceCli('server', ['migrate', ...commandArgs])");
    expect(workerServiceSource).toContain("runServerBetaServiceCli('server', ['export', ...commandArgs])");
    expect(workerServiceSource).toContain('migrate-scopes, keys, jobs');
    expect(workerServiceSource).toContain('Commands: start, stop, restart, status, migrate, export, api-key');
    expect(workerServiceSource).not.toContain('Commands: start, stop, restart, status, logs, doctor, migrate, import');
    const serverRuntimeSource = readFileSync(join(__dirname, '..', 'src', 'server', 'runtime', 'ServerBetaService.ts'), 'utf-8');
    expect(serverRuntimeSource).toContain('runServerBetaExportCli');
    expect(serverRuntimeSource).toContain('parseServerExportArgs(argv)');
    expect(serverRuntimeSource).toContain('server migrate');
    expect(serverRuntimeSource).toContain('server export');
    expect(serverRuntimeSource).toContain('Unknown server keys subcommand');
    expect(serverRuntimeSource).toContain("sub !== null && sub !== 'list'");
    expect(serverRuntimeSource).toContain('Unknown server jobs subcommand');
    expect(serverRuntimeSource).toContain("sub !== 'list' && sub !== 'inspect'");
    expect(workerServiceSource).toContain("case 'server-help'");
    expect(workerServiceSource).toContain("case 'worker-help'");
    expect(workerServiceSource).not.toContain('command: maybeSubCommand ??');
  });
});
