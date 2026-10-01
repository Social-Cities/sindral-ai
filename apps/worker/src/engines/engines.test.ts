import { describe, expect, it } from 'vitest';
import { step } from '../test/fixtures.js';
import { buildClaudeArgs, claudeAllowedTools, formatClaudeLine, parseClaudeLine } from './claude.js';
import { buildCodexArgs, formatCodexLine, normalizeCodexModel, parseCodexLine } from './codex.js';
import { buildAgentEnv } from './env.js';
import { extractVersion, OutputTail } from './types.js';

describe('claude args', () => {
  it('runs with open permissions and the prompt on stdin', () => {
    const args = buildClaudeArgs(step(), { supportsEffort: false });
    expect(args.slice(0, 5)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--model']);
    expect(args).toContain('claude-sonnet-4-5');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    expect(args).not.toContain('--allowedTools');
    expect(args.join(' ')).not.toContain('Implement');
    expect(args).not.toContain('--effort');
  });

  it('read-only steps still run with open engine permissions', () => {
    const s = step({ permissions: ['read'], tools: ['read_file', 'write_file', 'run_command', 'search_codebase', 'create_pr'] });
    expect(claudeAllowedTools(s)).toEqual(['Read', 'Edit', 'Write', 'MultiEdit', 'Bash', 'Grep', 'Glob']);
    const args = buildClaudeArgs(s, { supportsEffort: false }, ['/w/results', '/w/outputs/j1']);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    expect(args).not.toContain('--allowedTools');
    expect(args).toContain('--add-dir');
  });

  it('maps requested tools without permission filtering and never grants anything for create_pr', () => {
    expect(claudeAllowedTools(step({ tools: ['run_command'], permissions: ['read', 'write'] }))).toEqual(['Bash']);
    expect(claudeAllowedTools(step({ tools: ['write_file'], permissions: ['read'] }))).toEqual(['Edit', 'Write', 'MultiEdit']);
    expect(claudeAllowedTools(step({ tools: ['run_command'], permissions: ['execute'] }))).toEqual(['Bash']);
    expect(claudeAllowedTools(step({ tools: ['create_pr'], permissions: ['read', 'write', 'execute'] }))).toEqual([]);
    expect(claudeAllowedTools(step({ tools: ['web_search'], permissions: ['read'] }))).toEqual(['WebSearch', 'WebFetch']);
  });

  it('adds --effort only when the CLI supports it', () => {
    const high = buildClaudeArgs(step({ mode: 'high' }), { supportsEffort: true });
    expect(high.slice(high.indexOf('--effort'))).toEqual(['--effort', 'high']);
    expect(buildClaudeArgs(step({ mode: 'low' }), { supportsEffort: true })).toContain('low');
    expect(buildClaudeArgs(step({ mode: 'normal' }), { supportsEffort: true })).toContain('medium');
    expect(buildClaudeArgs(step({ mode: 'high' }), { supportsEffort: false })).not.toContain('--effort');
    expect(buildClaudeArgs(step({ mode: undefined }), { supportsEffort: true })).not.toContain('--effort');
  });

  it('omits --model and --allowedTools when unset', () => {
    const args = buildClaudeArgs(step({ model: undefined, tools: [] }), { supportsEffort: false });
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--allowedTools');
  });

  it('whitelists the result and output directories with --add-dir', () => {
    const args = buildClaudeArgs(step(), { supportsEffort: false }, ['/w/results', '/w/outputs/j1']);
    expect(args.join(' ')).toContain('--add-dir /w/results --add-dir /w/outputs/j1');
  });

  it('captures the final message for the result-file fallback', () => {
    const final = parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'success', result: '{"summary":"s"}' }));
    expect(final.finalText).toBe('{"summary":"s"}');
    const assistant = parseClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }));
    expect(assistant.assistantText).toBe('hi');
    expect(parseClaudeLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'x' }] } })).assistantText).toBeUndefined();
  });
});

