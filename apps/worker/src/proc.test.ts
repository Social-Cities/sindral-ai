import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { CommandError, run, runInteractive, runOrThrow } from './proc.js';

const mocked = vi.mocked(execa);

describe('proc.run', () => {
  // Block body: a function returned from beforeEach is treated as a cleanup hook.
  beforeEach(() => {
    mocked.mockReset();
  });

  it('passes argv arrays and never a shell, and normalises the result', async () => {
    mocked.mockResolvedValue({ exitCode: 0, stdout: 'ok\n', stderr: '', failed: false } as never);
    const result = await run('git', ['status', '--porcelain'], { cwd: '/x', input: 'stdin' });
    expect(mocked).toHaveBeenCalledWith('git', ['status', '--porcelain'], expect.objectContaining({ cwd: '/x', input: 'stdin', reject: false, stdin: 'pipe' }));
    const options = (mocked.mock.calls[0] as unknown[] | undefined)?.[2];
    expect(options).not.toHaveProperty('shell');
    expect(result).toMatchObject({ exitCode: 0, stdout: 'ok\n', failed: false, code: null });
  });

  it('reports ENOENT as a failed result instead of throwing', async () => {
    mocked.mockResolvedValue({ failed: true, code: 'ENOENT', shortMessage: 'Command failed with ENOENT', stdout: '', stderr: '' } as never);
    const result = await run('nope', []);
    expect(result).toMatchObject({ failed: true, code: 'ENOENT', exitCode: null });
    expect(result.message).toContain('ENOENT');
  });

  it('turns thrown spawn errors into results', async () => {
    // mockRejectedValue creates the rejection eagerly; a lazy implementation mirrors execa.
    mocked.mockImplementation((() => Promise.reject(Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' }))) as never);
    const result = await run('nope', []);
    expect(result).toMatchObject({ failed: true, code: 'ENOENT', message: 'spawn nope ENOENT' });
  });

  it('runOrThrow raises a CommandError with stderr', async () => {
    mocked.mockResolvedValue({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repo', failed: true } as never);
    await expect(runOrThrow('git', ['fetch'])).rejects.toThrow(CommandError);
    await expect(runOrThrow('git', ['fetch'])).rejects.toThrow(/exit 128.*not a git repo/);
  });

  it('runs interactive commands on the inherited terminal without a shell', async () => {
    mocked.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', failed: false } as never);
    const result = await runInteractive('codex', ['login', '--device-auth'], { cwd: '/x', env: { CODEX_HOME: '/state' } });
    expect(mocked).toHaveBeenCalledWith('codex', ['login', '--device-auth'], expect.objectContaining({
      cwd: '/x',
      env: { CODEX_HOME: '/state' },
      reject: false,
      stdio: 'inherit',
    }));
    const options = (mocked.mock.calls[0] as unknown[] | undefined)?.[2];
    expect(options).not.toHaveProperty('shell');
    expect(result).toMatchObject({ exitCode: 0, failed: false });
  });
});
