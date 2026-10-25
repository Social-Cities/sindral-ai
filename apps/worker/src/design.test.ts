import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_DESIGN_FILE_BYTES, type DesignCheckpoint, type DesignHandoff, type PortableSessionEntry, type PortableSessionKey } from '@sindral/shared';
import { collectDesignFiles, restoreDesignFiles } from './designFiles.js';
import { WorkerSessionStore } from './sessionStore.js';
import { runJob, type JobDeps } from './job.js';
import type { Engine } from './engines/types.js';
import { agentPayload, dispatch, step, testConfig } from './test/fixtures.js';
import { silentLogger } from './logger.js';
import type { WorkspaceManager } from './workspace.js';

const directories: string[] = [];
async function directory() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sindral-design-')); directories.push(dir); return dir; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe('design file recovery', () => {
  it('round-trips nested source and binary assets without flattening their paths', async () => {
    const a = await directory(); const b = await directory();
    await fs.mkdir(path.join(a, 'assets'));
    await fs.writeFile(path.join(a, 'assets', 'logo.png'), Buffer.from([137, 80, 78, 71, 0, 1, 2]));
    await fs.writeFile(path.join(a, 'index.html'), '<h1>Design</h1>');
    const files = await collectDesignFiles(a);
    await restoreDesignFiles(b, files);
    expect(await collectDesignFiles(b)).toEqual(files);
    expect(files.map((file) => file.path)).toEqual(['assets/logo.png', 'index.html']);
  });

  it('rejects corruption, traversal, and symlink exports', async () => {
    const a = await directory(); const b = await directory();
    await fs.writeFile(path.join(a, 'index.html'), '<h1>Design</h1>');
    const files = await collectDesignFiles(a);
    await expect(restoreDesignFiles(b, [{ ...files[0]!, path: '../escape.html' }])).rejects.toThrow();
    await expect(restoreDesignFiles(b, [{ ...files[0]!, content: 'corrupt' }])).rejects.toThrow('checksum');
    await fs.symlink(path.join(b, 'outside.html'), path.join(a, 'linked.html'));
    await expect(collectDesignFiles(a)).rejects.toThrow('symlink');
  });

  it('reads the original open file when its path is replaced after the size check', async () => {
    const root = await directory(); const outside = await directory();
    const file = path.join(root, 'index.html');
    const secret = path.join(outside, 'secret.html');
    await fs.writeFile(file, '<h1>Original</h1>');
    await fs.writeFile(secret, 'Must not be exported');
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
        const checked = await stat();
        await fs.rename(file, path.join(outside, 'original.html'));
        await fs.symlink(secret, file);
        return checked;
      });
      return handle;
    });
    expect((await collectDesignFiles(root))[0]?.content).toBe('<h1>Original</h1>');
  });

  it.skipIf(process.platform === 'win32')('rejects a symlink substituted between listing and opening the file', async () => {
    const root = await directory(); const outside = await directory();
    const file = path.join(root, 'index.html'); const secret = path.join(outside, 'secret.html');
    await fs.writeFile(file, 'Original'); await fs.writeFile(secret, 'Must not be exported');
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      await fs.unlink(file); await fs.symlink(secret, file);
      return open(...args);
    });
    await expect(collectDesignFiles(root)).rejects.toMatchObject({ code: 'ELOOP' });
  });

  it('bounds reads and closes the handle when a file grows after the size check', async () => {
    const root = await directory(); const file = path.join(root, 'index.html');
    await fs.writeFile(file, 'Original');
    const open = fs.open.bind(fs);
    let closed = vi.fn();
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      const stat = handle.stat.bind(handle);
      closed = vi.spyOn(handle, 'close');
      vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
        const checked = await stat();
        await fs.appendFile(file, Buffer.alloc(MAX_DESIGN_FILE_BYTES + 1));
        return checked;
      });
      return handle;
    });
    await expect(collectDesignFiles(root)).rejects.toThrow('exceeds 1 MB');
    expect(closed).toHaveBeenCalledOnce();
  });
});

