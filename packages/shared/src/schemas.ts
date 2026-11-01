import { z } from 'zod';
import { ALL_OUTPUT_KINDS, ALL_PERMISSIONS, ALL_TOOLS } from './defaultWorkflows.js';
import { APP_PLATFORMS, ARTIFACT_CONTENT_TYPES, DDD_CRITERIA, MAX_ARTIFACT_BYTES, type JobContext } from './types.js';
import { designResultSchema } from './design.js';

const id = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-_]*$/i);
const shortText = z.string().trim().min(1).max(200);
const longText = z.string().max(100_000);
export const appPlatformsSchema = z.array(z.enum(APP_PLATFORMS)).min(1).max(3)
  .refine((values) => new Set(values).size === values.length, 'Platforms must be unique');

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
  resumeSessionKey: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9-_]*$/i).optional(),
  platform: z.enum(APP_PLATFORMS).optional(),
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
  mobilePlatforms: appPlatformsSchema.optional(),
  troubleshootStep: workflowStepSchema.optional(),
});

export const createWorkflowSchema = z.object({
  name: shortText,
  /** Optional workflow id to clone; omit to start with a minimal workflow. */
  cloneFrom: z.string().min(1).max(64).optional(),
});

export const updateWorkflowSchema = workflowSchema.omit({ id: true });

const repo = z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Repositories must be owner/name');

export const createGitHubRepositorySchema = z.object({
  owner: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/, 'Invalid GitHub owner'),
  name: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/, 'Invalid repository name'),
  visibility: z.enum(['private', 'public']).default('private'),
  description: z.string().trim().max(350).optional(),
});

export const createProjectSchema = z.object({
  name: shortText,
  description: z.string().trim().max(2000).default(''),
  projectType: z.enum(['standard', 'mobile-app']).optional(),
  platforms: appPlatformsSchema.optional(),
  repository: createGitHubRepositorySchema.optional(),
  repos: z.array(repo).max(20).optional(),
}).refine((input) => Boolean(input.repository) || (input.repos?.length ?? 0) > 0, {
  message: 'Select an existing repository or create a new one',
  path: ['repos'],
}).refine((input) => (input.repos?.length ?? 0) + (input.repository ? 1 : 0) <= 20, {
  message: 'Projects support at most 20 repositories',
  path: ['repos'],
}).refine((input) => input.projectType !== 'mobile-app' || (input.repos?.length ?? 0) + (input.repository ? 1 : 0) === 1, {
  message: 'Mobile app projects use one monorepo', path: ['repos'],
}).refine((input) => input.projectType === 'mobile-app' || input.platforms === undefined, {
  message: 'Platform selection requires a mobile app project', path: ['platforms'],
});

export const updateProjectSchema = z.object({
  projectType: z.enum(['standard', 'mobile-app']).optional(),
  platforms: appPlatformsSchema.optional(),
  name: shortText.optional(),
  description: z.string().trim().max(2000).optional(),
  repos: z.array(repo).max(20).optional(),
  newRepositories: z.array(createGitHubRepositorySchema).max(20).optional(),
}).refine((input) => (input.repos?.length ?? 0) + (input.newRepositories?.length ?? 0) <= 20, {
  message: 'Projects support at most 20 repositories',
  path: ['repos'],
});

export const createTaskSchema = z.object({
  platforms: appPlatformsSchema.optional(),
  title: shortText,
  description: longText.default(''),
  ticketUrl: z.string().url().max(2000).optional(),
  key: z.string().trim().regex(/^[A-Z][A-Z0-9]*-\d+$/).optional(),
  projectId: z.string().uuid().optional(),
  workflowId: z.string().max(64).optional(),
  repos: z.array(repo).max(10).default([]),
  newRepository: createGitHubRepositorySchema.optional(),
  designHandoff: z.object({ revisionId: z.string().uuid(), idempotencyKey: z.string().uuid() }).optional(),
}).refine((input) => input.repos.length + (input.newRepository ? 1 : 0) <= 10, {
  message: 'Tasks support at most 10 repositories',
  path: ['repos'],
});

export const updateTaskSchema = z.object({
  platforms: appPlatformsSchema.nullable().optional(),
  title: shortText.optional(),
  description: longText.optional(),
  projectId: z.string().uuid().nullable().optional(),
  repos: z.array(repo).max(10).optional(),
  workflowId: z.string().max(64).nullable().optional(),
});

