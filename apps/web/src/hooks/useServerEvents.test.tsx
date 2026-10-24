import type { PropsWithChildren } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ServerEvent } from '@sindral/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { subscribeToEvents } from '@/lib/events';
import { useServerEvents } from './useServerEvents';

vi.mock('@/lib/events', () => ({ subscribeToEvents: vi.fn(async () => {}) }));
afterEach(() => vi.clearAllMocks());

it('refreshes active durable state on serverless sync without refetching the GitHub catalog', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const task = vi.fn(async () => ({ title: 'Changed on another function' }));
  const worker = vi.fn(async () => ({ status: 'online' }));
  client.setQueryData(['task', 't1'], { title: 'Old title' });
  client.setQueryData(['workers'], { status: 'offline' });
  client.setQueryData(['github-catalog'], { repositories: [] });
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, unmount } = renderHook(() => useServerEvents(true), { wrapper });
  const options = vi.mocked(subscribeToEvents).mock.calls[0]![0];
  // Observe the cached queries as mounted screens would, so invalidation refetches them.
  const { QueryObserver } = await import('@tanstack/react-query');
  const taskObserver = new QueryObserver(client, { queryKey: ['task', 't1'], queryFn: task, staleTime: Infinity });
  const workerObserver = new QueryObserver(client, { queryKey: ['workers'], queryFn: worker, staleTime: Infinity });
  const stopTask = taskObserver.subscribe(() => {});
  const stopWorker = workerObserver.subscribe(() => {});
  try {
    act(() => { options.onStatus?.('open'); options.onEvent({ type: 'sync' } satisfies ServerEvent); });
    await waitFor(() => expect(client.getQueryData(['task', 't1'])).toEqual({ title: 'Changed on another function' }));
    await waitFor(() => expect(client.getQueryData(['workers'])).toEqual({ status: 'online' }));
    expect(client.getQueryState(['github-catalog'])?.isInvalidated).toBe(false);
    expect(result.current).toBe('open');
    unmount();
    expect(options.signal.aborted).toBe(true);
  } finally {
    stopTask(); stopWorker(); client.clear();
  }
});