describe('portable design jobs', () => {
  it('continues on a new machine using the saved transcript and exported files', async () => {
    let checkpoint: DesignCheckpoint | null = null;
    const transcripts = new Map<string, PortableSessionEntry[]>();
    const sessionId = randomUUID();
    const taskId = randomUUID();
    const projectKey = `sindral-task-${taskId}`;
    const sessionApi = {
      readDesignSession: vi.fn(async () => ({ checkpoint })),
      loadSession: vi.fn(async (_jobId: string, body: { key: PortableSessionKey; after: number }) => ({ entries: transcripts.get(body.key.sessionId) ?? [], nextAfter: null, subkeys: [] })),
      appendSession: vi.fn(async (_jobId: string, body: { key: PortableSessionKey; entries: PortableSessionEntry[] }) => { transcripts.set(body.key.sessionId, [...(transcripts.get(body.key.sessionId) ?? []), ...body.entries]); return {}; }),
      checkpointDesignSession: vi.fn(async (_jobId: string, body: Omit<DesignCheckpoint, 'updatedAt'>) => { checkpoint = { ...body, updatedAt: new Date().toISOString() }; return {}; }),
    };
    const api = { postEvent: vi.fn(async () => ({ ok: true as const })), complete: vi.fn(async () => ({ ok: true as const })), fail: vi.fn(async () => ({ ok: true as const })), cancel: vi.fn(async () => ({ ok: true as const })) };
    for (let turn = 0; turn < 2; turn++) {
      const workdir = await directory();
      const engine: Engine = {
        name: 'claude', probe: async () => ({ available: false, version: null }),
        run: async (opts) => {
          expect(opts.portableSession?.projectKey).toBe(projectKey);
          expect(opts.prompt).toMatch(/^\/design /);
          if (turn === 0) {
            expect(opts.resumeSessionId).toBeUndefined();
            await fs.writeFile(path.join(opts.cwd, 'index.html'), '<h1>Original</h1>');
            await opts.portableSession!.store.append({ projectKey, sessionId }, [{ type: 'assistant', uuid: randomUUID(), message: { content: 'Original design decisions' } }]);
          } else {
            expect(opts.resumeSessionId).toBe(sessionId);
            expect(await fs.readFile(path.join(opts.cwd, 'index.html'), 'utf8')).toBe('<h1>Original</h1>');
            expect((await opts.portableSession!.store.load({ projectKey, sessionId }))?.[0]).toMatchObject({ message: { content: 'Original design decisions' } });
            await fs.writeFile(path.join(opts.cwd, 'index.html'), '<h1>Revised</h1>');
          }
          await opts.portableSession!.onCheckpoint(sessionId);
          await fs.writeFile(opts.env['SINDRAL_RESULT_FILE']!, JSON.stringify({ kind: 'design', summary: 'Design ready', designUrl: 'https://claude.ai/code/artifact/persistent-design', specification: 'Build this design.', screens: [{ name: 'Home', path: 'index.html' }], questions: [], files: [] }));
          return { exitCode: 0, tail: [], finalText: null, sessionId, timedOut: false, cancelled: false, missing: false };
        },
      };
      const workspaces = { prepare: async () => ({ taskKey: 'SIN-1', cwd: workdir, repos: [] }) } as unknown as WorkspaceManager;
      const deps: JobDeps = { config: testConfig({ workdir }), api, sessionApi, engines: { claude: engine, codex: engine }, workspaces, logger: silentLogger() };
      const job = dispatch({ taskId, payload: agentPayload({ repos: [], step: step({ output: 'design', resumeSessionKey: 'design' }) }) }, null);
      const outcome = await runJob(job, deps, new AbortController().signal);
      expect(outcome.status).toBe('completed');
      expect(api.fail).not.toHaveBeenCalled();
    }
    expect(checkpoint!.files[0]!.content).toBe('<h1>Revised</h1>');
  });

  it('fails closed when a transcript batch cannot be saved', async () => {
    const fail = vi.fn();
    const store = new WorkerSessionStore({ appendSession: vi.fn().mockRejectedValue(new Error('storage unavailable')), loadSession: vi.fn() }, randomUUID(), { attempt: 1, leaseToken: randomUUID() }, fail);
    await expect(store.append({ projectKey: 'project', sessionId: randomUUID() }, [{ type: 'assistant', uuid: randomUUID() }])).rejects.toThrow('storage unavailable');
    await expect(store.flush()).rejects.toThrow('storage unavailable');
    expect(fail).toHaveBeenCalledOnce();
  });

  it.each(['claude', 'codex'] as const)('hydrates an approved handoff before a %s implementation planning turn', async (engineName) => {
    const workdir = await directory();
    const source = await directory();
    await fs.writeFile(path.join(source, 'index.html'), '<h1>Approved design</h1>');
    const handoff: DesignHandoff = { sourceTaskId: randomUUID(), revisionId: randomUUID(), approvedAt: new Date().toISOString(), result: {
      kind: 'design', summary: 'Approved design', designUrl: 'https://claude.ai/code/artifact/approved', specification: 'Use the approved header and responsive navigation.', questions: [], screens: [{ name: 'Home', path: 'index.html' }], files: await collectDesignFiles(source),
    } };
    const job = dispatch({ payload: agentPayload({ repos: [], step: step({ engine: engineName, output: 'plan' }), designHandoff: { sourceTaskId: handoff.sourceTaskId, revisionId: handoff.revisionId, approvedAt: handoff.approvedAt } }) }, null);
    const engine: Engine = { name: engineName, probe: async () => ({ available: true, version: 'test' }), run: async (opts) => {
      const inputPath = path.join(workdir, 'design-inputs', job.job.id);
      expect(await fs.readFile(path.join(inputPath, 'index.html'), 'utf8')).toBe('<h1>Approved design</h1>');
      expect(opts.prompt).toContain(handoff.result.specification);
      expect(opts.writableDirs).toContain(inputPath);
      await fs.writeFile(opts.env['SINDRAL_RESULT_FILE']!, JSON.stringify({ kind: 'plan', summary: 'Plan ready', plan: '# Implement the approved design' }));
      return { exitCode: 0, tail: [], finalText: null, sessionId: null, timedOut: false, cancelled: false, missing: false };
    } };
    const api = { postEvent: vi.fn(async () => ({ ok: true as const })), complete: vi.fn(async () => ({ ok: true as const })), fail: vi.fn(async () => ({ ok: true as const })), cancel: vi.fn(async () => ({ ok: true as const })) };
    const outcome = await runJob(job, { config: testConfig({ workdir }), api, engines: { claude: engine, codex: engine },
      designInputApi: { readDesignInput: vi.fn(async () => ({ input: handoff })) }, workspaces: { prepare: async () => ({ taskKey: 'SIN-1', cwd: workdir, repos: [] }) } as unknown as WorkspaceManager, logger: silentLogger() }, new AbortController().signal);
    expect(outcome.status).toBe('completed');
    expect(api.fail).not.toHaveBeenCalled();
  });
});