export const taskActionSchema = z.object({
  event: z.string().trim().min(1).max(32).regex(/^[a-z][a-z0-9-_]*$/),
  expectedVersion: z.number().int().nonnegative(),
});

export const repinWorkflowSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
});

export const previewWorkflowAssignmentSchema = z.object({
  workflowId: id,
  stepId: id.optional(),
});

export const assignWorkflowSchema = previewWorkflowAssignmentSchema.extend({
  stepId: id,
  expectedVersion: z.number().int().nonnegative(),
  acknowledgeWarnings: z.boolean().default(false),
});

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  feedbackTarget: z.enum(['bdd', 'implementation']).optional(),
});

export const listTasksQuerySchema = z.object({
  state: z.string().max(64).optional(),
  workflowId: z.string().max(64).optional(),
  projectId: z.string().uuid().optional(),
  search: z.string().max(200).optional(),
  parentTaskId: z.string().uuid().optional(),
  includeSubtasks: z.coerce.boolean().default(false),
});

export const importTicketSchema = z.object({ url: z.string().url().max(2000) });

export const setSecretSchema = z.object({
  provider: z.enum(['github', 'linear', 'jira']),
  token: z.string().trim().min(8).max(4000),
  /** Jira needs the account email for basic auth. */
  email: z.string().email().max(200).optional(),
});

export const createWorkerKeySchema = z.object({ name: shortText });

export const pushDeviceSchema = z.object({
  platform: z.literal('ios'),
  environment: z.enum(['sandbox', 'production']),
  token: z.string().trim().min(64).max(512).regex(/^[0-9a-fA-F]+$/, 'Device token must be hexadecimal'),
});

// ---- worker API ----
export const workerRegisterSchema = z.object({
  name: shortText,
  hostname: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(50),
  workerId: z.string().uuid().optional(),
});

export const workerHeartbeatSchema = z.object({
  workerId: z.string().uuid(),
  runningJobs: z.array(z.object({ jobId: z.string().uuid(), leaseToken: z.string().uuid() })).max(100),
});

export const workerClaimSchema = z.object({
  workerId: z.string().uuid(),
  max: z.number().int().min(1).max(10).default(1),
});

export const workerIdentitySchema = z.object({ workerId: z.string().uuid() });

export const workerJobEventSchema = z.object({
  type: z.enum(['log', 'progress', 'message']),
  message: z.string().max(20_000),
  attempt: z.number().int().positive(),
  leaseToken: z.string().uuid(),
});

const artifactSchema = z.object({
  name: z.string().trim().min(1).max(200).regex(/^[^/\\]+$/, 'Artifact names cannot contain path separators'),
  contentType: z.enum(ARTIFACT_CONTENT_TYPES),
  content: z
    .string()
    .max(MAX_ARTIFACT_BYTES)
    .refine((content) => new TextEncoder().encode(content).byteLength <= MAX_ARTIFACT_BYTES, 'Artifact content exceeds the byte limit'),
});

const taskContractResultFields = {
  outcome: z.string().trim().min(1).max(20_000).optional(),
  acceptanceCriteria: z.string().trim().min(1).max(50_000).optional(),
};

export const bddPlanResultSchema = z.object({
  kind: z.literal('bdd-plan'),
  summary: z.string().max(20_000),
  plan: z.string().trim().min(1).max(200_000),
  scenarios: z.array(z.object({
    id,
    given: z.string().trim().min(1).max(10_000),
    when: z.string().trim().min(1).max(10_000),
    then: z.string().trim().min(1).max(10_000),
  })).min(1).max(200).refine((scenarios) => new Set(scenarios.map((scenario) => scenario.id)).size === scenarios.length, 'Scenario ids must be unique'),
  ...taskContractResultFields,
});

