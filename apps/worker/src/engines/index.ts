import type { AgentEngine } from '@sindral/shared';
import type { WorkerConfig } from '../config.js';
import { ClaudeEngine } from './claude.js';
import { CodexEngine } from './codex.js';
import type { Engine } from './types.js';

export type { Engine, EngineCapabilities, EngineRunOptions, EngineRunResult } from './types.js';
export { buildClaudeArgs, claudeAllowedTools, formatClaudeLine, ClaudeEngine } from './claude.js';
export { buildCodexArgs, formatCodexLine, CodexEngine } from './codex.js';
export { buildAgentEnv } from './env.js';

export type EngineRegistry = Record<AgentEngine, Engine>;

export function createEngines(config: Pick<WorkerConfig, 'claudeBin' | 'codexBin'>): EngineRegistry {
  return { claude: new ClaudeEngine(config.claudeBin), codex: new CodexEngine(config.codexBin) };
}

/** e.g. `worker/0.1.1 claude/2.1.0 codex/none` — kept under the server's 50-char limit. */
export async function describeVersion(workerVersion: string, engines: EngineRegistry): Promise<string> {
  const parts = [`worker/${workerVersion}`];
  for (const name of ['claude', 'codex'] as const) {
    const caps = await engines[name].probe();
    parts.push(`${name}/${caps.available ? (caps.version ?? 'yes') : 'none'}`);
  }
  return parts.join(' ').slice(0, 50);
}
