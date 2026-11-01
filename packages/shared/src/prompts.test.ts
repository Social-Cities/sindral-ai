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
  it('asks for offline preview files without requiring a hosted design', () => {
    const out = protocolInstructions('design', '/tmp/result.json');
    expect(out).toContain('"designUrl": null');
    expect(out).toContain('inline CSS/JS');
    expect(out).toContain('no hosted artifact or /design command is required');
    expect(out).toContain('clarification-only turn');
  });

  it('includes the result path and shape for the output kind', () => {
    const out = protocolInstructions('verdict', '/tmp/result.json');
    expect(out).toContain('/tmp/result.json');
    expect(out).toContain('"GO" | "NO_GO"');
  });

  it('omits the mobile BDD result shape for other workflows', () => {
    const out = protocolInstructions('verdict', '/tmp/result.json', { mobile_platforms: '' });
    expect(out).not.toContain('"bddChecks"');
    expect(out).not.toContain('"platform"');
    expect(out).toContain('Omit bddChecks');
    expect(out).toContain('"dddChecks"');
  });

  it('requests BDD evidence for the selected mobile platforms', () => {
    const out = protocolInstructions('verdict', '/tmp/result.json', { mobile_platforms: 'android, web' });
    expect(out).toContain('"bddChecks"');
    expect(out).toContain('"platform": "android"');
    expect(out).toContain('selected platform (android, web)');
    expect(out).not.toContain('"ios"');
  });

  it('warns verdict agents not to use review verdict values', () => {
    const out = protocolInstructions('verdict', '/tmp/result.json');
    expect(out).toContain('must be exactly `GO` or `NO_GO`');
    expect(out).toContain('NO_MATERIAL_FINDINGS');
  });

  it('requires planning agents to return the durable task contract', () => {
    const out = protocolInstructions('plan', '/tmp/result.json');
    expect(out).toContain('"outcome"');
    expect(out).toContain('"acceptanceCriteria"');
  });

  it('asks review-slicing agents for reviewer-friendly PR context', () => {
    const out = protocolInstructions('review-slice', '/tmp/result.json');
    expect(out).toContain('"motivation"');
    expect(out).toContain('"proposedSolution"');
    expect(out).toContain('"assumptions"');
    expect(out).toContain('"risks"');
    expect(out).toContain('"testing"');
    expect(out).toContain('reviewer-friendly summary');
    expect(out).toContain('"slices"');
  });
});
