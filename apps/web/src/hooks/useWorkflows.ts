import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateWorkflowInput, UpdateWorkflowInput, WorkflowRecord } from '@sindral/shared';
import { createWorkflow, deleteWorkflow, listWorkflows, updateWorkflow } from '@/lib/api';
import { queryKeys } from './queryKeys';

export function useWorkflows() {
  return useQuery({
    queryKey: queryKeys.workflows,
    queryFn: async () => (await listWorkflows()).workflows,
    staleTime: 30_000,
  });
}

export function useCreateWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWorkflowInput) => createWorkflow(input),
    onSuccess: ({ workflow }) => {
      qc.setQueryData<WorkflowRecord[]>(queryKeys.workflows, (prev) => (prev ? [...prev, workflow] : [workflow]));
      void qc.invalidateQueries({ queryKey: queryKeys.workflows });
    },
  });
}

export function useUpdateWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateWorkflowInput }) => updateWorkflow(id, input),
    onSuccess: ({ workflow }) => {
      qc.setQueryData<WorkflowRecord[]>(queryKeys.workflows, (prev) =>
        prev ? prev.map((w) => (w.id === workflow.id ? workflow : w)) : [workflow],
      );
    },
  });
}

export function useDeleteWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteWorkflow(id),
    onSuccess: (_res, id) => {
      qc.setQueryData<WorkflowRecord[]>(queryKeys.workflows, (prev) => prev?.filter((w) => w.id !== id));
      void qc.invalidateQueries({ queryKey: queryKeys.workflows });
    },
  });
}