export const agentResultSchema = z.discriminatedUnion('kind', [
  designResultSchema,
  bddPlanResultSchema,
  z.object({
    kind: z.literal('plan'),
    summary: z.string().max(20_000),
    plan: z.string().max(200_000),
    ...taskContractResultFields,
  }),
  z.object({
    kind: z.literal('pr'),
    summary: z.string().max(20_000),
    prUrl: z.string().url().max(2000),
    branch: z.string().max(200),
    ...taskContractResultFields,
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
    kind: z.literal('implementation'),
    summary: z.string().max(20_000),
    ...taskContractResultFields,
  }),
  z.object({
    kind: z.literal('review-slice'),
    summary: z.string().max(20_000),
    prUrl: z.string().url().max(2000),
    branch: z.string().max(200),
    slices: z.array(
      z.object({
        repository: repo,
        commit: z.string().regex(/^[0-9a-f]{7,40}$/i),
        title: shortText,
        summary: z.string().max(20_000),
        files: z.array(z.string().min(1).max(1000)).max(200),
        reviewNotes: z.string().max(20_000).optional(),
      }),
    ).min(1).max(50),
    ...taskContractResultFields,
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
    ...taskContractResultFields,
  }),
  z.object({
    kind: z.literal('verdict'),
    summary: z.string().max(20_000),
    report: z.string().max(200_000),
    verdict: z.enum(['GO', 'NO_GO']),
    feedback: z.string().max(50_000).optional(),
    bddChecks: z.array(z.object({
      scenarioId: id,
      platform: z.enum(APP_PLATFORMS),
      command: z.string().trim().min(1).max(2000),
      status: z.enum(['passed', 'failed', 'blocked']),
      evidence: z.string().trim().min(1).max(20_000),
    })).max(600).optional(),
    dddChecks: z.array(z.object({
      scope: z.string().trim().min(1).max(200),
      criterion: z.enum(DDD_CRITERIA),
      status: z.enum(['passed', 'failed', 'blocked']),
      evidence: z.string().trim().min(1).max(20_000),
    })).max(100).optional(),
    ...taskContractResultFields,
  }),
  z.object({ kind: z.literal('document'), summary: z.string().max(20_000), artifacts: z.array(artifactSchema).max(50), ...taskContractResultFields }),
  z.object({ kind: z.literal('troubleshoot'), summary: z.string().max(20_000), diagnosis: z.string().max(100_000), resolved: z.boolean(), ...taskContractResultFields }),
  z.object({
    kind: z.literal('rebase'),
    summary: z.string().max(20_000),
    rebased: z.array(
      z.object({
        taskId: z.string(),
        branch: z.string(),
        ok: z.boolean(),
        headSha: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
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

/** Only mobile jobs own BDD platform evidence; discard that field for other jobs. */
export function agentResultSchemaForContext(context: Pick<JobContext, 'mobile_platforms'>) {
  if (context.mobile_platforms?.trim()) return agentResultSchema;
  return z.preprocess((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('kind' in raw) || raw.kind !== 'verdict') return raw;
    const result = { ...raw } as Record<string, unknown>;
    delete result['bddChecks'];
    return result;
  }, agentResultSchema);
}

export const workerJobCompleteSchema = z.object({
  attempt: z.number().int().positive(),
  leaseToken: z.string().uuid(),
  result: agentResultSchema,
  agentSessionId: z.string().trim().min(1).max(200).optional(),
});
export const workerJobFailSchema = z.object({ attempt: z.number().int().positive(), leaseToken: z.string().uuid(), error: z.string().trim().min(1).max(20_000) });
export const workerJobCancelSchema = z.object({ attempt: z.number().int().positive(), leaseToken: z.string().uuid() });

/** Loose schema for what the agent writes to the result file (kind may be missing; the worker fills it). */
export const rawAgentResultFileSchema = z.object({ kind: z.string().optional() }).passthrough();

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type CreateGitHubRepositoryInput = z.infer<typeof createGitHubRepositorySchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type AssignWorkflowInput = z.infer<typeof assignWorkflowSchema>;
export type PreviewWorkflowAssignmentInput = z.infer<typeof previewWorkflowAssignmentSchema>;
export type RepinWorkflowInput = z.infer<typeof repinWorkflowSchema>;
export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowSchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
export type SetSecretInput = z.infer<typeof setSecretSchema>;
export type WorkerRegisterInput = z.infer<typeof workerRegisterSchema>;
export type WorkerHeartbeatInput = z.infer<typeof workerHeartbeatSchema>;
export type WorkerClaimInput = z.infer<typeof workerClaimSchema>;
export type WorkerIdentityInput = z.infer<typeof workerIdentitySchema>;
export type WorkerJobEventInput = z.infer<typeof workerJobEventSchema>;
