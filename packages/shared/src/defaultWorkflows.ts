import type { Workflow, WorkflowStep } from './types.js';

const READ_TOOLS = ['read_file', 'search_codebase', 'list_directory'] as const;
const WRITE_TOOLS = ['read_file', 'write_file', 'run_command', 'search_codebase', 'list_directory'] as const;

const PLANNING_PROMPT = `You are a senior software engineer and technical lead working on task {{task_key}}: "{{task_title}}".

Follow the \`investigate-task\` and \`plan-change\` skills if they are available; otherwise follow their contracts directly.

1. Investigate the codebase to understand existing patterns, architecture, tests and constraints before planning.
2. Define the task contract before planning. Preserve the imported outcome and acceptance criteria when they are already accurate; otherwise generate missing values or revise them to address the user's feedback. Acceptance criteria must be observable and testable.
3. Start the plan with concise sections named exactly \`What behavior is changing\`, \`What files/systems are affected\`, \`Important invariants\`, \`Edge cases\`, and \`How correctness will be verified\`. Include the structured task contract in those sections: the behavior section must reflect the outcome, and the verification section must cover every acceptance criterion. Then provide a precise, actionable implementation plan with numbered steps, files expected to change, risk controls, and a verification contract.
4. Optimize for one coherent implementation per ticket. Do not split the task into subtasks for reviewability alone; a later review-slicing step will arrange the final branch into ordered, human-reviewable commits and explain each one.

Task description:
{{task_description}}

Imported/current outcome (generate one if empty; revise it when the user's feedback asks you to):
{{task_outcome}}

Imported/current acceptance criteria (generate them if empty; revise them when the user's feedback asks you to):
{{acceptance_criteria}}

Previous plan (empty if this is the first pass):
{{plan}}

User feedback to address (empty if none):
{{feedback}}

`;

const IMPLEMENT_PROMPT = `You are a senior software engineer implementing task {{task_key}}: "{{task_title}}".

Follow the \`design-tests\` and \`implement-change\` skills if available; otherwise follow their contracts directly.

- Implement the approved plan precisely with the smallest maintainable diff. Follow repository conventions.
- Every change must be typechecked and accompanied by unit tests. Run the repository's real build/typecheck/test commands and fix failures before finishing.
- Commit your work with clear messages on the current branch. Do not push and do not open a PR; a later review-slicing step publishes the PR.
- If you discover the plan is materially wrong, stop and explain in the summary instead of inventing behaviour.

Task description:
{{task_description}}

Required outcome:
{{task_outcome}}

Acceptance criteria (implement and verify every item):
{{acceptance_criteria}}

Approved plan:
{{plan}}

Feedback to address (empty on the first implementation pass; on later passes this contains reviewer comments from the user, GitHub or the verification agent):
{{feedback}}`;

const REVIEW_SLICE_PROMPT = `You are a senior engineer preparing task {{task_key}}: "{{task_title}}" for human code review.

The implementation is complete on the current branch. Your job is to make the final PR easy to review as one change by arranging the branch into ordered, logical commits and writing a commit-by-commit review guide.

Rules:
- Preserve the net behavior of the implementation. You may rewrite local commit history, reorder commits, split commits, squash noisy fixups, and improve commit messages, but do not introduce unrelated behavior changes.
- Each final commit should be a self-contained review unit with a clear title. Prefer a small number of meaningful commits over one giant commit or many mechanical crumbs.
- Run lightweight validation after rewriting history. If full tests are too expensive, explain the focused checks you ran.
- Do not push and do not open a PR; the worker publishes the final branch after you return the result.

For every final commit in order, include the repository, commit sha, title, changed files, a concise explanation, and any focused reviewer notes.

Task description:
{{task_description}}

Required outcome:
{{task_outcome}}

Acceptance criteria:
{{acceptance_criteria}}

Approved plan:
{{plan}}

Implementation / reviewer feedback to preserve (may be empty):
{{feedback}}`;

