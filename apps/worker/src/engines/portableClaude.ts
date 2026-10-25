import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { OutputTail, type EngineRunOptions, type EngineRunResult } from './types.js';
import type { ClaudeLine } from './claude.js';
import os from 'node:os';
import path from 'node:path';

/** Design sessions use the pinned SDK's bundled CLI so all hosts speak the same transcript format. */
export async function runPortableClaude(opts: EngineRunOptions, parse: (line: string) => ClaudeLine): Promise<EngineRunResult> {
  if (!opts.portableSession) throw new Error('Portable Claude requires a session store');
  const abortController = new AbortController();
  const abort = () => abortController.abort(opts.signal?.reason);
  const persistenceAbort = () => abortController.abort(opts.portableSession?.signal?.reason);
  opts.signal?.addEventListener('abort', abort, { once: true });
  opts.portableSession.signal?.addEventListener('abort', persistenceAbort, { once: true });
  if (opts.signal?.aborted) abort();
  if (opts.portableSession.signal?.aborted) persistenceAbort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abortController.abort(new Error('Claude design session timed out')); }, opts.timeoutMs);
  const tail = new OutputTail();
  let sessionId: string | null = opts.resumeSessionId ?? null;
  let finalText: string | null = null;
  let lastAssistant: string | null = null;
  let failure: unknown = null;
  let lastCheckpoint = 0;
  const options: Options = {
    cwd: opts.cwd,
    model: opts.step.model,
    effort: opts.step.mode === 'normal' ? 'medium' : opts.step.mode,
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    additionalDirectories: opts.writableDirs,
    settingSources: ['user', 'project'],
    env: { ...opts.env, CLAUDE_CONFIG_DIR: opts.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude'), CLAUDE_CODE_PROJECT_DIR_NAME: opts.portableSession.projectKey },
    resume: opts.resumeSessionId ?? undefined,
    sessionStore: opts.portableSession.store, sessionStoreFlush: 'eager',
    abortController,
  };
  const agent = query({ prompt: opts.prompt, options });
  try {
    for await (const message of agent) {
      if (message.type === 'system' && message.subtype === 'mirror_error') throw new Error('Claude session could not be saved; stopping before further design changes');
      const parsed = parse(JSON.stringify(message));
      sessionId = parsed.sessionId ?? sessionId;
      finalText = parsed.finalText ?? finalText;
      lastAssistant = parsed.assistantText ?? lastAssistant;
      for (const line of parsed.lines) { tail.push(line); opts.onOutput(line); }
      if (message.type === 'result' && message.subtype !== 'success') throw new Error(`Claude design session failed: ${message.errors.join('; ')}`);
      if (message.type === 'user' && Date.now() - lastCheckpoint >= 15_000) {
        await opts.portableSession.onCheckpoint(sessionId);
        lastCheckpoint = Date.now();
      }
    }
    await opts.portableSession.onCheckpoint(sessionId);
  } catch (error) {
    failure = error;
    const text = error instanceof Error ? error.message : String(error);
    tail.push(text); opts.onOutput(text);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', abort);
    opts.portableSession.signal?.removeEventListener('abort', persistenceAbort);
    agent.close();
  }
  // A persistence failure must never become a successful recoverable result.
  if (failure && !timedOut && !opts.signal?.aborted) throw failure;
  return { exitCode: failure ? 1 : 0, tail: tail.get(), finalText: finalText ?? lastAssistant, sessionId,
    timedOut, cancelled: opts.signal?.aborted ?? false, missing: false };
}
