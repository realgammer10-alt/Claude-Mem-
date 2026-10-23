import React from 'react';
import { MonitoringCheck, MonitoringState } from '../utils/monitoring';

interface SystemHealthProps {
  checks: MonitoringCheck[];
  isRefreshing: boolean;
  isConnected: boolean;
  lastCheckedAt: number | null;
  onRefresh: () => void;
}

function getOverallState(checks: MonitoringCheck[], isConnected: boolean): MonitoringState | 'checking' {
  if (checks.length === 0) return 'checking';
  if (checks.some(check => check.state === 'unavailable')) return 'unavailable';
  if (checks.some(check => check.state === 'degraded') || !isConnected) return 'degraded';
  return 'healthy';
}

const STATE_LABELS: Record<MonitoringState | 'checking', string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  unavailable: 'Unavailable',
  checking: 'Checking',
};

export function SystemHealth({ checks, isRefreshing, isConnected, lastCheckedAt, onRefresh }: SystemHealthProps) {
  const state = getOverallState(checks, isConnected);

  return (
    <details className="system-health">
      <summary
        className={`system-health-summary ${state}`}
        aria-label={`System status: ${STATE_LABELS[state]}`}
      >
        <span className={`system-health-dot ${state}`} aria-hidden="true" />
        <span>System: {STATE_LABELS[state]}</span>
      </summary>
      <div className="system-health-panel" role="status" aria-live="polite">
        <div className="system-health-heading">
          <strong>System health</strong>
          <button type="button" onClick={() => void onRefresh()} disabled={isRefreshing}>
            {isRefreshing ? 'Checking…' : 'Refresh'}
          </button>
        </div>
        <ul>
          <li className={`system-health-check ${isConnected ? 'healthy' : 'unavailable'}`}>
            <span className={`system-health-dot ${isConnected ? 'healthy' : 'unavailable'}`} />
            <span className="system-health-check-label">Live dashboard stream</span>
            <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
          </li>
          {checks.map(check => (
            <li className={`system-health-check ${check.state}`} key={check.key}>
              <span className={`system-health-dot ${check.state}`} />
              <span className="system-health-check-label">
                {check.label}
                <small>{check.path}</small>
              </span>
              <span className="system-health-check-result">
                {check.message}
                {check.details && <small>{check.details}</small>}
                <small>{check.latencyMs} ms</small>
              </span>
            </li>
          ))}
        </ul>
        <div className="system-health-updated">
          {lastCheckedAt === null
            ? 'Waiting for first health check'
            : `Last checked ${new Date(lastCheckedAt).toLocaleTimeString()}`}
        </div>
      </div>
    </details>
  );
}
