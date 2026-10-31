import { describe, expect, it } from 'vitest';
import { BUNDLED_WORKFLOWS } from './defaultWorkflows.js';
import { domainDrivenDesignGate, domainDrivenDesignScopes, DOMAIN_DRIVEN_DESIGN_CONTRACT } from './domainDrivenDesign.js';
import { DDD_CRITERIA, type DomainDrivenDesignCheck, type VerdictResult } from './types.js';
import { agentResultSchema, workflowSchema } from './schemas.js';

const go: VerdictResult = { kind: 'verdict', verdict: 'GO', summary: 'Ready', report: '# Readiness' };
const checks = (scopes: string[]): DomainDrivenDesignCheck[] => scopes.flatMap((scope) => DDD_CRITERIA.map((criterion) => ({ scope, criterion, status: 'passed', evidence: `${scope}/domain has no SDK dependencies; invariant and adapter tests passed.` })));

describe('Domain Driven Design gates', () => {
  it('covers each repository or every selected mobile platform plus its shared backend', () => {
    expect(domainDrivenDesignScopes(['acme/api', 'acme/web', 'acme/api'])).toEqual(['acme/api', 'acme/web']);
    expect(domainDrivenDesignScopes(['acme/app'], ['android', 'web'])).toEqual(['android', 'web', 'supabase']);
    expect(domainDrivenDesignScopes([], ['ios'])).toEqual([]);
  });
  it('rejects missing criteria and missing platform/backend evidence', () => {
    const required = ['ios', 'android', 'supabase'];
    expect(domainDrivenDesignGate(go, required)).toContain('ios');
    expect(domainDrivenDesignGate({ ...go, dddChecks: checks(['ios', 'android']) }, required)).toContain('supabase');
    const partial = checks(required).filter((check) => check.scope !== 'android' || check.criterion !== 'invariants');
    expect(domainDrivenDesignGate({ ...go, dddChecks: partial }, required)).toContain('invariants');
    expect(domainDrivenDesignGate({ ...go, dddChecks: checks(required) }, required)).toBeNull();
    expect(domainDrivenDesignGate(go, [])).toBeNull();
  });
  it('rejects failed, blocked, duplicate and blank evidence even when the verdict is GO', () => {
    const complete = checks(['acme/app']);
    for (const invalid of [{ ...complete[0]!, status: 'failed' as const }, { ...complete[0]!, status: 'blocked' as const }, { ...complete[0]!, evidence: ' ' }]) {
      expect(domainDrivenDesignGate({ ...go, dddChecks: [invalid, ...complete.slice(1)] }, ['acme/app'])).toContain('DDD criterion');
    }
    expect(domainDrivenDesignGate({ ...go, dddChecks: [...complete, complete[0]!] }, ['acme/app'])).toContain('DDD criterion');
    expect(agentResultSchema.safeParse({ ...go, dddChecks: complete }).success).toBe(true);
    expect(agentResultSchema.safeParse({ ...go, dddChecks: [{ ...complete[0]!, criterion: 'folders-exist' }] }).success).toBe(false);
  });
  it('includes DDD in the planning, implementation and review contracts of every code template', () => {
    for (const workflow of BUNDLED_WORKFLOWS.filter((workflow) => workflow.steps.some((step) => ['plan', 'implementation', 'pr'].includes(step.output ?? '')))) {
      expect(workflowSchema.safeParse(workflow).success).toBe(true);
      for (const step of workflow.steps.filter((step) => step.type === 'agent' && step.output !== 'merge')) {
        expect(step.prompt, `${workflow.name}: ${step.id}`).toContain(DOMAIN_DRIVEN_DESIGN_CONTRACT);
      }
    }
  });
});
