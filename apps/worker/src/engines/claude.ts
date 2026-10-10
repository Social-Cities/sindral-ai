import type { AgentMode, ToolName, WorkflowStep } from '@sindral/shared';
import { run, stream } from '../proc.js';
import { extractVersion, OutputTail, type Engine, type EngineCapabilities, type EngineRunOptions, type EngineRunResult } from './types.js';

export const CLAUDE_TOOL_MAP: Record<ToolName, string[]> = {
  read_file: ['Read'],
  list_directory: ['LS', 'Glob'],
  search_codebase: ['Grep', 'Glob'],
  write_file: ['Edit', 'Write', 'MultiEdit'],
  run_command: ['Bash'],
  web_search: ['WebSearch', 'WebFetch'],
  // The worker opens PRs itself; the agent gets nothing extra.
  create_pr: [],
};

export interface ClaudeCapabilities extends EngineCapabilities {
  /** Whether `claude --help` advertises an `--effort` flag. */
  supportsEffort: boolean;
  /** Whether `claude --help` advertises a `--resume` flag. */
  supportsResume: boolean;
}

export function claudeAllowedTools(step: WorkflowStep): string[] {
  const tools = new Set<string>();
  for (const tool of step.tools ?? []) {
    for (const mapped of CLAUDE_TOOL_MAP[tool] ?? []) {
      tools.add(mapped);
    }
  }
  return [...tools];
}

export function claudeEffort(mode: AgentMode | undefined): string | null {
  switch (mode) {
    case 'high':
      return 'high';
    case 'low':
      return 'low';
    case 'normal':
      return 'medium';
    default:
      return null;
  }
}

export function buildClaudeArgs(step: WorkflowStep, caps: Pick<ClaudeCapabilities, 'supportsEffort'> & Partial<Pick<ClaudeCapabilities, 'supportsResume'>>, writableDirs: string[] = [], resumeSessionId?: string | null): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (step.model) args.push('--model', step.model);
  // Worker agents run inside Sindral-managed checkouts. Keep the workflow
  // permissions as intent metadata, but do not put the engine into a restricted
  // sandbox: read-only planning/review steps still need to write result files,
  // run diagnostics, and recover from partially blocked tool calls.
  args.push('--permission-mode', 'bypassPermissions');
  const effort = claudeEffort(step.mode);
  if (caps.supportsEffort && effort) args.push('--effort', effort);
  if (resumeSessionId && caps.supportsResume !== false) args.push('--resume', resumeSessionId);
  // The result file and output dir live outside the worktree. `--add-dir`
  // keeps them visible to Claude even when they are not under the repository.
  for (const dir of writableDirs) args.push('--add-dir', dir);
  return args;
}

function summariseInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  const key = ['command', 'file_path', 'pattern', 'path', 'query', 'url', 'description'].find((k) => typeof obj[k] === 'string');
  const value = key ? String(obj[key]) : JSON.stringify(obj);
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}

export interface ClaudeLine {
  lines: string[];
  /** Text of the final assistant message, when this event carries it. */
  finalText?: string;
  assistantText?: string;
  sessionId?: string;
}

