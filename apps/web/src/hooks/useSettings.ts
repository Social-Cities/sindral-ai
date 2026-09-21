import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SecretStatus, SetSecretInput, WorkerKey } from '@sindral/shared';
import { createWorkerKey, deleteSecret, getMe, listSecrets, listWorkerKeys, revokeWorkerKey, setSecret } from '@/lib/api';
import { queryKeys } from './queryKeys';

export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: async () => (await getMe()).user,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useSecrets() {
  return useQuery({
    queryKey: queryKeys.secrets,
    queryFn: async () => (await listSecrets()).secrets,
  });
}

export function useSetSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetSecretInput) => setSecret(input),
    onSuccess: ({ secret }) => {
      qc.setQueryData<SecretStatus[]>(queryKeys.secrets, (prev) => {
        const rest = (prev ?? []).filter((s) => s.provider !== secret.provider);
        return [...rest, secret];
      });
      void qc.invalidateQueries({ queryKey: queryKeys.secrets });
    },
  });
}

export function useDeleteSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (provider: SetSecretInput['provider']) => deleteSecret(provider),
    onSuccess: (_res, provider) => {
      qc.setQueryData<SecretStatus[]>(queryKeys.secrets, (prev) =>
        (prev ?? []).map((s) => (s.provider === provider ? { ...s, configured: false, hint: null, updatedAt: null } : s)),
      );
      void qc.invalidateQueries({ queryKey: queryKeys.secrets });
    },
  });
}

export function useWorkerKeys() {
  return useQuery({
    queryKey: queryKeys.workerKeys,
    queryFn: async () => (await listWorkerKeys()).keys,
  });
}

export function useCreateWorkerKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createWorkerKey(name),
    onSuccess: ({ key }) => {
      qc.setQueryData<WorkerKey[]>(queryKeys.workerKeys, (prev) => [...(prev ?? []), key]);
      void qc.invalidateQueries({ queryKey: queryKeys.workerKeys });
    },
  });
}

export function useRevokeWorkerKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeWorkerKey(id),
    onSuccess: (_res, id) => {
      qc.setQueryData<WorkerKey[]>(queryKeys.workerKeys, (prev) =>
        (prev ?? []).map((k) => (k.id === id ? { ...k, revokedAt: new Date().toISOString() } : k)),
      );
      void qc.invalidateQueries({ queryKey: queryKeys.workerKeys });
    },
  });
}
