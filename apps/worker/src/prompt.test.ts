import { describe, expect, it } from 'vitest';
import { buildPrompt, workspaceNote } from './prompt.js';
import { context, step } from './test/fixtures.js';
import type { Workspace } from './workspace.js';

const repoWs: Workspace = {
  taskKey: 'ENG-142',
  cwd: '/w/worktrees/ENG-142/widgets',
  repos: [
    {
      repo: { owner: 'acme', name: 'widgets', full: 'acme/widgets' },
      repoDir: '/w/repos/acme__widgets',
      dir: '/w/worktrees/ENG-142/widgets',
      branch: 'sindral/eng-142',
      baseBranch: 'main',
      resumed: false,
    },
    {
      repo: { owner: 'acme', name: 'api', full: 'acme/api' },
      repoDir: '/w/repos/acme__api',
      dir: '/w/worktrees/ENG-142/api',
      branch: 'sindral/eng-142',
      baseBranch: 'develop',
      resumed: true,
    },
  ],
};

describe('buildPrompt', () => {
  it('interpolates context, appends the protocol block and the workspace note', () => {
    const prompt = buildPrompt({
      step: step({ prompt: 'Work on {{task_key}}: {{task_title}} {{unknown_token}}' }),
      output: 'pr',
      context: context(),
      resultFile: '/w/results/j1.json',
      outputDir: '/w/outputs/j1',
      workspace: repoWs,
    });
    expect(prompt.startsWith('Work on ENG-142: Add rate limiting')).toBe(true);
    expect(prompt).not.toContain('{{');
    expect(prompt).toContain('## Sindral protocol (mandatory)');
    expect(prompt).toContain('/w/results/j1.json');
    expect(prompt).toContain('"kind": "pr"');
    expect(prompt).toContain('## Workspace');
    expect(prompt).toContain('`acme/widgets` is checked out at `/w/worktrees/ENG-142/widgets` (your current working directory) on branch `sindral/eng-142` (base branch `main`)');
    expect(prompt).toContain('`acme/api` is checked out at `/w/worktrees/ENG-142/api` on branch `sindral/eng-142` (base branch `develop`)');
    expect(prompt).toContain('spans several repositories');
    expect(prompt).toContain('never create, edit, rename, or delete GitHub Actions workflow files under `.github/workflows/`');
    expect(prompt).toContain('Do NOT push');
    expect(prompt).not.toContain('Inspect the repository only');
    expect(prompt).toContain('/w/outputs/j1');
    // Sections appear in order: prompt, protocol, workspace.
    expect(prompt.indexOf('Sindral protocol')).toBeLessThan(prompt.indexOf('## Workspace'));
  });

  it('tells non-write repository steps to inspect without modifying code', () => {
    const prompt = buildPrompt({
      step: step({ permissions: ['read'], output: 'plan' }),
      output: 'plan',
      context: context(),
      resultFile: '/w/results/j1.json',
      outputDir: '/w/outputs/j1',
      workspace: repoWs,
    });
    expect(prompt).toContain('Inspect the repository only');
    expect(prompt).toContain('Do NOT modify repository files');
    expect(prompt).toContain('never create, edit, rename, or delete GitHub Actions workflow files under `.github/workflows/`');
    expect(prompt).toContain('Write only the required result JSON file');
    expect(prompt).not.toContain('Commit your work');
  });

  it('describes the tmp directory for non-code tasks', () => {
    const note = workspaceNote({ taskKey: 'DOC-1', cwd: '/w/tmp/DOC-1', repos: [] }, '/w/outputs/j2');
    expect(note).toContain('no repository');
    expect(note).toContain('/w/tmp/DOC-1');
    expect(note).toContain('/w/outputs/j2');
    expect(note).toContain('$SINDRAL_OUTPUT_DIR');
    expect(note).not.toContain('Do NOT push');
  });

  it('passes task platform scope into the verifier protocol', () => {
    const prompt = buildPrompt({ step: step({ output: 'verdict' }), output: 'verdict', context: context({ mobile_platforms: 'web' }), resultFile: '/r.json', outputDir: '/o', workspace: repoWs });
    expect(prompt).toContain('"bddChecks"');
    expect(prompt).toContain('"platform": "web"');
    expect(prompt).toContain('selected platform (web)');
  });

  it('tolerates a step without a prompt', () => {
    const prompt = buildPrompt({ step: step({ prompt: undefined }), output: 'plan', context: context(), resultFile: '/r.json', outputDir: '/o', workspace: repoWs });
    expect(prompt.trim().startsWith('---')).toBe(true);
    expect(prompt).toContain('"kind": "plan"');
  });
});
