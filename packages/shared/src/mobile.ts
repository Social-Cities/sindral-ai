import type { AppPlatform, BddPlanResult, VerdictResult, Workflow, WorkflowStep } from './types.js';
import { APP_PLATFORMS } from './types.js';
import { DOMAIN_DRIVEN_DESIGN_CONTRACT } from './domainDrivenDesign.js';

export const BDD_PLAN_ARTIFACT = 'bdd-plan.json';
export const BDD_PLAN_MARKDOWN = 'bdd-plan.md';
export const DEFAULT_MOBILE_PLATFORMS: AppPlatform[] = ['ios', 'android'];

export const MOBILE_CONTRACT = `## Mobile engineering contract
Selected platforms, in implementation order: {{mobile_platforms}}
Use one monorepo with top-level ios/, android/, web/ folders; create the selected platform apps and keep unselected apps out of scope. Keep shared backend migrations and configuration in supabase/ for one standard Supabase project used by all clients. Never place service-role credentials in clients.
iOS must use SwiftUI. Android must use Kotlin and Jetpack Compose with layered architecture, repositories, ViewModels, unidirectional data flow, coroutines and Flow; consult https://developer.android.com/topic/architecture/recommendations for current guidance. Web must use React.
Implement selected platforms in order: iOS, then Android, then Web. Use the completed iOS implementation as the behavioral and API reference for Android, preserving idiomatic platform UX. If iOS is unselected, start with the first selected platform. Keep behavior and Supabase contracts consistent across clients.

BDD plan (mandatory behavior contract; do not silently weaken scenarios):
{{bdd_plan}}

Prior platform handoff summaries (reference the committed source as well):
{{platform_implementations}}`;

const BDD_PROMPT = `${DOMAIN_DRIVEN_DESIGN_CONTRACT}

Create or revise the Behavior Driven Design plan for {{task_key}}: {{task_title}}.
Investigate the existing code before designing tests. Define stable scenario IDs with explicit Given/When/Then, including happy paths, errors, authorization, loading, offline and edge cases relevant to the feature. Every scenario applies to every selected platform. Generate complete Gherkin .feature file contents and concrete native test cases/step definitions in the BDD plan, with executable test files, fixtures, commands, and expected assertions for each selected platform (XCTest/Swift Testing and UI tests for iOS, Kotlin/Compose tests for Android, React tests for Web) and Supabase integration tests where relevant. The implementation planner and implementers must follow these tests. This step generates reviewable test source in the plan without modifying repository files; implementation agents materialize those generated tests in each platform's test suite. Return both the full readable BDD plan and structured scenarios. Preserve scenario IDs when revising existing behavior.

Task description:
{{task_description}}
Outcome:
{{task_outcome}}
Acceptance criteria:
{{acceptance_criteria}}
Current implementation plan:
{{plan}}
Feedback:
{{feedback}}

${MOBILE_CONTRACT}`;

