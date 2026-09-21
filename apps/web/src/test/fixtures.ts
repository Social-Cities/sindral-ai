import type { Message, Task, TaskWithRelations, Workflow, WorkflowRecord } from '@sindral/shared';
import { FULL_SDLC_WORKFLOW, snapshotWorkflow } from '@sindral/shared';

export function workflowRecord(base: Workflow = FULL_SDLC_WORKFLOW, overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    ...snapshotWorkflow(base),
    userId: 'user-1',
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

let counter = 0;

export function makeTask(overrides: Partial<Task> = {}): Task {
  counter += 1;
  const now = new Date().toISOString();
  return {
    id: `task-${counter}`,
    userId: 'user-1',
    key: `SIN-${counter}`,
    title: `Task ${counter}`,
    description: 'Some description',
    state: 'todo',
    currentStepId: 'todo',
    workflowId: FULL_SDLC_WORKFLOW.id,
    pinnedWorkflow: null,
    repos: [],
    ticketUrl: null,
    prUrl: null,
    branch: null,
    baseBranch: null,
    plan: null,
    parentTaskId: null,
    sequence: null,
    failedStepId: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<Message> = {}): Message {
  counter += 1;
  return {
    id: `msg-${counter}`,
    taskId: 'task-1',
    role: 'agent',
    content: 'Hello from the agent',
    source: 'worker',
    externalId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function makeTaskWithRelations(overrides: Partial<TaskWithRelations> = {}): TaskWithRelations {
  return { ...makeTask(), messages: [], events: [], artifacts: [], subtasks: [], repositories: [], pullRequests: [], ...overrides };
}