const REVIEW_PROMPT = `You are an independent reviewer for task {{task_key}}: "{{task_title}}". You did not write this change.

Follow the \`adversarial-review\` skill (https://github.com/thelimeburner/ai-engineering-skills/blob/main/skills/adversarial-review/SKILL.md) if available; otherwise apply its contract directly:
- Try to prove the implementation wrong across requirements, authorization, input/data, concurrency, reliability, compatibility, security/privacy, performance, operations, tests and maintainability.
- Do not rubber-stamp because tests pass. Do not edit code.
- Every finding needs evidence, a concrete failure scenario, the smallest remediation and a regression test.
- Produce the required output sections (Diff explanation, Review scope, Findings ordered by severity, Non-findings worth noting, Review verdict).

Run these review passes in order:

1. Explain this diff to a senior engineer. For every changed file, explain why it changed, what assumptions were made, and what could be wrong.
2. Try to break your implementation. Look for race conditions, incorrect assumptions, missing validation, authorization problems, bad error handling, backwards compatibility issues, and untested edge cases.

Review the diff of the current branch against its base branch. Pull request: {{pr_url}}

Task description:
{{task_description}}

Required outcome:
{{task_outcome}}

Acceptance criteria to review against:
{{acceptance_criteria}}

Approved plan:
{{plan}}

Review slice guide:
{{review_slices}}`;

const VERIFY_PROMPT = `You are the final technical gate for task {{task_key}}: "{{task_title}}".

Follow the \`verify-change\` and \`production-readiness\` skills if available; otherwise apply their contracts directly:
1. Run the repository's real compiler, typechecker, linters and tests. Never claim a check passed unless you executed it.
2. Check that the change achieves the required outcome and evaluate every acceptance criterion with concrete evidence. Also check that it follows best practice and stays within scope.
3. Evaluate every production-readiness gate and produce the readiness matrix, residual risks, rollout recommendation and human attention points.
4. Return GO only when verification is VERIFIED and there are no unresolved material findings from the adversarial review below. Otherwise return NO_GO with precise, actionable feedback for the implementer.

Pull request: {{pr_url}}

Task description:
{{task_description}}

Required outcome:
{{task_outcome}}

Acceptance criteria (the report must account for every item):
{{acceptance_criteria}}

Approved plan:
{{plan}}

Adversarial review report:
{{review}}`;

const DOCUMENT_PROMPT = `You are a senior engineer producing a written deliverable for task {{task_key}}: "{{task_title}}".

This is a non-code task. Work in the current directory, research as needed, and produce the requested deliverable(s) as markdown files.

Task description:
{{task_description}}

Required outcome:
{{task_outcome}}

Acceptance criteria:
{{acceptance_criteria}}

Feedback to address (empty if none):
{{feedback}}`;

export const DEFAULT_TROUBLESHOOT_STEP: WorkflowStep = {
  id: 'troubleshoot',
  type: 'agent',
  label: 'Troubleshoot Agent',
  state: 'troubleshoot',
  engine: 'claude',
  model: 'claude-opus-5',
  mode: 'high',
  output: 'troubleshoot',
  tools: [...WRITE_TOOLS],
  permissions: ['read', 'write', 'execute'],
  prompt: `You are a troubleshooting agent for task {{task_key}}: "{{task_title}}". A previous agent step failed.

Follow the \`debug-issue\` skill if available. Diagnose the root cause from the error below, the repository state and the conversation with the user. If the problem is something you can safely fix in the workspace (broken dependency install, merge conflict, flaky environment, missing config that the user described in chat), fix it and set "resolved": true so the failed step can be retried. If the failure needs human action (missing permissions, credentials, product decisions), explain exactly what the user must do and set "resolved": false.

Error reported by the failed step:
{{error}}

Task description:
{{task_description}}

User guidance from chat (may be empty):
{{feedback}}`,
};