/** Turns one `stream-json` line into human-readable lines (may be empty). */
export function parseClaudeLine(line: string): ClaudeLine {
  const trimmed = line.trim();
  if (!trimmed) return { lines: [] };
  if (!trimmed.startsWith('{')) return { lines: [trimmed] };
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return { lines: [trimmed] };
  }
  const type = event['type'];
  if (type === 'assistant' || type === 'user') {
    const message = event['message'] as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : [];
    const out: string[] = [];
    const texts: string[] = [];
    for (const block of content) {
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        out.push(...block['text'].split('\n'));
        texts.push(block['text']);
      } else if (block['type'] === 'tool_use') out.push(`[tool] ${String(block['name'] ?? 'tool')} ${summariseInput(block['input'])}`.trimEnd());
      else if (block['type'] === 'tool_result' && block['is_error'] === true) out.push('[tool-error] ' + summariseInput({ description: String(block['content'] ?? '') }));
    }
    return type === 'assistant' && texts.length > 0 ? { lines: out, assistantText: texts.join('\n') } : { lines: out };
  }
  if (type === 'result') {
    const subtype = typeof event['subtype'] === 'string' ? event['subtype'] : 'done';
    const parts = [`[result] ${subtype}`];
    if (typeof event['num_turns'] === 'number') parts.push(`turns=${event['num_turns']}`);
    if (typeof event['total_cost_usd'] === 'number') parts.push(`cost=$${(event['total_cost_usd'] as number).toFixed(3)}`);
    if (subtype !== 'success' && typeof event['result'] === 'string') parts.push(event['result'] as string);
    return typeof event['result'] === 'string' ? { lines: [parts.join(' ')], finalText: event['result'] } : { lines: [parts.join(' ')] };
  }
  if (type === 'system' && event['subtype'] === 'init') {
    const sessionId = typeof event['session_id'] === 'string' ? event['session_id'] : typeof event['sessionId'] === 'string' ? event['sessionId'] : undefined;
    return { lines: [`[claude] session started model=${String(event['model'] ?? '?')}`], ...(sessionId ? { sessionId } : {}) };
  }
  return { lines: [] };
}

export function formatClaudeLine(line: string): string[] {
  return parseClaudeLine(line).lines;
}

export class ClaudeEngine implements Engine {
  readonly name = 'claude' as const;
  private caps: Promise<ClaudeCapabilities> | null = null;

  constructor(private readonly bin: string) {}

  probe(): Promise<ClaudeCapabilities> {
    this.caps ??= this.doProbe();
    return this.caps;
  }

  private async doProbe(): Promise<ClaudeCapabilities> {
    const version = await run(this.bin, ['--version'], { timeoutMs: 15_000 });
    if (version.failed || version.code === 'ENOENT') return { available: false, version: null, supportsEffort: false, supportsResume: false };
    const help = await run(this.bin, ['--help'], { timeoutMs: 15_000 });
    const supportsEffort = /--effort\b/.test(`${help.stdout}\n${help.stderr}`);
    const supportsResume = /--resume\b/.test(`${help.stdout}\n${help.stderr}`);
    return { available: true, version: extractVersion(version.stdout), supportsEffort, supportsResume };
  }

  async run(opts: EngineRunOptions): Promise<EngineRunResult> {
    const caps = await this.probe();
    if (!caps.available) return { exitCode: null, tail: [], finalText: null, sessionId: null, timedOut: false, cancelled: false, missing: true };
    const tail = new OutputTail();
    let finalText: string | null = null;
    let lastAssistant: string | null = null;
    let sessionId: string | null = null;
    const resumeSessionId = caps.supportsResume ? opts.resumeSessionId : null;
    if (opts.resumeSessionId && !caps.supportsResume) opts.onOutput('[claude] resume is not supported by this CLI; starting a fresh session');
    const result = await stream(this.bin, buildClaudeArgs(opts.step, caps, opts.writableDirs, resumeSessionId), {
      cwd: opts.cwd,
      env: opts.env,
      extendEnv: false,
      input: opts.prompt,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onLine: (line) => {
        const parsed = parseClaudeLine(line);
        if (parsed.finalText !== undefined) finalText = parsed.finalText;
        if (parsed.assistantText !== undefined) lastAssistant = parsed.assistantText;
        if (parsed.sessionId !== undefined) sessionId = parsed.sessionId;
        for (const text of parsed.lines) {
          tail.push(text);
          opts.onOutput(text);
        }
      },
    });
    if (result.code === 'ENOENT') return { exitCode: null, tail: tail.get(), finalText: null, sessionId, timedOut: false, cancelled: false, missing: true };
    if (result.failed && result.exitCode === null && result.message) tail.push(result.message);
    return { exitCode: result.exitCode, tail: tail.get(), finalText: finalText ?? lastAssistant, sessionId, timedOut: result.timedOut, cancelled: result.cancelled, missing: false };
  }
}
