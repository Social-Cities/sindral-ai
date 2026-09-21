import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ResolveRebaseConflictJobPayload } from '@sindral/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runConflictResolution } from './conflict.js';
import type { Engine } from './engines/types.js';
import { silentLogger } from './logger.js';
import { Redactor } from './redact.js';
import { context, dispatch, failed, fakeGit, ok, testConfig } from './test/fixtures.js';
import { WorkspaceManager } from './workspace.js';

describe('runConflictResolution', () => {
  let workdir: string;
  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'sindral-conflict-'));
  });
  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  const sourceSha = 'a'.repeat(40);
  const targetSha = 'b'.repeat(40);
  const taskId = '11111111-1111-4111-8111-111111111111';

  function payload(overrides: Partial<ResolveRebaseConflictJobPayload> = {}): ResolveRebaseConflictJobPayload {
    return {
      kind: 'resolve-rebase-conflict',
      repository: 'acme/widgets',
      taskId,
      taskKey: 'ENG-1',
      branch: 'sindral/eng-1',
      baseBranch: 'main',
      sourceSha,
      targetSha,
      conflictedPaths: ['src/a.ts'],
      context: context({ task_key: 'ENG-1' }),
      engine: 'claude',
      model: 'claude-opus-5',
      mode: 'high',
      policy: { allowedPaths: ['src/a.ts'], protectedPaths: ['supabase/migrations/', 'package.json'], validationCommands: [['pnpm', 'test']], maxFiles: 5, maxChangedLines: 100 },
      ...overrides,
    };
  }

  function engine(script: (resultFile: string, cwd: string) => Promise<void>): Engine {
    return {
      name: 'claude',
      probe: async () => ({ available: true, version: '1' }),
      run: async (opts) => {
        await script(opts.env['SINDRAL_RESULT_FILE']!, opts.cwd);
        return { exitCode: 0, tail: [], finalText: null, timedOut: false, cancelled: false, missing: false };
      },
    };
  }

  it('escalates protected files without invoking the agent or touching git', async () => {
    const git = fakeGit();
    const agent = engine(async () => {
      throw new Error('must not run');
    });
    const p = payload({ conflictedPaths: ['supabase/migrations/1.sql'], policy: { ...payload().policy, allowedPaths: ['supabase/migrations/1.sql'] } });
    const d = dispatch({ taskId, kind: 'resolve-rebase-conflict', payload: p });
    const result = await runConflictResolution({
      dispatch: d,
      payload: p,
      config: testConfig({ workdir }),
      workspaces: new WorkspaceManager(workdir, { git: git.factory, logger: silentLogger() }),
      engines: { claude: agent, codex: agent },
      redactor: new Redactor(),
      githubToken: null,
      signal: new AbortController().signal,
      git: git.factory,
    });
    expect(result).toMatchObject({ resolved: false, error: expect.stringContaining('Protected file') });
    expect(git.calls).toHaveLength(0);
  });

  it('rejects path traversal before touching the filesystem or git', async () => {
    const git = fakeGit();
    const agent = engine(async () => {
      throw new Error('must not run');
    });
    const p = payload({ conflictedPaths: ['../../outside.ts'], policy: { ...payload().policy, allowedPaths: ['../../outside.ts'] } });
    const result = await runConflictResolution({
      dispatch: dispatch({ taskId, kind: 'resolve-rebase-conflict', payload: p }),
      payload: p,
      config: testConfig({ workdir }),
      workspaces: new WorkspaceManager(workdir, { git: git.factory, logger: silentLogger() }),
      engines: { claude: agent, codex: agent },
      redactor: new Redactor(),
      githubToken: null,
      signal: new AbortController().signal,
      git: git.factory,
    });
    expect(result).toMatchObject({ resolved: false, error: expect.stringContaining('Unsafe conflict path') });
    expect(git.calls).toHaveLength(0);
  });

  it('resolves, validates and pushes a normal conflict with an exact force lease', async () => {
    const resolutionSha = 'c'.repeat(40);
    let continued = false;
    const git = fakeGit((args, cwd) => {
      if (args[0] === 'rev-parse' && args[1] === 'origin/sindral/eng-1') return ok(sourceSha);
      if (args[0] === 'rev-parse' && args[1] === targetSha) return ok(targetSha);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok(resolutionSha);
      if (cwd.includes('conflict__ENG-1') && args.includes('rebase') && args.includes(targetSha)) return failed('CONFLICT', 1);
      if (args[0] === 'diff' && args.includes('--diff-filter=U')) return ok('src/a.ts\0');
      if (args[0] === 'status') return ok(continued ? '' : 'UU src/a.ts\0');
      if (args[0] === 'diff' && args.includes('--cached')) return ok('4\t2\tsrc/a.ts');
      if (args[0] === 'rebase' && args[1] === '--continue') {
        continued = true;
        return ok();
      }
      return undefined;
    });
    const agent = engine(async (resultFile, cwd) => {
      await fs.mkdir(path.join(cwd, 'src'), { recursive: true });
      await fs.writeFile(path.join(cwd, 'src/a.ts'), 'export const value = 3;\n');
      await fs.writeFile(
        resultFile,
        JSON.stringify({
          kind: 'conflict-resolution',
          summary: 'Preserved both changes',
          taskId,
          branch: 'sindral/eng-1',
          resolved: true,
          rationale: 'Combined the validation and new value.',
          resolvedPaths: ['src/a.ts'],
          checks: [],
        }),
      );
    });
    const command = vi.fn(async () => ok('all tests passed'));
    const p = payload();
    const d = dispatch({ taskId, kind: 'resolve-rebase-conflict', payload: p });
    const result = await runConflictResolution({
      dispatch: d,
      payload: p,
      config: testConfig({ workdir }),
      workspaces: new WorkspaceManager(workdir, { git: git.factory, logger: silentLogger() }),
      engines: { claude: agent, codex: agent },
      redactor: new Redactor(),
      githubToken: null,
      signal: new AbortController().signal,
      git: git.factory,
      command,
    });
    expect(result).toMatchObject({ resolved: true, resolutionCommit: resolutionSha, resolvedPaths: ['src/a.ts'] });
    expect(command).toHaveBeenCalledWith('pnpm', ['test'], expect.objectContaining({ cwd: expect.stringContaining('conflict__ENG-1') }));
    expect(git.find('push', `--force-with-lease=sindral/eng-1:${sourceSha}`, 'origin', 'HEAD:sindral/eng-1')).toHaveLength(1);
  });
});