describe('claude stream-json formatting', () => {
  it('renders assistant text, tool use and result lines', () => {
    expect(formatClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello\nworld' }] } }))).toEqual(['hello', 'world']);
    expect(formatClaudeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }] } }))).toEqual([
      '[tool] Bash pnpm test',
    ]);
    expect(formatClaudeLine(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 3, total_cost_usd: 0.1234 }))).toEqual(['[result] success turns=3 cost=$0.123']);
    expect(formatClaudeLine(JSON.stringify({ type: 'system', subtype: 'init', model: 'm' }))).toEqual(['[claude] session started model=m']);
  });

  it('passes through non-JSON lines and drops noise', () => {
    expect(formatClaudeLine('plain text')).toEqual(['plain text']);
    expect(formatClaudeLine('')).toEqual([]);
    expect(formatClaudeLine('{not json')).toEqual(['{not json']);
    expect(formatClaudeLine(JSON.stringify({ type: 'rate_limit' }))).toEqual([]);
  });
});

describe('codex args', () => {
  it('bypasses approvals and sandboxing for write steps, reading the prompt from stdin', () => {
    const args = buildCodexArgs(step());
    expect(args[0]).toBe('exec');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-4-5');
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--sandbox');
    expect(args).not.toContain('--full-auto');
    expect(args).toContain('--json');
    expect(args.at(-1)).toBe('-');
  });

  it('maps retired Codex API model names to current Codex model slugs', () => {
    expect(normalizeCodexModel('gpt-5-codex')).toBe('gpt-6.1-sol');
    expect(normalizeCodexModel('gpt-5')).toBe('gpt-6.1-sol');
    expect(normalizeCodexModel('o4-mini')).toBe('gpt-6-luna');
    const args = buildCodexArgs(step({ model: 'gpt-5-codex' }));
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-6.1-sol');
  });

  it('uses the same open mode for non-write steps', () => {
    const args = buildCodexArgs(step({ permissions: ['read', 'execute'], model: undefined }), ['/w/results']);
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--sandbox');
    expect(args).not.toContain('--model');
    expect(args).toContain('--add-dir');
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/w/results');
  });

  it('adds writable roots for write steps', () => {
    const args = buildCodexArgs(step(), ['/w/results', '/w/outputs/j1']);
    expect(args).toEqual(expect.arrayContaining(['--add-dir', '/w/results', '--add-dir', '/w/outputs/j1']));
  });

  it('captures agent messages for the result-file fallback', () => {
    expect(parseCodexLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"summary":"s"}' } })).agentText).toBe('{"summary":"s"}');
    expect(parseCodexLine(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'hmm' } })).agentText).toBeUndefined();
  });
});

describe('codex json formatting', () => {
  it('renders messages, commands and errors', () => {
    expect(formatCodexLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done\nok' } }))).toEqual(['done', 'ok']);
    expect(formatCodexLine(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'ls', exit_code: 0 } }))).toEqual(['[cmd] ls (exit 0)']);
    expect(formatCodexLine(JSON.stringify({ type: 'turn.failed', error: { message: 'quota' } }))).toEqual(['[codex] error: quota']);
    expect(formatCodexLine('raw')).toEqual(['raw']);
    expect(formatCodexLine(JSON.stringify({ type: 'item.started', item: { type: 'reasoning' } }))).toEqual([]);
  });
});

describe('agent environment', () => {
  it('strips credentials and adds protocol variables', () => {
    const env = buildAgentEnv(
      { PATH: '/bin', GH_TOKEN: 'ghp_x', GITHUB_TOKEN: 'ghp_y', SINDRAL_WORKER_KEY: 'sk', HOME: '/home' },
      { SINDRAL_RESULT_FILE: '/r.json', SINDRAL_OUTPUT_DIR: '/o', SINDRAL_TASK_KEY: 'ENG-1' },
    );
    expect(env).toEqual({ PATH: '/bin', HOME: '/home', SINDRAL_RESULT_FILE: '/r.json', SINDRAL_OUTPUT_DIR: '/o', SINDRAL_TASK_KEY: 'ENG-1', GIT_TERMINAL_PROMPT: '0' });
  });
});

describe('helpers', () => {
  it('extracts versions and keeps an output tail', () => {
    expect(extractVersion('2.1.4 (Claude Code)')).toBe('2.1.4');
    expect(extractVersion('codex-cli 0.50')).toBe('0.50');
    expect(extractVersion('nope')).toBeNull();
    const tail = new OutputTail(2);
    tail.push('a');
    tail.push('b');
    tail.push('c');
    expect(tail.get()).toEqual(['b', 'c']);
  });
});
