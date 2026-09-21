export const queryKeys = {
  tasks: ['tasks'] as const,
  task: (id: string) => ['task', id] as const,
  taskJobs: (id: string) => ['task', id, 'jobs'] as const,
  taskDiff: (id: string) => ['task', id, 'diff'] as const,
  jobLogs: (jobId: string) => ['job', jobId, 'logs'] as const,
  workflows: ['workflows'] as const,
  workers: ['workers'] as const,
  secrets: ['secrets'] as const,
  workerKeys: ['worker-keys'] as const,
  me: ['me'] as const,
};
