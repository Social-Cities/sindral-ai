import type { WorkflowStep } from '@sindral/shared';
import { run, stream } from '../proc.js';
import { extractVersion, OutputTail, type Engine, type EngineCapabilities, type EngineRunOptions, type EngineRunResult } from './types.js';

export interface CodexCapabilities extends EngineCapabilities {
  supportsResume: boolean;
}

export function normalizeCodexModel(model: string | undefined): string | undefined {
  if (model === 'gpt-5-codex' || model === 'gpt-5') return 'gpt-6.1-sol';
  if (model === 'o4-mini') return 'gpt-6-luna';
  return model;
}

export function buildCodexArgs(step: WorkflowStep, writableDirs: string[] = [], resumeSessionId?: string | null): string[] {
  const args = resumeSessionId ? ['exec', 'resume'] : ['exec'];
  const model = normalizeCodexModel(step.model);
  if (model) args.push('--model', model);
  // Worker agents run inside Sindral-managed checkouts. Keep workflow
  // permissions as intent metadata, but avoid sandbox modes that can prevent
  // required result files or diagnostics from being written.
  args.push('--dangerously-bypass-approvals-and-sandbox');
  // The result file and output dir live outside the worktree. `--add-dir`
  // keeps them in the visible workspace when the CLI builds its context.
  for (const dir of writableDirs) args.push('--add-dir', dir);
  // Non-code tasks run in a plain tmp directory; codex refuses to start outside a git repo otherwise.
  args.push('--skip-git-repo-check', '--json');
  if (resumeSessionId) args.push(resumeSessionId);
  args.push('-');
  return args;
}

function short(value: unknown, max = 200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface CodexLine {
  lines: string[];
  /** Text of an agent message, when this event carries one. */
  agentText?: string;
  sessionId?: string;
}

/** Turns one `codex exec --json` event line into human-readable lines. */
export function parseCodexLine(line: string): CodexLine {
  const trimmed = line.trim();
  if (!trimmed) return { lines: [] };
  if (!trimmed.startsWith('{')) return { lines: [trimmed] };
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return { lines: [trimmed] };
  }
  const type = typeof event['type'] === 'string' ? event['type'] : '';
  const item = (event['item'] ?? null) as Record<string, unknown> | null;
  if (type === 'thread.started') {
    const sessionId = typeof event['thread_id'] === 'string' ? event['thread_id'] : typeof event['threadId'] === 'string' ? event['threadId'] : typeof event['id'] === 'string' ? event['id'] : undefined;
    return { lines: ['[codex] session started'], ...(sessionId ? { sessionId } : {}) };
  }
  if (type === 'turn.failed' || type === 'error') {
    const err = event['error'] as { message?: unknown } | undefined;
    return { lines: [`[codex] error: ${short(err?.message ?? event['message'] ?? 'unknown')}`] };
  }
  if (type === 'turn.completed') {
    const usage = event['usage'] as Record<string, unknown> | undefined;
    return { lines: [`[result] turn completed${usage ? ` tokens=${short(usage['input_tokens'])}/${short(usage['output_tokens'])}` : ''}`] };
  }
  if (type === 'item.completed' && item) {
    switch (item['type']) {
      case 'agent_message':
        return typeof item['text'] === 'string' ? { lines: item['text'].split('\n'), agentText: item['text'] } : { lines: [] };
      case 'reasoning':
        return { lines: typeof item['text'] === 'string' ? [`[thinking] ${short(item['text'], 300)}`] : [] };
      case 'command_execution':
        return { lines: [`[cmd] ${short(item['command'])} (exit ${String(item['exit_code'] ?? '?')})`] };
      case 'file_change': {
        const changes = Array.isArray(item['changes']) ? (item['changes'] as Record<string, unknown>[]) : [];
        return { lines: changes.map((c) => `[edit] ${String(c['kind'] ?? 'change')} ${String(c['path'] ?? '')}`) };
      }
      case 'error':
        return { lines: [`[codex] error: ${short(item['message'])}`] };
      default:
        return { lines: [] };
    }
  }
  if (type === 'item.started' && item?.['type'] === 'command_execution') return { lines: [`[cmd] $ ${short(item['command'])}`] };
  return { lines: [] };
}

export function formatCodexLine(line: string): string[] {
  return parseCodexLine(line).lines;
}

export class CodexEngine implements Engine {
  readonly name = 'codex' as const;
  private caps: Promise<CodexCapabilities> | null = null;

  constructor(private readonly bin: string) {}

  probe(): Promise<CodexCapabilities> {
    this.caps ??= (async () => {
      const version = await run(this.bin, ['--version'], { timeoutMs: 15_000 });
      if (version.failed || version.code === 'ENOENT') return { available: false, version: null, supportsResume: false };
      const help = await run(this.bin, ['exec', '--help'], { timeoutMs: 15_000 });
      return { available: true, version: extractVersion(version.stdout), supportsResume: /\bresume\b/.test(`${help.stdout}\n${help.stderr}`) };
    })();
    return this.caps;
  }

  async run(opts: EngineRunOptions): Promise<EngineRunResult> {
    const caps = await this.probe();
    if (!caps.available) return { exitCode: null, tail: [], finalText: null, sessionId: null, timedOut: false, cancelled: false, missing: true };
    const tail = new OutputTail();
    let finalText: string | null = null;
    let sessionId: string | null = null;
    const resumeSessionId = caps.supportsResume ? opts.resumeSessionId : null;
    if (opts.resumeSessionId && !caps.supportsResume) opts.onOutput('[codex] resume is not supported by this CLI; starting a fresh session');
    const result = await stream(this.bin, buildCodexArgs(opts.step, opts.writableDirs, resumeSessionId), {
      cwd: opts.cwd,
      env: opts.env,
      extendEnv: false,
      input: opts.prompt,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onLine: (line) => {
        const parsed = parseCodexLine(line);
        if (parsed.agentText !== undefined) finalText = parsed.agentText;
        if (parsed.sessionId !== undefined) sessionId = parsed.sessionId;
        for (const text of parsed.lines) {
          tail.push(text);
          opts.onOutput(text);
        }
      },
    });
    if (result.code === 'ENOENT') return { exitCode: null, tail: tail.get(), finalText: null, sessionId, timedOut: false, cancelled: false, missing: true };
    if (result.failed && result.exitCode === null && result.message) tail.push(result.message);
    return { exitCode: result.exitCode, tail: tail.get(), finalText, sessionId, timedOut: result.timedOut, cancelled: result.cancelled, missing: false };
  }
}
