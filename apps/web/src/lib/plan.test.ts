import { describe, expect, it } from 'vitest';
import { planOverview } from './plan';

describe('planOverview', () => {
  it('extracts the plan summary sections while preserving markdown', () => {
    expect(
      planOverview(`# Plan

## What behavior is changing
Add a dedicated plan summary view.

## What files/systems are affected
- apps/web/src/pages/taskDetail/PlanTab.tsx
- apps/web/src/lib/plan.ts

## Important invariants
- Existing workflows still use markdown plans.
- Tables remain readable:

| Assumption | Risk |
| --- | --- |
| Existing API | Low |

## Edge cases
- Legacy plans may not have the new headings.

## How correctness will be verified
1. Summary shows the condensed plan.
2. The implementation plan view shows the full plan.

## Implementation steps
This must not leak into verification.`),
    ).toEqual({
      behaviorChange: 'Add a dedicated plan summary view.',
      affectedSystems: '- apps/web/src/pages/taskDetail/PlanTab.tsx\n- apps/web/src/lib/plan.ts',
      invariants: '- Existing workflows still use markdown plans.\n- Tables remain readable:\n\n| Assumption | Risk |\n| --- | --- |\n| Existing API | Low |',
      edgeCases: '- Legacy plans may not have the new headings.',
      verification: '1. Summary shows the condensed plan.\n2. The implementation plan view shows the full plan.',
    });
  });

  it('does not truncate long overview sections', () => {
    const summary = 'Complete sentence. '.repeat(30).trim();
    expect(planOverview(`## What behavior is changing\n${summary}`).behaviorChange).toBe(summary);
  });

  it('keeps legacy plans useful and marks missing structured fields', () => {
    expect(planOverview('# Plan\n\nShip the smallest change.')).toEqual({
      behaviorChange: 'Ship the smallest change.',
      affectedSystems: 'Not specified in this plan.',
      invariants: 'Not specified in this plan.',
      edgeCases: 'Not specified in this plan.',
      verification: 'Not specified in this plan.',
    });
  });

  it('maps legacy plan headings into the new summary model', () => {
    expect(
      planOverview(`## Summary
Step one.

## Assumptions
- API remains stable.

## Acceptance criteria
- Tests pass.`),
    ).toMatchObject({
      behaviorChange: 'Step one.',
      invariants: '- API remains stable.',
      verification: '- Tests pass.',
    });
  });
});