export const FULL_SDLC_WORKFLOW: Workflow = {
  id: 'wf-default',
  name: 'Full SDLC',
  description: 'Plan → human approval → implement → adversarial review → verify → human review.',
  entryStepId: 'todo',
  steps: [
    { id: 'todo', type: 'human', label: 'Todo', state: 'todo', position: { x: 40, y: 150 } },
    {
      id: 'planning', type: 'agent', label: 'Planning Agent', state: 'planning',
      engine: 'claude', model: 'claude-opus-5', mode: 'high', output: 'plan',
      prompt: PLANNING_PROMPT, tools: [...READ_TOOLS], permissions: ['read'], position: { x: 200, y: 60 },
    },
    { id: 'plan-review', type: 'human', label: 'Plan Review', state: 'plan-review', position: { x: 360, y: 150 } },
    {
      id: 'planning-feedback', type: 'agent', label: 'Revise Plan', state: 'planning-feedback',
      engine: 'claude', model: 'claude-opus-5', mode: 'high', output: 'plan',
      prompt: PLANNING_PROMPT, tools: [...READ_TOOLS], permissions: ['read'], position: { x: 200, y: 240 },
    },
    {
      id: 'implement', type: 'agent', label: 'Implement Agent', state: 'implement',
      engine: 'claude', model: 'claude-sonnet-5', mode: 'high', output: 'implementation',
      prompt: IMPLEMENT_PROMPT, tools: [...WRITE_TOOLS], permissions: ['read', 'write', 'execute'], position: { x: 520, y: 60 },
    },
    {
      id: 'review-slice', type: 'agent', label: 'Review Slicer', state: 'review-slice',
      engine: 'claude', model: 'claude-opus-5', mode: 'high', output: 'review-slice',
      prompt: REVIEW_SLICE_PROMPT, tools: [...WRITE_TOOLS, 'create_pr'], permissions: ['read', 'write', 'execute'], position: { x: 680, y: 60 },
    },
    {
      id: 'adversarial-review', type: 'agent', label: 'Adversarial Review', state: 'adversarial-review',
      engine: 'claude', model: 'claude-opus-5', mode: 'high', output: 'review',
      prompt: REVIEW_PROMPT, tools: [...READ_TOOLS, 'run_command'], permissions: ['read', 'execute'], position: { x: 840, y: 60 },
    },
    {
      id: 'verify', type: 'agent', label: 'Verify & Readiness', state: 'verify',
      engine: 'claude', model: 'claude-opus-5', mode: 'high', output: 'verdict',
      prompt: VERIFY_PROMPT, tools: [...READ_TOOLS, 'run_command'], permissions: ['read', 'execute'], position: { x: 1000, y: 60 },
    },
    { id: 'in-review', type: 'human', label: 'In Review', state: 'in-review', position: { x: 1000, y: 150 } },
    { id: 'merge', type: 'agent', label: 'Merge Pull Requests', state: 'merge', output: 'merge', position: { x: 1160, y: 60 } },
    {
      id: 'implement-feedback', type: 'agent', label: 'Address Feedback', state: 'implement-feedback',
      engine: 'claude', model: 'claude-sonnet-5', mode: 'high', output: 'review-slice',
      prompt: `${IMPLEMENT_PROMPT}\n\nAfter addressing feedback, also rewrite the branch into ordered reviewable commits and return the review-slice result for the final commit order.`,
      tools: [...WRITE_TOOLS, 'create_pr'], permissions: ['read', 'write', 'execute'], position: { x: 680, y: 240 },
    },
    { id: 'done', type: 'end', label: 'Done', state: 'done', position: { x: 1320, y: 150 } },
  ],
  edges: [
    { from: 'todo', to: 'planning', event: 'start', label: 'Start Planning' },
    { from: 'planning', to: 'plan-review', event: 'complete', label: 'plan ready' },
    { from: 'plan-review', to: 'planning-feedback', event: 'feedback', label: 'revise' },
    { from: 'planning-feedback', to: 'plan-review', event: 'complete', label: 'plan revised' },
    { from: 'plan-review', to: 'implement', event: 'approve', label: 'Approve Plan' },
    { from: 'implement', to: 'review-slice', event: 'complete', label: 'implemented' },
    { from: 'review-slice', to: 'adversarial-review', event: 'complete', label: 'PR opened' },
    { from: 'adversarial-review', to: 'verify', event: 'complete', label: 'reviewed' },
    { from: 'verify', to: 'in-review', event: 'complete', label: 'GO' },
    { from: 'verify', to: 'implement-feedback', event: 'reject', label: 'NO_GO' },
    { from: 'in-review', to: 'implement-feedback', event: 'feedback', label: 'changes' },
    { from: 'implement-feedback', to: 'adversarial-review', event: 'complete', label: 'sliced' },
    { from: 'in-review', to: 'merge', event: 'accept', label: 'Accept & merge' },
    { from: 'merge', to: 'done', event: 'complete', label: 'merged' },
  ],
  troubleshootStep: DEFAULT_TROUBLESHOOT_STEP,
};

