
import path from 'path';
import net from 'net';
import { readFileSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { MARKETPLACE_ROOT } from '../../shared/paths.js';

async function httpRequestToWorker(
  port: number,
  endpointPath: string,
  method: string = 'GET',
  timeoutMs: number = 2000
): Promise<{ ok: boolean; statusCode: number; body: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`http://127.0.0.1:${port}${endpointPath}`, {
      method,
      signal: controller.signal,
    });
    let body = '';
    try {
      body = await response.text();
    } catch {
      // Body unavailable — health/readiness checks only need .ok
    }
    return { ok: response.ok, statusCode: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

export async function isPortInUse(port: number): Promise<boolean> {
  if (process.platform === 'win32') {
    try {
      const result = await httpRequestToWorker(port, '/api/health', 'GET', 1500);
      // Any HTTP response proves that a process owns the port. The endpoint
      // status is a readiness concern, not a port-occupancy signal.
      return result.ok || result.statusCode >= 400;
    } catch (error) {
      if (error instanceof Error) {
        logger.debug('SYSTEM', 'Windows health check failed (port not in use)', {}, error);
      } else {
        logger.debug('SYSTEM', 'Windows health check failed (port not in use)', { error: String(error) });
      }
      // The listener may not be an HTTP service, so fall through to the
      // socket probe instead of treating an HTTP failure as a free port.
    }
  }

  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function pollEndpointUntilOk(
  port: number,
  endpointPath: string,
  timeoutMs: number,
  retryLogMessage: string
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await httpRequestToWorker(port, endpointPath);
      if (result.ok) return true;
    } catch (error) {
      if (error instanceof Error) {
        logger.debug('SYSTEM', retryLogMessage, {}, error);
      } else {
        logger.debug('SYSTEM', retryLogMessage, { error: String(error) });
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

export function waitForHealth(port: number, timeoutMs: number = 30000): Promise<boolean> {
  return pollEndpointUntilOk(port, '/api/health', timeoutMs, 'Service not ready yet, will retry');
}

export function waitForReadiness(port: number, timeoutMs: number = 30000): Promise<boolean> {
  return pollEndpointUntilOk(port, '/api/readiness', timeoutMs, 'Worker not ready yet, will retry');
}

export async function waitForPortFree(port: number, timeoutMs: number = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isPortInUse(port))) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

export async function httpShutdown(port: number): Promise<boolean> {
  try {
    const result = await httpRequestToWorker(port, '/api/admin/shutdown', 'POST');
    if (!result.ok) {
      logger.warn('SYSTEM', 'Shutdown request returned error', { status: result.statusCode });
      return false;
    }
    return true;
  } catch (error) {
    if (error instanceof Error && error.message?.includes('ECONNREFUSED')) {
      logger.debug('SYSTEM', 'Worker already stopped', {}, error);
      return false;
    }
    logger.error('SYSTEM', 'Shutdown request failed unexpectedly', {}, error as Error);
    return false;
  }
}

export function getInstalledPluginVersion(): string {
  try {
    const packageJsonPath = path.join(MARKETPLACE_ROOT, 'package.json');
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { version?: unknown }).version !== 'string') {
      logger.debug('SYSTEM', 'Plugin package metadata has no usable version');
      return 'unknown';
    }
    return (parsed as { version: string }).version;
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Could not read plugin version', {
      code: error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    }, error instanceof Error ? error : undefined);
    return 'unknown';
  }
}

export async function getRunningWorkerVersion(port: number): Promise<string | null> {
  try {
    const result = await httpRequestToWorker(port, '/api/version');
    if (!result.ok) return null;
    const parsed: unknown = JSON.parse(result.body);
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { version?: unknown }).version !== 'string') {
      logger.debug('SYSTEM', 'Worker version response has no usable version', {});
      return null;
    }
    return (parsed as { version: string }).version;
  } catch {
    logger.debug('SYSTEM', 'Could not fetch worker version', {});
    return null;
  }
}

export interface VersionCheckResult {
  matches: boolean;
  pluginVersion: string;
  workerVersion: string | null;
}

export async function checkVersionMatch(port: number): Promise<VersionCheckResult> {
  const pluginVersion = getInstalledPluginVersion();
  const workerVersion = await getRunningWorkerVersion(port);

  if (!workerVersion || pluginVersion === 'unknown') {
    return { matches: true, pluginVersion, workerVersion };
  }

  return { matches: pluginVersion === workerVersion, pluginVersion, workerVersion };
}
