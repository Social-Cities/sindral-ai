import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ServerEvent } from '@sindral/shared';
import { subscribeToEvents } from '@/lib/events';
import { queryKeys } from './queryKeys';

export type LiveStatus = 'connecting' | 'open' | 'closed';

/**
 * Keep TanStack Query caches fresh from the server's SSE stream. Mount once
 * inside the authenticated app shell.
 */
export function useServerEvents(enabled: boolean): LiveStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('closed');

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const onEvent = (event: ServerEvent) => {
      switch (event.type) {
        case 'task.created':
        case 'task.updated':
        case 'task.deleted':
          void qc.invalidateQueries({ queryKey: queryKeys.tasks });
          void qc.invalidateQueries({ queryKey: queryKeys.task(event.taskId) });
          break;
        case 'worker.updated':
          void qc.invalidateQueries({ queryKey: queryKeys.workers });
          break;
        case 'ping':
          break;
      }
    };
    void subscribeToEvents({ onEvent, onStatus: setStatus, signal: controller.signal });
    return () => controller.abort();
  }, [enabled, qc]);

  return status;
}
