import type { AgentMode, ToolName, WorkflowStep } from '@sindral/shared';
import path from 'node:path';
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
}

export function claudeAllowedTools(step: WorkflowStep): string[] {
  const permissions = new Set(step.permissions ?? []);
  const tools = new Set<string>();
  for (const tool of step.tools ?? []) {
    for (const mapped of CLAUDE_TOOL_MAP[tool] ?? []) {
      if (mapped === 'Bash' && !permissions.has('execute')) continue;
      if (['Edit', 'Write', 'MultiEdit'].includes(mapped) && !permissions.has('write')) continue;
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

function claudeEditRule(dir: string): string {
  const normalized = dir.replaceAll('\\', '/').replace(/\/+$/, '');
  // Claude permission patterns use `//` for absolute paths. A single leading
  // slash is resolved like a relative pattern and does not authorize the file.
  // `Edit` is the umbrella permission for every built-in file editing tool,
  // including the `Write` calls used to create result and artifact files.
  const pattern = path.isAbsolute(dir) ? `//${normalized.replace(/^\/+/, '')}` : normalized;
  return `Edit(${pattern}/**)`;
}

export function buildClaudeArgs(step: WorkflowStep, caps: Pick<ClaudeCapabilities, 'supportsEffort'>, writableDirs: string[] = []): string[] {
  const permissions = new Set(step.permissions ?? []);
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (step.model) args.push('--model', step.model);
  // Read-only steps run in `default` mode (not `plan`, which forbids all file writes) with an
  // allow-list that only permits writing inside the worker-owned result/output directories,
  // so the agent can still emit the Sindral result file without being able to edit the repo.
  const canWrite = permissions.has('write');
  args.push('--permission-mode', canWrite ? 'acceptEdits' : 'default');
  const tools = claudeAllowedTools(step);
  if (!canWrite) for (const dir of writableDirs) tools.push(claudeEditRule(dir));
  if (tools.length > 0) args.push('--allowedTools', tools.join(','));
  const effort = claudeEffort(step.mode);
  if (caps.supportsEffort && effort) args.push('--effort', effort);
  // The result file and output dir live outside the worktree; without this,
  // acceptEdits would still refuse writes there.
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
    return { lines: [`[claude] session started model=${String(event['model'] ?? '?')}`] };
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
    if (version.failed || version.code === 'ENOENT') return { available: false, version: null, supportsEffort: false };
    const help = await run(this.bin, ['--help'], { timeoutMs: 15_000 });
    const supportsEffort = /--effort\b/.test(`${help.stdout}\n${help.stderr}`);
    return { available: true, version: extractVersion(version.stdout), supportsEffort };
  }

  async run(opts: EngineRunOptions): Promise<EngineRunResult> {
    const caps = await this.probe();
    if (!caps.available) return { exitCode: null, tail: [], finalText: null, timedOut: false, cancelled: false, missing: true };
    const tail = new OutputTail();
    let finalText: string | null = null;
    let lastAssistant: string | null = null;
    const result = await stream(this.bin, buildClaudeArgs(opts.step, caps, opts.writableDirs), {
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
        for (const text of parsed.lines) {
          tail.push(text);
          opts.onOutput(text);
        }
      },
    });
    if (result.code === 'ENOENT') return { exitCode: null, tail: tail.get(), finalText: null, timedOut: false, cancelled: false, missing: true };
    if (result.failed && result.exitCode === null && result.message) tail.push(result.message);
    return { exitCode: result.exitCode, tail: tail.get(), finalText: finalText ?? lastAssistant, timedOut: result.timedOut, cancelled: result.cancelled, missing: false };
  }
}
