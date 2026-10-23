import { API_ENDPOINTS } from '../constants/api';
import { authFetch } from './api';

export type MonitoringState = 'healthy' | 'degraded' | 'unavailable';

export interface MonitoringCheck {
  key: 'health' | 'readiness' | 'stats';
  label: string;
  path: string;
  state: MonitoringState;
  latencyMs: number;
  message: string;
  details?: string;
}

export const MONITORING_ENDPOINTS = [
  { key: 'health', label: 'Worker health', path: API_ENDPOINTS.HEALTH },
  { key: 'readiness', label: 'Worker readiness', path: API_ENDPOINTS.READINESS },
  { key: 'stats', label: 'API and database stats', path: API_ENDPOINTS.STATS },
] as const;

type MonitoringEndpoint = typeof MONITORING_ENDPOINTS[number];
type MonitoringFetch = typeof authFetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h uptime`;
  if (hours > 0) return `${hours}h ${minutes}m uptime`;
  return `${minutes}m uptime`;
}

function getResponseState(endpoint: MonitoringEndpoint, response: Response, body: unknown): {
  state: MonitoringState;
  message: string;
  details?: string;
} {
  if (!isRecord(body) || typeof body.status !== 'string' && endpoint.key !== 'stats') {
    return { state: 'unavailable', message: 'Invalid response from endpoint' };
  }

  if (endpoint.key === 'health') {
    if (body.status === 'degraded') return { state: 'degraded', message: 'Worker reports degraded health' };
    if (!response.ok) return { state: 'unavailable', message: `HTTP ${response.status}` };
    if (body.status !== 'ok') return { state: 'unavailable', message: 'Worker returned an unknown health status' };
    const details = [
      typeof body.version === 'string' ? `v${body.version}` : undefined,
      typeof body.uptime === 'number' && Number.isFinite(body.uptime) && body.uptime >= 0
        ? formatUptime(body.uptime)
        : undefined,
    ].filter((value): value is string => value !== undefined);
    return { state: 'healthy', message: 'Responding normally', details: details.join(' · ') || undefined };
  }

  if (endpoint.key === 'readiness') {
    if (body.status === 'initializing') return { state: 'degraded', message: 'Worker is still initializing' };
    if (!response.ok) return { state: 'unavailable', message: `HTTP ${response.status}` };
    if (body.status !== 'ready') return { state: 'unavailable', message: 'Worker returned an unknown readiness status' };
    return {
      state: 'healthy',
      message: 'Ready to accept work',
      details: typeof body.mcpReady === 'boolean' ? `MCP ${body.mcpReady ? 'ready' : 'starting'}` : undefined,
    };
  }

  if (!response.ok) return { state: 'unavailable', message: `HTTP ${response.status}` };
  if (!isRecord(body.worker) || !isRecord(body.database)) {
    return { state: 'unavailable', message: 'Invalid stats response from endpoint' };
  }
  const details = [
    typeof body.worker.version === 'string' ? `v${body.worker.version}` : undefined,
    typeof body.worker.uptime === 'number' && Number.isFinite(body.worker.uptime) && body.worker.uptime >= 0
      ? formatUptime(body.worker.uptime)
      : undefined,
    typeof body.worker.activeSessions === 'number' ? `${body.worker.activeSessions} active sessions` : undefined,
    typeof body.database.observations === 'number' ? `${body.database.observations} observations` : undefined,
  ].filter((value): value is string => value !== undefined);
  return { state: 'healthy', message: 'Responding normally', details: details.join(' · ') || undefined };
}

export async function checkMonitoringEndpoint(
  endpoint: MonitoringEndpoint,
  fetcher: MonitoringFetch = authFetch,
  signal?: AbortSignal
): Promise<MonitoringCheck> {
  const start = performance.now();

  try {
    const response = await fetcher(endpoint.path, { signal });
    let body: unknown;
    try {
      body = await response.json();
    } catch (error: unknown) {
      if (!response.ok) {
        return {
          ...endpoint,
          state: 'unavailable',
          latencyMs: Math.round(performance.now() - start),
          message: `HTTP ${response.status}`,
        };
      }
      throw error;
    }
    const result = getResponseState(endpoint, response, body);
    return {
      ...endpoint,
      ...result,
      latencyMs: Math.round(performance.now() - start),
    };
  } catch (error: unknown) {
    return {
      ...endpoint,
      state: 'unavailable',
      latencyMs: Math.round(performance.now() - start),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
