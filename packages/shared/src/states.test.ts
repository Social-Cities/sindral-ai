import { describe, expect, it } from 'vitest';
import { dashboardBucket, getStateStyle } from './states.js';

describe('getStateStyle', () => {
  it('returns known styles and a fallback for custom states', () => {
    expect(getStateStyle('planning').pulsing).toBe(true);
    expect(getStateStyle('security-scan', { type: 'agent', label: 'Security Scan' })).toMatchObject({ label: 'Security Scan', pulsing: true });
    expect(getStateStyle('legal-signoff', null)).toMatchObject({ label: 'Legal Signoff', pulsing: false });
  });
});

describe('dashboardBucket', () => {
  it('groups states for the stat cards', () => {
    expect(dashboardBucket('todo')).toBe('todo');
    expect(dashboardBucket('planning')).toBe('in-progress');
    expect(dashboardBucket('plan-review', { type: 'human' })).toBe('in-progress');
    expect(dashboardBucket('in-review')).toBe('in-review');
    expect(dashboardBucket('custom-gate', { type: 'human' })).toBe('in-review');
    expect(dashboardBucket('done')).toBe('done');
    expect(dashboardBucket('wont-do')).toBe('done');
    expect(dashboardBucket('failure')).toBe('failed');
  });
});
