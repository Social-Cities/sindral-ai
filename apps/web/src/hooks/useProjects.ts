import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateProjectInput, Project, UpdateProjectInput } from '@sindral/shared';
import { createProject, deleteProject, getProject, listProjects, updateProject } from '@/lib/api';
import { queryKeys } from './queryKeys';

export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: async () => (await listProjects()).projects,
    staleTime: 10_000,
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.project(id ?? ''),
    queryFn: async () => (await getProject(id ?? '')).project,
    enabled: !!id,
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => createProject(input),
    onSuccess: ({ project }) => {
      qc.setQueryData<Project[]>(queryKeys.projects, (prev) => [project, ...(prev ?? []).filter((existing) => existing.id !== project.id)]);
      void qc.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

export function useUpdateProject(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateProjectInput) => updateProject(id, input),
    onSuccess: ({ project }) => {
      qc.setQueryData<Project>(queryKeys.project(id), project);
      qc.setQueryData<Project[]>(queryKeys.projects, (prev) => (prev ?? []).map((existing) => (existing.id === project.id ? project : existing)));
      void qc.invalidateQueries({ queryKey: queryKeys.projects });
      void qc.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteProject(id),
    onSuccess: (_res, id) => {
      qc.removeQueries({ queryKey: queryKeys.project(id) });
      void qc.invalidateQueries({ queryKey: queryKeys.projects });
      void qc.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}