/** A Full SDLC variant with independently reviewable BDD and isolated platform agents. */
export function buildMobileWorkflow(base: Workflow, platforms: AppPlatform[] = DEFAULT_MOBILE_PLATFORMS): Workflow {
  const selected = APP_PLATFORMS.filter((platform) => platforms.includes(platform));
  if (!selected.length) throw new Error('Select at least one mobile app platform');
  const workflow: Workflow = JSON.parse(JSON.stringify(base)) as Workflow;
  workflow.id = 'wf-mobile-app';
  workflow.name = 'Mobile App SDLC';
  workflow.description = 'BDD tests → implementation plan → review both plans → iOS → Android → Web → review → verify BDD → ready for release.';
  workflow.mobilePlatforms = [...selected];
  const implementation = workflow.steps.find((step) => step.id === 'implement')!;
  const platformSteps = (revision: boolean): WorkflowStep[] => selected.map((platform, index) => ({
    ...implementation,
    id: `${revision ? 'implement-feedback' : 'implement'}-${platform}`,
    state: `${revision ? 'implement-feedback' : 'implement'}-${platform}`,
    label: `${revision ? 'Revise' : 'Implement'} ${platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : 'Web'}`,
    platform,
    resumeSessionKey: `implementation-${platform}`,
    prompt: `${implementation.prompt}\n\n${MOBILE_CONTRACT}\n\nYou own ${platform}/ and its tests in this agent session. Take BOTH approved plans as input. Implement every BDD scenario as executable tests for ${platform} and run them. You may update the shared Supabase backend as required by the approved plan. Read earlier platform implementations for reference; preserve their behavior. Summarize changed files, API contracts, scenario coverage, test commands and outcomes for the next platform agent.`,
    position: { x: 700 + index * 180, y: revision ? 360 : 60 },
  }));
  workflow.steps = workflow.steps.filter((step) => !['implement', 'implement-feedback'].includes(step.id)).map((step) => ({
    ...step,
    ...(step.prompt ? { prompt: `${step.prompt}\n\n${MOBILE_CONTRACT}` } : {}),
    ...(step.id === 'verify' ? { prompt: `${step.prompt}\n\n${MOBILE_CONTRACT}\n\nRun ALL approved BDD scenarios on EVERY selected platform against the final branch. Return bddChecks with one entry per scenarioId/platform containing the exact command, status (passed/failed/blocked), and observed evidence. GO requires every scenario/platform check to pass. Missing tests, skipped tests, unavailable simulators/emulators, or missing credentials are NO_GO. Never claim readiness without executing the tests.` } : {}),
    ...(step.id === 'in-review' ? { label: 'Ready for Release' } : {}),
  }));
  workflow.steps.push(
    { id: 'bdd', type: 'agent', label: 'Behavior Driven Design', state: 'bdd', engine: 'claude', model: 'claude-opus-5', mode: 'high', output: 'bdd-plan', prompt: BDD_PROMPT, tools: ['read_file', 'search_codebase', 'list_directory'], permissions: ['read'], resumeSessionKey: 'bdd', position: { x: 180, y: -100 } },
    { id: 'bdd-feedback', type: 'agent', label: 'Revise BDD Plan', state: 'bdd-feedback', engine: 'claude', model: 'claude-opus-5', mode: 'high', output: 'bdd-plan', prompt: BDD_PROMPT, tools: ['read_file', 'search_codebase', 'list_directory'], permissions: ['read'], resumeSessionKey: 'bdd', position: { x: 360, y: 360 } },
    ...platformSteps(false), ...platformSteps(true),
  );
  workflow.edges = workflow.edges.filter((edge) => !['implement', 'implement-feedback'].includes(edge.from)).map((edge) => ({
    ...edge,
    ...(edge.from === 'todo' ? { to: 'bdd' } : {}),
    ...(edge.to === 'implement' ? { to: `implement-${selected[0]}`, label: 'Approve Both Plans' } : {}),
    ...(edge.to === 'implement-feedback' ? { to: `implement-feedback-${selected[0]}` } : {}),
  }));
  workflow.edges.push(
    { from: 'bdd', to: 'planning', event: 'complete' },
    { from: 'plan-review', to: 'bdd-feedback', event: 'bdd-feedback', label: 'Revise BDD Plan' },
    { from: 'bdd-feedback', to: 'planning-feedback', event: 'complete' },
  );
  for (const revision of [false, true]) {
    const steps = platformSteps(revision);
    steps.forEach((step, index) => workflow.edges.push({ from: step.id, to: steps[index + 1]?.id ?? 'review-slice', event: 'complete' }));
  }
  const mainPath = ['todo', 'bdd', 'planning', 'plan-review', ...selected.map((platform) => `implement-${platform}`), 'review-slice', 'adversarial-review', 'verify', 'in-review', 'merge', 'done'];
  workflow.steps = workflow.steps.map((step) => {
    const index = mainPath.indexOf(step.id);
    return { ...step, position: { x: index >= 0 ? 40 + index * 180 : step.platform ? 760 + selected.indexOf(step.platform) * 180 : step.id === 'bdd-feedback' ? 220 : 400, y: index >= 0 ? 100 : 380 } };
  });
  return workflow;
}

/** Filter a saved mobile workflow without discarding user-edited prompts/configuration. */
export function selectMobilePlatforms(workflow: Workflow, platforms: AppPlatform[]): Workflow {
  if (!workflow.mobilePlatforms) return workflow;
  const selected = APP_PLATFORMS.filter((platform) => platforms.includes(platform));
  if (!selected.length) throw new Error('Select at least one mobile app platform');
  const removed = new Set(workflow.steps.filter((step) => step.platform && !selected.includes(step.platform)).map((step) => step.id));
  const redirect = (id: string): string => {
    const seen = new Set<string>();
    while (removed.has(id)) {
      if (seen.has(id)) throw new Error('Invalid mobile platform chain');
      seen.add(id);
      const next = workflow.edges.find((edge) => edge.from === id && edge.event === 'complete');
      if (!next) throw new Error('Missing mobile platform handoff');
      id = next.to;
    }
    return id;
  };
  return { ...workflow, mobilePlatforms: selected, steps: workflow.steps.filter((step) => !removed.has(step.id)), edges: workflow.edges.filter((edge) => !removed.has(edge.from)).map((edge) => ({ ...edge, to: redirect(edge.to) })) };
}

/** A GO cannot cross the release gate without complete, successful BDD evidence. */
export function mobileBddGate(plan: BddPlanResult, platforms: AppPlatform[], result: VerdictResult): string | null {
  for (const scenario of plan.scenarios) {
    for (const platform of platforms) {
      const checks = result.bddChecks?.filter((check) => check.scenarioId === scenario.id && check.platform === platform) ?? [];
      if (checks.length !== 1 || checks[0]!.status !== 'passed' || !checks[0]!.command.trim() || !checks[0]!.evidence.trim()) {
        return `BDD scenario ${scenario.id} must pass on ${platform} with an executed command and evidence`;
      }
    }
  }
  return plan.scenarios.length ? null : 'The approved BDD plan has no scenarios';
}
