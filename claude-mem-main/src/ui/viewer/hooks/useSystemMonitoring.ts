import { useCallback, useEffect, useRef, useState } from 'react';
import { TIMING } from '../constants/timing';
import { checkMonitoringEndpoint, MONITORING_ENDPOINTS, MonitoringCheck } from '../utils/monitoring';

export function useSystemMonitoring() {
  const [checks, setChecks] = useState<MonitoringCheck[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setIsRefreshing(true);

    try {
      const results = await Promise.all(
        MONITORING_ENDPOINTS.map(endpoint => checkMonitoringEndpoint(endpoint, undefined, controller.signal))
      );
      if (!controller.signal.aborted) {
        setChecks(results);
        setLastCheckedAt(Date.now());
      }
    } finally {
      if (!controller.signal.aborted) {
        setIsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    let active = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      await refresh();
      if (active) {
        timeout = setTimeout(poll, TIMING.STATS_REFRESH_INTERVAL_MS);
      }
    };

    void poll();
    return () => {
      active = false;
      if (timeout) clearTimeout(timeout);
      requestRef.current?.abort();
    };
  }, [refresh]);

  return { checks, isRefreshing, lastCheckedAt, refresh };
}
