import { describe, expect, it } from 'vitest';
import { interpolatePrompt, protocolInstructions } from './prompts.js';

describe('interpolatePrompt', () => {
  it('replaces known tokens and blanks unknown ones', () => {
    const out = interpolatePrompt('Task: {{task_description}} / Plan: {{ plan }} / {{unknown}}', { task_description: 'do x', plan: 'p' });
    expect(out).toBe('Task: do x / Plan: p / ');
  });

  it('does not interpret braces inside the values', () => {
    const out = interpolatePrompt('{{task_description}}', { task_description: '{{plan}}' });
    expect(out).toBe('{{plan}}');
  });
});

describe('protocolInstructions', () => {
  it('includes the result path and shape for the output kind', () => {
    const out = protocolInstructions('verdict', '/tmp/result.json');
    expect(out).toContain('/tmp/result.json');
    expect(out).toContain('"GO" | "NO_GO"');
  });

  it('requires planning agents to return the durable task contract', () => {
    const out = protocolInstructions('plan', '/tmp/result.json');
    expect(out).toContain('"outcome"');
    expect(out).toContain('"acceptanceCriteria"');
  });
});
