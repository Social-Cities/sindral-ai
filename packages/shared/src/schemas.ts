import { z } from 'zod';
import { ALL_OUTPUT_KINDS, ALL_PERMISSIONS, ALL_TOOLS } from './defaultWorkflows.js';

const id = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-_]*$/i);
const shortText = z.string().trim().min(1).max(200);
const longText = z.string().max(100_000);

export const workflowStepSchema = z.object({
  id,
  type: z.enum(['agent', 'human', 'end']),
  label: shortText,
  state: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
  engine: z.enum(['claude', 'codex']).optional(),
  model: z.string().trim().min(1).max(100).optional(),
  mode: z.enum(['high', 'normal', 'low']).optional(),
  prompt: z.string().max(20_000).optional(),
  tools: z.array(z.enum(ALL_TOOLS)).max(ALL_TOOLS.length).optional(),
  permissions: z.array(z.enum(ALL_PERMISSIONS)).max(ALL_PERMISSIONS.length).optional(),
  output: z.enum(ALL_OUTPUT_KINDS).optional(),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
});

export const workflowEdgeSchema = z.object({
  from: id,
  to: id,
  event: z.string().trim().min(1).max(32).regex(/^[a-z][a-z0-9-_]*$/),
  label: z.string().trim().max(60).optional(),
});

export const workflowSchema = z.object({
  id,
  name: shortText,
  description: z.string().max(500).optional(),
  entryStepId: id,
  steps: z.array(workflowStepSchema).min(1).max(50),
  edges: z.array(workflowEdgeSchema).max(200),
  troubleshootStep: workflowStepSchema.optional(),
});

export const createWorkflowSchema = z.object({
  name: shortText,
  /** Optional workflow id to clone; defaults to the Full SDLC workflow. */
  cloneFrom: z.string().max(64).optional(),
});

export const updateWorkflowSchema = workflowSchema.omit({ id: true });

const repo = z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Repositories must be owner/name');

export const createTaskSchema = z.object({
  title: shortText,
  description: longText.default(''),
  ticketUrl: z.string().url().max(2000).optional(),
  key: z.string().trim().regex(/^[A-Z][A-Z0-9]*-\d+$/).optional(),
  workflowId: z.string().max(64).optional(),
  repos: z.array(repo).max(10).default([]),
});

export const updateTaskSchema = z.object({
  title: shortText.optional(),
  description: longText.optional(),
  repos: z.array(repo).max(10).optional(),
  workflowId: z.string().max(64).nullable().optional(),
});

export const taskActionSchema = z.object({
  event: z.string().trim().min(1).max(32).regex(/^[a-z][a-z0-9-_]*$/),
});

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
});

export const listTasksQuerySchema = z.object({
  state: z.string().max(64).optional(),
  workflowId: z.string().max(64).optional(),
  search: z.string().max(200).optional(),
  parentTaskId: z.string().uuid().optional(),
  includeSubtasks: z.coerce.boolean().default(false),
});

export const importTicketSchema = z.object({ url: z.string().url().max(2000) });

export const setSecretSchema = z.object({
  provider: z.enum(['github', 'linear', 'jira']),
  token: z.string().min(8).max(4000),
  /** Jira needs the account email for basic auth. */
  email: z.string().email().max(200).optional(),
});

export const createWorkerKeySchema = z.object({ name: shortText });

// ---- worker API ----
export const workerRegisterSchema = z.object({
  name: shortText,
  hostname: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(50),
  workerId: z.string().uuid().optional(),
});

export const workerHeartbeatSchema = z.object({
  workerId: z.string().uuid(),
  runningJobIds: z.array(z.string().uuid()).max(100),
});

export const workerClaimSchema = z.object({
  workerId: z.string().uuid(),
  max: z.number().int().min(1).max(10).default(1),
});

export const workerJobEventSchema = z.object({
  type: z.enum(['log', 'progress', 'message']),
  message: z.string().max(20_000),
});

const artifactSchema = z.object({
  name: z.string().trim().min(1).max(200).regex(/^[^/\\]+$/, 'Artifact names cannot contain path separators'),
  contentType: z.string().trim().min(1).max(100),
  content: z.string().max(1_000_000),
});

