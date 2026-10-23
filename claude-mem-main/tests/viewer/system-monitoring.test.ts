import { describe, expect, it, mock } from 'bun:test';
import { checkMonitoringEndpoint, MONITORING_ENDPOINTS } from '../../src/ui/viewer/utils/monitoring';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('system monitoring endpoint checks', () => {
  it('reports a healthy worker health endpoint', async () => {
    const fetcher = mock(() => Promise.resolve(jsonResponse({ status: 'ok' })));
    const result = await checkMonitoringEndpoint(MONITORING_ENDPOINTS[0], fetcher);

    expect(fetcher).toHaveBeenCalledWith('/api/health', expect.objectContaining({ signal: undefined }));
    expect(result.state).toBe('healthy');
    expect(result.message).toBe('Responding normally');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports degraded worker health and initializing readiness accurately', async () => {
    const degradedHealth = await checkMonitoringEndpoint(
      MONITORING_ENDPOINTS[0],
      mock(() => Promise.resolve(jsonResponse({ status: 'degraded' }, 503)))
    );
    const initializingReadiness = await checkMonitoringEndpoint(
      MONITORING_ENDPOINTS[1],
      mock(() => Promise.resolve(jsonResponse({ status: 'initializing' }, 503)))
    );

    expect(degradedHealth.state).toBe('degraded');
    expect(initializingReadiness.state).toBe('degraded');
    expect(initializingReadiness.message).toBe('Worker is still initializing');
  });

  it('reports healthy stats and rejects malformed stats data', async () => {
    const healthyStats = await checkMonitoringEndpoint(
      MONITORING_ENDPOINTS[2],
      mock(() => Promise.resolve(jsonResponse({
        worker: { version: '1.2.3', uptime: 3660, activeSessions: 2 },
        database: { observations: 12 },
      })))
    );
    const malformedStats = await checkMonitoringEndpoint(
      MONITORING_ENDPOINTS[2],
      mock(() => Promise.resolve(jsonResponse({ worker: {} })))
    );

    expect(healthyStats.state).toBe('healthy');
    expect(healthyStats.details).toBe('v1.2.3 · 1h 1m uptime · 2 active sessions · 12 observations');
    expect(malformedStats.state).toBe('unavailable');
    expect(malformedStats.message).toBe('Invalid stats response from endpoint');
  });

  it('surfaces HTTP and network failures instead of treating them as healthy', async () => {
    const httpFailure = await checkMonitoringEndpoint(
      MONITORING_ENDPOINTS[2],
      mock(() => Promise.resolve(jsonResponse({ error: 'database unavailable' }, 500)))
    );
    const networkFailure = await checkMonitoringEndpoint(
      MONITORING_ENDPOINTS[0],
      mock(() => Promise.reject(new Error('Connection refused')))
    );

    expect(httpFailure.state).toBe('unavailable');
    expect(httpFailure.message).toBe('HTTP 500');
    expect(networkFailure.state).toBe('unavailable');
    expect(networkFailure.message).toBe('Connection refused');
  });

  it('reports an HTTP status when a failed endpoint returns a non-JSON body', async () => {
    const result = await checkMonitoringEndpoint(
      MONITORING_ENDPOINTS[0],
      mock(() => Promise.resolve(new Response('Not found', { status: 404 })))
    );

    expect(result.state).toBe('unavailable');
    expect(result.message).toBe('HTTP 404');
  });
});