export const PLANNING_ONLY_WORKFLOW: Workflow = {
  id: 'wf-planning-only',
  name: 'Planning Only',
  description: 'Planning agent → human approval. For spikes, design docs or work handed to humans.',
  entryStepId: 'todo',
  steps: [
    { id: 'todo', type: 'human', label: 'Todo', state: 'todo', position: { x: 40, y: 150 } },
    {
      id: 'planning', type: 'agent', label: 'Planning Agent', state: 'planning',
      engine: 'claude', model: 'claude-opus-5', mode: 'high', output: 'plan',
      prompt: PLANNING_PROMPT, tools: [...READ_TOOLS, 'web_search'], permissions: ['read'], position: { x: 200, y: 150 },
    },
    { id: 'plan-review', type: 'human', label: 'Plan Approval', state: 'plan-review', position: { x: 360, y: 150 } },
    {
      id: 'planning-feedback', type: 'agent', label: 'Revise Plan', state: 'planning-feedback',
      engine: 'claude', model: 'claude-opus-5', mode: 'high', output: 'plan',
      prompt: PLANNING_PROMPT, tools: [...READ_TOOLS, 'web_search'], permissions: ['read'], position: { x: 200, y: 260 },
    },
    { id: 'done', type: 'end', label: 'Done', state: 'done', position: { x: 520, y: 150 } },
  ],
  edges: [
    { from: 'todo', to: 'planning', event: 'start', label: 'Start Planning' },
    { from: 'planning', to: 'plan-review', event: 'complete', label: 'plan ready' },
    { from: 'plan-review', to: 'planning-feedback', event: 'feedback', label: 'revise' },
    { from: 'planning-feedback', to: 'plan-review', event: 'complete', label: 'plan revised' },
    { from: 'plan-review', to: 'done', event: 'approve', label: 'Approve Plan' },
  ],
  troubleshootStep: DEFAULT_TROUBLESHOOT_STEP,
};

export const FAST_TRACK_WORKFLOW: Workflow = {
  id: 'wf-fast-track',
  name: 'Fast Track',
  description: 'Implementation agent immediately, adversarial review, verify, then human review. For small, well-understood changes.',
  entryStepId: 'todo',
  steps: [
    { id: 'todo', type: 'human', label: 'Todo', state: 'todo', position: { x: 40, y: 150 } },
    {
      id: 'implement', type: 'agent', label: 'Implement Agent', state: 'implement',
      engine: 'claude', model: 'claude-sonnet-5', mode: 'high', output: 'implementation',
      prompt: IMPLEMENT_PROMPT.replace('Approved plan:\n{{plan}}', 'There is no separate plan; plan briefly, then implement.'),
      tools: [...WRITE_TOOLS], permissions: ['read', 'write', 'execute'], position: { x: 200, y: 150 },
    },
    {
      id: 'review-slice', type: 'agent', label: 'Review Slicer', state: 'review-slice',
      engine: 'claude', model: 'claude-opus-5', mode: 'high', output: 'review-slice',
      prompt: REVIEW_SLICE_PROMPT, tools: [...WRITE_TOOLS, 'create_pr'], permissions: ['read', 'write', 'execute'], position: { x: 360, y: 150 },
    },
    {
      id: 'adversarial-review', type: 'agent', label: 'Adversarial Review', state: 'adversarial-review',
      engine: 'claude', model: 'claude-opus-5', mode: 'high', output: 'review',
      prompt: REVIEW_PROMPT, tools: [...READ_TOOLS, 'run_command'], permissions: ['read', 'execute'], position: { x: 520, y: 150 },
    },
    {
      id: 'verify', type: 'agent', label: 'Verify & Readiness', state: 'verify',
      engine: 'claude', model: 'claude-opus-5', mode: 'high', output: 'verdict',
      prompt: VERIFY_PROMPT, tools: [...READ_TOOLS, 'run_command'], permissions: ['read', 'execute'], position: { x: 680, y: 150 },
    },
    { id: 'in-review', type: 'human', label: 'Review', state: 'in-review', position: { x: 840, y: 150 } },
    { id: 'merge', type: 'agent', label: 'Merge Pull Requests', state: 'merge', output: 'merge', position: { x: 1000, y: 60 } },
    {
      id: 'implement-feedback', type: 'agent', label: 'Address Feedback', state: 'implement-feedback',
      engine: 'claude', model: 'claude-sonnet-5', mode: 'high', output: 'review-slice',
      prompt: `${IMPLEMENT_PROMPT}\n\nAfter addressing feedback, also rewrite the branch into ordered reviewable commits and return the review-slice result for the final commit order.`,
      tools: [...WRITE_TOOLS, 'create_pr'], permissions: ['read', 'write', 'execute'], position: { x: 680, y: 260 },
    },
    { id: 'done', type: 'end', label: 'Done', state: 'done', position: { x: 1160, y: 150 } },
  ],
  edges: [
    { from: 'todo', to: 'implement', event: 'start', label: 'Start' },
    { from: 'implement', to: 'review-slice', event: 'complete', label: 'implemented' },
    { from: 'review-slice', to: 'adversarial-review', event: 'complete', label: 'PR opened' },
    { from: 'adversarial-review', to: 'verify', event: 'complete', label: 'reviewed' },
    { from: 'verify', to: 'in-review', event: 'complete', label: 'GO' },
    { from: 'verify', to: 'implement-feedback', event: 'reject', label: 'NO_GO' },
    { from: 'in-review', to: 'implement-feedback', event: 'feedback', label: 'changes' },
    { from: 'implement-feedback', to: 'adversarial-review', event: 'complete', label: 'sliced' },
    { from: 'in-review', to: 'merge', event: 'accept', label: 'Accept & merge' },
    { from: 'merge', to: 'done', event: 'complete', label: 'merged' },
  ],
  troubleshootStep: DEFAULT_TROUBLESHOOT_STEP,
};

