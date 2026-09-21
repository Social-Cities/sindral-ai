import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateTaskInput, Message, Task, TaskWithRelations, UpdateTaskInput, Workflow } from '@sindral/shared';
import { chatTriggersFeedback, transition } from '@sindral/shared';
import {
  ApiError,
  createTask,
  deleteTask,
  getJobLogs,
  getTask,
  getTaskDiff,
  getTaskJobs,
  listTasks,
  runTaskAction,
  sendMessage,
  updateTask,
} from '@/lib/api';
import { queryKeys } from './queryKeys';

export function useTasks() {
  return useQuery({
    queryKey: queryKeys.tasks,
    queryFn: async () => (await listTasks({ includeSubtasks: true })).tasks,
    staleTime: 5_000,
  });
}

export function useTask(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.task(id ?? ''),
    queryFn: async () => (await getTask(id ?? '')).task,
    enabled: !!id,
    staleTime: 2_000,
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => createTask(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tasks }),
  });
}

export function useUpdateTask(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTaskInput) => updateTask(id, input),
    onSuccess: ({ task }) => {
      qc.setQueryData<TaskWithRelations>(queryKeys.task(id), (prev) => (prev ? { ...prev, ...task } : prev));
      void qc.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteTask(id),
    onSuccess: (_res, id) => {
      qc.removeQueries({ queryKey: queryKeys.task(id) });
      void qc.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}

/** Apply the shared state machine locally for an optimistic update; null when it cannot be computed. */
function predictTransition(task: TaskWithRelations, workflow: Workflow | null, event: string): Partial<Task> | null {
  if (!workflow) return null;
  try {
    const t = transition(task, workflow, event);
    const patch: Partial<Task> = {
      state: t.nextState,
      currentStepId: t.nextStepId,
      failedStepId: t.failedStepId,
      updatedAt: new Date().toISOString(),
    };
    if (!task.pinnedWorkflow && task.state === 'todo') patch.pinnedWorkflow = workflow;
    return patch;
  } catch {
    return null;
  }
}

/**
 * Run a workflow event on a task. The cached task's `state` is updated
 * immediately (computed with the shared `transition()`), rolled back on error
 * and re-fetched on settle.
 */
export function useTaskAction(taskId: string, workflow: Workflow | null) {
  const qc = useQueryClient();
  const key = queryKeys.task(taskId);
  return useMutation({
    mutationFn: (event: string) => runTaskAction(taskId, event),
    onMutate: async (event) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<TaskWithRelations>(key);
      if (previous) {
        const patch = predictTransition(previous, workflow, event);
        if (patch) qc.setQueryData<TaskWithRelations>(key, { ...previous, ...patch });
      }
      return { previous };
    },
    onError: (_err, _event, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
    },
    onSuccess: ({ task }) => {
      qc.setQueryData<TaskWithRelations>(key, (prev) => (prev ? { ...prev, ...task } : prev));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}

/**
 * Send a chat message. The message is appended optimistically and, when the
 * current human step has a `feedback` edge, the state transitions immediately.
 */
export function useSendMessage(taskId: string, workflow: Workflow | null) {
  const qc = useQueryClient();
  const key = queryKeys.task(taskId);
  return useMutation({
    mutationFn: (content: string) => sendMessage(taskId, content),
    onMutate: async (content) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<TaskWithRelations>(key);
      const optimisticId = `optimistic-${Date.now()}`;
      if (previous) {
        const optimistic: Message = {
          id: optimisticId,
          taskId,
          role: 'user',
          content,
          source: 'web',
          createdAt: new Date().toISOString(),
        };
        const patch = chatTriggersFeedback(previous, workflow) ? predictTransition(previous, workflow, 'feedback') : null;
        qc.setQueryData<TaskWithRelations>(key, {
          ...previous,
          ...(patch ?? {}),
          messages: [...previous.messages, optimistic],
        });
      }
      return { previous, optimisticId };
    },
    onError: (_err, _content, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
    },
    onSuccess: ({ message, task }, _content, ctx) => {
      qc.setQueryData<TaskWithRelations>(key, (prev) => {
        if (!prev) return prev;
        const messages = prev.messages.map((m) => (m.id === ctx?.optimisticId ? message : m));
        if (!messages.some((m) => m.id === message.id)) messages.push(message);
        return { ...prev, ...task, messages };
      });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: queryKeys.tasks });
    },
  });
}

export function useTaskJobs(taskId: string, options: { enabled?: boolean; live?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.taskJobs(taskId),
    queryFn: async () => (await getTaskJobs(taskId)).jobs,
    enabled: options.enabled ?? true,
    refetchInterval: options.live ? 5_000 : false,
  });
}

export function useJobLogs(jobId: string | null, options: { live?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.jobLogs(jobId ?? ''),
    queryFn: async () => (await getJobLogs(jobId ?? '')).logs,
    enabled: !!jobId,
    refetchInterval: options.live ? 3_000 : false,
  });
}

export function useTaskDiff(taskId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.taskDiff(taskId),
    queryFn: async () => (await getTaskDiff(taskId)).files,
    enabled: options.enabled ?? true,
    retry: false,
    staleTime: 30_000,
  });
}
