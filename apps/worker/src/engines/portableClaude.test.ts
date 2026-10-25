import { describe, expect, it, vi } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { EngineRunOptions } from './types.js';
import { runPortableClaude } from './portableClaude.js';
import { parseClaudeLine } from './claude.js';
import { step } from '../test/fixtures.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

function options(): EngineRunOptions {
  return { cwd: '/worker/design/SIN-1', prompt: '/design A dashboard', step: step({ output: 'design' }), env: { PATH: '/bin', CLAUDE_CONFIG_DIR: '/worker/claude' }, timeoutMs: 1000,
    onOutput: vi.fn(), portableSession: { projectKey: 'sindral-task-id', store: { append: vi.fn(), load: vi.fn() }, onCheckpoint: vi.fn() } };
}

function messages(items: unknown[]) {
  const iterator = (async function* () { for (const item of items) yield item; })();
  const close = vi.fn();
  vi.mocked(query).mockReturnValue(Object.assign(iterator, { close }) as unknown as ReturnType<typeof query>);
  return close;
}

describe('portable Claude runner', () => {
  it('uses the stable project key, eager mirroring, and the authenticated config directory', async () => {
    const opts = options();
    messages([{ type: 'system', subtype: 'init', slash_commands: ['design'], session_id: 'session-1' }, { type: 'result', subtype: 'success', result: 'Design complete' }]);
    expect(await runPortableClaude(opts, parseClaudeLine)).toMatchObject({ exitCode: 0, sessionId: 'session-1', finalText: 'Design complete' });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({
      sessionStore: opts.portableSession!.store, sessionStoreFlush: 'eager', settings: { enableArtifact: true },
      env: expect.objectContaining({ CLAUDE_CODE_PROJECT_DIR_NAME: 'sindral-task-id', CLAUDE_CONFIG_DIR: '/worker/claude' }),
    }) }));
    expect(opts.portableSession!.onCheckpoint).toHaveBeenCalledWith('session-1');
  });

  it('reports an unavailable Design command without treating a local artifact as success', async () => {
    const close = messages([{ type: 'system', subtype: 'init', slash_commands: [], session_id: 'session-1' }]);
    await expect(runPortableClaude(options(), parseClaudeLine)).rejects.toThrow('Claude Design is unavailable');
    expect(close).toHaveBeenCalled();
  });

  it('stops on a transcript mirror failure', async () => {
    const close = messages([{ type: 'system', subtype: 'mirror_error' }]);
    await expect(runPortableClaude(options(), parseClaudeLine)).rejects.toThrow('could not be saved');
    expect(close).toHaveBeenCalled();
  });

  it('stops when the final workspace checkpoint fails', async () => {
    messages([{ type: 'system', subtype: 'init', slash_commands: ['design'], session_id: 'session-1' }]);
    const opts = options(); opts.portableSession!.onCheckpoint = vi.fn().mockRejectedValue(new Error('Checkpoint storage unavailable'));
    await expect(runPortableClaude(opts, parseClaudeLine)).rejects.toThrow('Checkpoint storage unavailable');
  });
});
