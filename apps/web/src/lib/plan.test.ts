import { describe, expect, it } from 'vitest';
import { planOverview } from './plan';

describe('planOverview', () => {
  it('extracts the four plan overview sections while preserving markdown', () => {
    expect(
      planOverview(`# Plan

## Summary
Add a dedicated plan view.

## Outcome
Users can review the plan quickly.

## Assumptions
- Existing workflows still use markdown plans.
- Tables remain readable:

| Assumption | Risk |
| --- | --- |
| Existing API | Low |

## Acceptance criteria
1. Summary shows the condensed plan.
2. Plan tab shows the full plan.

## Implementation steps
This must not leak into acceptance criteria.`),
    ).toEqual({
      summary: 'Add a dedicated plan view.',
      outcome: 'Users can review the plan quickly.',
      assumptions: '- Existing workflows still use markdown plans.\n- Tables remain readable:\n\n| Assumption | Risk |\n| --- | --- |\n| Existing API | Low |',
      acceptanceCriteria: '1. Summary shows the condensed plan.\n2. Plan tab shows the full plan.',
    });
  });

  it('does not truncate long overview sections', () => {
    const summary = 'Complete sentence. '.repeat(30).trim();
    expect(planOverview(`## Summary\n${summary}`).summary).toBe(summary);
  });

  it('keeps legacy plans useful and marks missing structured fields', () => {
    expect(planOverview('# Plan\n\nShip the smallest change.')).toEqual({
      summary: 'Ship the smallest change.',
      outcome: 'Not specified in this plan.',
      assumptions: 'Not specified in this plan.',
      acceptanceCriteria: 'Not specified in this plan.',
    });
  });
});