export const agentResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('plan'),
    summary: z.string().max(20_000),
    plan: z.string().max(200_000),
    subtasks: z.array(z.object({ title: shortText, goal: z.string().max(5000) })).max(20).optional(),
  }),
  z.object({
    kind: z.literal('pr'),
    summary: z.string().max(20_000),
    prUrl: z.string().url().max(2000),
    branch: z.string().max(200),
    pullRequests: z
      .array(
        z.object({
          repository: repo,
          prUrl: z.string().url().max(2000),
          number: z.number().int().positive(),
          branch: z.string().min(1).max(200),
          baseBranch: z.string().min(1).max(200),
          headSha: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
        }),
      )
      .max(10)
      .optional(),
  }),
  z.object({
    kind: z.literal('review'),
    summary: z.string().max(20_000),
    report: z.string().max(200_000),
    verdict: z.enum(['MATERIAL_FINDINGS', 'NO_MATERIAL_FINDINGS', 'REVIEW_BLOCKED']),
  }),
  z.object({
    kind: z.literal('verdict'),
    summary: z.string().max(20_000),
    report: z.string().max(200_000),
    verdict: z.enum(['GO', 'NO_GO']),
    feedback: z.string().max(50_000).optional(),
  }),
  z.object({ kind: z.literal('document'), summary: z.string().max(20_000), artifacts: z.array(artifactSchema).max(50) }),
  z.object({ kind: z.literal('troubleshoot'), summary: z.string().max(20_000), diagnosis: z.string().max(100_000), resolved: z.boolean() }),
  z.object({
    kind: z.literal('rebase'),
    summary: z.string().max(20_000),
    rebased: z.array(
      z.object({
        taskId: z.string(),
        branch: z.string(),
        ok: z.boolean(),
        error: z.string().optional(),
        conflict: z
          .object({
            repository: repo,
            baseBranch: z.string().min(1).max(200),
            sourceSha: z.string().regex(/^[0-9a-f]{40}$/i),
            targetSha: z.string().regex(/^[0-9a-f]{40}$/i),
            conflictedPaths: z.array(z.string().min(1).max(1000)).min(1).max(200),
          })
          .optional(),
      }),
    ),
  }),
  z.object({
    kind: z.literal('conflict-resolution'),
    summary: z.string().max(20_000),
    taskId: z.string().uuid(),
    branch: z.string().min(1).max(200),
    resolved: z.boolean(),
    rationale: z.string().max(100_000),
    resolvedPaths: z.array(z.string().min(1).max(1000)).max(200),
    checks: z.array(z.object({ command: z.array(z.string()).min(1).max(50), ok: z.boolean(), output: z.string().max(20_000) })).max(20),
    resolutionCommit: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
    resolutionDiffHash: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
    error: z.string().max(20_000).optional(),
  }),
  z.object({
    kind: z.literal('merge'),
    summary: z.string().max(20_000),
    complete: z.boolean(),
    pullRequests: z.array(
      z.object({
        id: z.string().uuid(),
        repository: repo,
        url: z.string().url().max(2000),
        merged: z.boolean(),
        mergedAt: z.string().datetime().optional(),
        error: z.string().max(20_000).optional(),
      }),
    ).max(10),
  }),
]);

export const workerJobCompleteSchema = z.object({ attempt: z.number().int().positive(), result: agentResultSchema });
export const workerJobFailSchema = z.object({ attempt: z.number().int().positive(), error: z.string().trim().min(1).max(20_000) });

/** Loose schema for what the agent writes to the result file (kind may be missing; the worker fills it). */
export const rawAgentResultFileSchema = z.object({ kind: z.string().optional() }).passthrough();

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowSchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
export type SetSecretInput = z.infer<typeof setSecretSchema>;
export type WorkerRegisterInput = z.infer<typeof workerRegisterSchema>;
export type WorkerHeartbeatInput = z.infer<typeof workerHeartbeatSchema>;
export type WorkerClaimInput = z.infer<typeof workerClaimSchema>;
export type WorkerJobEventInput = z.infer<typeof workerJobEventSchema>;
