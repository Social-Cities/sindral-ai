import type { Page, Route } from '@playwright/test';
import {
  BUNDLED_WORKFLOWS,
  FULL_SDLC_WORKFLOW,
  snapshotWorkflow,
  transition,
  type Artifact,
  type CreateTaskInput,
  type Job,
  type Message,
  type PullRequest,
  type TaskEvent,
  type TaskWithRelations,
  type WorkflowRecord,
} from '../packages/shared/dist/index.js';

const NOW = '2026-09-22T18:00:00.000Z';
const USER_ID = '10000000-0000-4000-8000-000000000001';

export interface MockBackendOptions {
  tasks?: TaskWithRelations[];
  workers?: Array<Record<string, unknown>>;
  jobs?: Record<string, Job[]>;
  diffs?: Record<string, Array<Record<string, unknown>>>;
}

export interface MockBackend {
  tasks: TaskWithRelations[];
  requests: Array<{ method: string; path: string; body: unknown }>;
}

export function makeTask(overrides: Partial<TaskWithRelations> = {}): TaskWithRelations {
  const id = overrides.id ?? 'task-1';
  return {
    id,
    userId: USER_ID,
    version: 1,
    key: 'SIN-1',
    title: 'Harden stacked branch delivery',
    description: 'Implement the approved delivery plan.',
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
    createdAt: NOW,
    updatedAt: NOW,
    messages: [],
    events: [],
    artifacts: [],
    subtasks: [],
    repositories: [],
    pullRequests: [],
    ...overrides,
  };
}

export function makePullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'pr-1',
    userId: USER_ID,
    taskId: 'task-1',
    taskRepositoryId: 'repo-1',
    repository: 'acme/api',
    url: 'https://github.com/acme/api/pull/42',
    number: 42,
    branch: 'sindral/SIN-1',
    baseBranch: 'main',
    headSha: 'a'.repeat(40),
    status: 'open',
    mergedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'artifact-1',
    taskId: 'task-1',
    jobId: null,
    name: 'report.md',
    contentType: 'text/markdown',
    content: '# Report\n\nComplete.',
    byteSize: 20,
    downloadUrl: null,
    createdAt: NOW,
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    id: 'event-1',
    taskId: 'task-1',
    type: 'transition',
    fromState: 'todo',
    toState: 'planning',
    stepId: 'planning',
    detail: { actor: 'user' },
    createdAt: NOW,
    ...overrides,
  };
}

const workflows: WorkflowRecord[] = BUNDLED_WORKFLOWS.map((workflow, index) => ({
  ...snapshotWorkflow(workflow),
  userId: USER_ID,
  isDefault: index === 0,
  createdAt: NOW,
  updatedAt: NOW,
}));

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function token(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: USER_ID, exp: 4_102_444_800, role: 'authenticated' })}.signature`;
}

export async function installMockBackend(page: Page, options: MockBackendOptions = {}): Promise<MockBackend> {
  const state: MockBackend = { tasks: structuredClone(options.tasks ?? []), requests: [] };
  const accessToken = token();
  const user = {
    id: USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'dev@example.test',
    email_confirmed_at: NOW,
    user_metadata: { full_name: 'Dev User' },
    app_metadata: { provider: 'email', providers: ['email'] },
    identities: [],
    created_at: NOW,
    updated_at: NOW,
  };

  await page.route('http://127.0.0.1:55321/auth/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/token') && route.request().method() === 'POST') {
      await json(route, { access_token: accessToken, token_type: 'bearer', expires_in: 3600, expires_at: 4_102_444_800, refresh_token: 'refresh-token', user });
      return;
    }
    if (url.pathname.endsWith('/user')) {
      await json(route, user);
      return;
    }
    if (url.pathname.endsWith('/logout')) {
      await json(route, {});
      return;
    }
    await json(route, {});
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postDataJSON?.() ?? null;
    state.requests.push({ method, path, body });

    if (path === '/api/events') {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: ping\ndata: {"type":"ping"}\n\n' });
      return;
    }
    if (path === '/api/me') return json(route, { user: { id: USER_ID, email: user.email }, displayName: 'Dev User' });
    if (path === '/api/workflows') return json(route, { workflows });
    if (path === '/api/workers') return json(route, { workers: options.workers ?? [] });
    if (path === '/api/tasks' && method === 'GET') return json(route, { tasks: state.tasks });
    if (path === '/api/tasks' && method === 'POST') {
      const input = body as CreateTaskInput;
      const created = makeTask({
        id: `task-${state.tasks.length + 1}`,
        key: `SIN-${state.tasks.length + 1}`,
        title: input.title,
        description: input.description ?? '',
        repos: input.repos ?? [],
        ticketUrl: input.ticketUrl ?? null,
        workflowId: input.workflowId ?? FULL_SDLC_WORKFLOW.id,
      });
      state.tasks.push(created);
      return json(route, { task: created }, 201);
    }
    if (path === '/api/tickets/import' && method === 'POST') {
      return json(route, { ticket: { provider: 'github', id: 'acme/api#42', title: 'Imported issue title', description: 'Imported issue body', url: (body as { url: string }).url } });
    }

    const actionMatch = path.match(/^\/api\/tasks\/([^/]+)\/actions$/);
    if (actionMatch && method === 'POST') {
      const task = state.tasks.find((item) => item.id === actionMatch[1]);
      if (!task) return json(route, { error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404);
      const event = (body as { event: string }).event;
      const workflow = task.pinnedWorkflow ?? workflows.find((item) => item.id === task.workflowId) ?? FULL_SDLC_WORKFLOW;
      const next = transition(task, workflow, event);
      Object.assign(task, { state: next.nextState, currentStepId: next.nextStepId, failedStepId: next.failedStepId, version: task.version + 1 });
      if (!task.pinnedWorkflow) task.pinnedWorkflow = snapshotWorkflow(workflow);
      return json(route, { task });
    }

    const messageMatch = path.match(/^\/api\/tasks\/([^/]+)\/messages$/);
    if (messageMatch && method === 'POST') {
      const task = state.tasks.find((item) => item.id === messageMatch[1]);
      if (!task) return json(route, { error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404);
      const message: Message = {
        id: `message-${task.messages.length + 1}`,
        taskId: task.id,
        role: 'user',
        content: (body as { content: string }).content,
        source: 'web',
        createdAt: NOW,
      };
      task.messages.push(message);
      if (task.state === 'plan-review') {
        task.state = 'planning-feedback';
        task.currentStepId = 'planning-feedback';
        task.version += 1;
      }
      return json(route, { message, task }, 201);
    }

    const jobsMatch = path.match(/^\/api\/tasks\/([^/]+)\/jobs$/);
    if (jobsMatch) return json(route, { jobs: options.jobs?.[jobsMatch[1] ?? ''] ?? [] });
    const logsMatch = path.match(/^\/api\/jobs\/([^/]+)\/logs$/);
    if (logsMatch) return json(route, { logs: [] });
    const diffMatch = path.match(/^\/api\/tasks\/([^/]+)\/diff$/);
    if (diffMatch) {
      const repository = url.searchParams.get('repository') ?? 'default';
      return json(route, { files: options.diffs?.[repository] ?? [{ filename: 'src/index.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' }] });
    }
    const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch && method === 'GET') {
      const task = state.tasks.find((item) => item.id === taskMatch[1]);
      return task ? json(route, { task }) : json(route, { error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404);
    }
    await json(route, { error: { code: 'NOT_FOUND', message: `No mock for ${method} ${path}` } }, 404);
  });

  return state;
}

export async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill('dev@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByText('What would you like to work on today?').waitFor();
}
