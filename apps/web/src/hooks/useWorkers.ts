import { useQuery } from '@tanstack/react-query';
import { listWorkers } from '@/lib/api';
import { queryKeys } from './queryKeys';

export function useWorkers() {
  return useQuery({
    queryKey: queryKeys.workers,
    queryFn: async () => (await listWorkers()).workers,
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
}
