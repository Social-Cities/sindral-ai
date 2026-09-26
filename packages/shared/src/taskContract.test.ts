import { describe, expect, it } from 'vitest';
import { extractTaskContract } from './taskContract.js';

describe('extractTaskContract', () => {
  it('extracts outcome and acceptance criteria without consuming later sections', () => {
    expect(
      extractTaskContract(`# Task

## Desired outcome
Users can recover a failed deployment.

## Acceptance Criteria
- A retry succeeds.
- The failure remains auditable.

## Implementation notes
Keep the existing API.`),
    ).toEqual({
      outcome: 'Users can recover a failed deployment.',
      acceptanceCriteria: '- A retry succeeds.\n- The failure remains auditable.',
    });
  });

  it('returns null for contract fields that are not present', () => {
    expect(extractTaskContract('A task description without structured headings.')).toEqual({ outcome: null, acceptanceCriteria: null });
  });

  it('supports emphasized headings commonly used in ticket bodies', () => {
    expect(extractTaskContract('**Outcome**\nA stable release.\n\n**Acceptance criteria:**\n- Deploy succeeds.\n\n**Notes**\nNo downtime.')).toEqual({
      outcome: 'A stable release.',
      acceptanceCriteria: '- Deploy succeeds.',
    });
  });
});
