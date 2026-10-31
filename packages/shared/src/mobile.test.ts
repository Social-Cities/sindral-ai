import { describe, expect, it } from 'vitest';
import { createMobileWorkflow, MOBILE_APP_WORKFLOW } from './defaultWorkflows.js';
import { mobileBddGate, selectMobilePlatforms } from './mobile.js';
import { happyPath, snapshotWorkflow, validateWorkflow } from './workflow.js';
import { agentResultSchema, createProjectSchema, workflowSchema } from './schemas.js';
import type { AppPlatform, BddPlanResult, VerdictResult } from './types.js';

const bdd: BddPlanResult = { kind: 'bdd-plan', summary: 'Sign in', plan: '# BDD', scenarios: [{ id: 'login', given: 'Signed out', when: 'Valid credentials submitted', then: 'Session created' }] };
const go: VerdictResult = { kind: 'verdict', summary: 'Ready', report: 'Test output', verdict: 'GO' };

describe('mobile workflow', () => {
  for (let mask = 1; mask < 8; mask++) {
    const platforms = (['ios', 'android', 'web'] as AppPlatform[]).filter((_, index) => mask & (1 << index));
    it(`runs only ${platforms.join(', ')} in order with isolated sessions`, () => {
      const workflow = selectMobilePlatforms(snapshotWorkflow(MOBILE_APP_WORKFLOW), [...platforms].reverse());
      expect(validateWorkflow(workflow)).toEqual([]);
      expect(workflowSchema.safeParse(workflow).success).toBe(true);
      expect(happyPath(workflow).map((step) => step.id)).toEqual(['todo', 'bdd', 'planning', 'plan-review', ...platforms.map((platform) => `implement-${platform}`), 'review-slice', 'adversarial-review', 'verify', 'in-review', 'merge', 'done']);
      const sessions = platforms.map((platform) => workflow.steps.find((step) => step.id === `implement-${platform}`)!.resumeSessionKey);
      expect(new Set(sessions).size).toBe(platforms.length);
      expect(workflow.edges.find((edge) => edge.from === 'verify' && edge.event === 'reject')!.to).toBe(`implement-feedback-${platforms[0]}`);
      expect(workflow.steps.filter((step) => step.platform).every((step) => platforms.includes(step.platform!))).toBe(true);
    });
  }
  it('defaults to native clients and reconciles the implementation plan after BDD feedback', () => {
    const workflow = createMobileWorkflow();
    expect(workflow.mobilePlatforms).toEqual(['ios', 'android']);
    expect(workflow.edges).toContainEqual({ from: 'bdd-feedback', to: 'planning-feedback', event: 'complete' });
  });
  it('requires passing evidence for every scenario on every platform', () => {
    expect(mobileBddGate(bdd, ['ios', 'android'], go)).toMatch(/ios/);
    const ios = { scenarioId: 'login', platform: 'ios' as const, status: 'passed' as const, command: 'xcodebuild test', evidence: '1 passed' };
    expect(mobileBddGate(bdd, ['ios', 'android'], { ...go, bddChecks: [ios] })).toMatch(/android/);
    const android = { ...ios, platform: 'android' as const, command: './gradlew test' };
    expect(mobileBddGate(bdd, ['ios', 'android'], { ...go, bddChecks: [ios, android] })).toBeNull();
    for (const status of ['failed', 'blocked'] as const) expect(mobileBddGate(bdd, ['ios'], { ...go, bddChecks: [{ ...ios, status }] })).toMatch(/ios/);
    expect(mobileBddGate(bdd, ['ios'], { ...go, bddChecks: [ios, ios] })).toMatch(/ios/);
    expect(mobileBddGate(bdd, ['ios'], { ...go, bddChecks: [{ ...ios, evidence: '' }] })).toMatch(/ios/);
  });
  it('rejects duplicate scenarios and invalid project configurations', () => {
    expect(agentResultSchema.safeParse(bdd).success).toBe(true);
    expect(agentResultSchema.safeParse({ ...bdd, scenarios: [...bdd.scenarios, ...bdd.scenarios] }).success).toBe(false);
    expect(createProjectSchema.safeParse({ name: 'App', projectType: 'mobile-app', repos: ['acme/app'] }).success).toBe(true);
    for (const invalid of [{ repos: ['acme/app', 'acme/other'] }, { platforms: [] }, { platforms: ['ios', 'ios'] }]) {
      expect(createProjectSchema.safeParse({ name: 'App', projectType: 'mobile-app', repos: ['acme/app'], ...invalid }).success).toBe(false);
    }
  });
});