export const DOCUMENT_WORKFLOW: Workflow = {
  id: 'wf-document',
  name: 'Document (non-code)',
  description: 'Writing agent → human review. Outputs are uploaded as artifacts instead of a PR.',
  entryStepId: 'todo',
  steps: [
    { id: 'todo', type: 'human', label: 'Todo', state: 'todo', position: { x: 40, y: 150 } },
    {
      id: 'write', type: 'agent', label: 'Writing Agent', state: 'implement',
      engine: 'claude', model: 'claude-opus-5', mode: 'high', output: 'document',
      prompt: DOCUMENT_PROMPT, tools: ['read_file', 'write_file', 'web_search', 'list_directory'], permissions: ['read', 'write'], position: { x: 200, y: 150 },
    },
    { id: 'in-review', type: 'human', label: 'Review', state: 'in-review', position: { x: 360, y: 150 } },
    {
      id: 'revise', type: 'agent', label: 'Revise', state: 'implement-feedback',
      engine: 'claude', model: 'claude-opus-5', mode: 'high', output: 'document',
      prompt: DOCUMENT_PROMPT, tools: ['read_file', 'write_file', 'web_search', 'list_directory'], permissions: ['read', 'write'], position: { x: 200, y: 260 },
    },
    { id: 'done', type: 'end', label: 'Done', state: 'done', position: { x: 520, y: 150 } },
  ],
  edges: [
    { from: 'todo', to: 'write', event: 'start', label: 'Start' },
    { from: 'write', to: 'in-review', event: 'complete', label: 'ready' },
    { from: 'in-review', to: 'revise', event: 'feedback', label: 'changes' },
    { from: 'revise', to: 'in-review', event: 'complete', label: 'revised' },
    { from: 'in-review', to: 'done', event: 'accept', label: 'Accept' },
  ],
  troubleshootStep: DEFAULT_TROUBLESHOOT_STEP,
};

export const BUNDLED_WORKFLOWS: Workflow[] = [FULL_SDLC_WORKFLOW, PLANNING_ONLY_WORKFLOW, FAST_TRACK_WORKFLOW, DOCUMENT_WORKFLOW];

/** Models offered in the workflow editor. Keep in sync with the worker's engine adapters. */
export const MODEL_OPTIONS: Record<'claude' | 'codex', string[]> = {
  claude: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5-1'],
  codex: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol'],
};

export const ALL_TOOLS = ['read_file', 'write_file', 'run_command', 'search_codebase', 'list_directory', 'create_pr', 'web_search'] as const;
export const ALL_PERMISSIONS = ['read', 'write', 'execute'] as const;
export const ALL_OUTPUT_KINDS = ['plan', 'implementation', 'pr', 'review-slice', 'review', 'verdict', 'document', 'troubleshoot', 'conflict-resolution', 'merge'] as const;
