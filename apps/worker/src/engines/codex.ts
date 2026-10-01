import type { WorkflowStep } from '@sindral/shared';
import { run, stream } from '../proc.js';
import { extractVersion, OutputTail, type Engine, type EngineCapabilities, type EngineRunOptions, type EngineRunResult } from './types.js';

export function normalizeCodexModel(model: string | undefined): string | undefined {
  if (model === 'gpt-5-codex' || model === 'gpt-5') return 'gpt-6.1-sol';
  if (model === 'o4-mini') return 'gpt-6-luna';
  return model;
}

export function buildCodexArgs(step: WorkflowStep, writableDirs: string[] = []): string[] {
  const permissions = new Set(step.permissions ?? []);
  const write = permissions.has('write');
  const args = ['exec'];
  const model = normalizeCodexModel(step.model);
  if (model) args.push('--model', model);
  args.push('--sandbox', 'workspace-write');
  if (write) {
    args.push('--full-auto');
  }
  // The result file and output dir live outside the worktree.
  if (writableDirs.length > 0) args.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(writableDirs)}`);
  // Non-code tasks run in a plain tmp directory; codex refuses to start outside a git repo otherwise.
  args.push('--skip-git-repo-check', '--json', '-');
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
  if (type === 'thread.started') return { lines: ['[codex] session started'] };
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
  private caps: Promise<EngineCapabilities> | null = null;

  constructor(private readonly bin: string) {}

  probe(): Promise<EngineCapabilities> {
    this.caps ??= (async () => {
      const version = await run(this.bin, ['--version'], { timeoutMs: 15_000 });
      if (version.failed || version.code === 'ENOENT') return { available: false, version: null };
      return { available: true, version: extractVersion(version.stdout) };
    })();
    return this.caps;
  }

  async run(opts: EngineRunOptions): Promise<EngineRunResult> {
    const caps = await this.probe();
    if (!caps.available) return { exitCode: null, tail: [], finalText: null, timedOut: false, cancelled: false, missing: true };
    const tail = new OutputTail();
    let finalText: string | null = null;
    const result = await stream(this.bin, buildCodexArgs(opts.step, opts.writableDirs), {
      cwd: opts.cwd,
      env: opts.env,
      extendEnv: false,
      input: opts.prompt,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onLine: (line) => {
        const parsed = parseCodexLine(line);
        if (parsed.agentText !== undefined) finalText = parsed.agentText;
        for (const text of parsed.lines) {
          tail.push(text);
          opts.onOutput(text);
        }
      },
    });
    if (result.code === 'ENOENT') return { exitCode: null, tail: tail.get(), finalText: null, timedOut: false, cancelled: false, missing: true };
    if (result.failed && result.exitCode === null && result.message) tail.push(result.message);
    return { exitCode: result.exitCode, tail: tail.get(), finalText, timedOut: result.timedOut, cancelled: result.cancelled, missing: false };
  }
}
